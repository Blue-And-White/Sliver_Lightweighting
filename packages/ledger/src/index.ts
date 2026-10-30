import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AttemptStatus, Autonomy, ChallengeStatus, OracleVerdict, SubmissionStatus } from "@silver/protocol";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  autonomy TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  status TEXT NOT NULL,
  flag_count INTEGER NOT NULL,
  remaining_flags INTEGER NOT NULL,
  solved_by TEXT,
  FOREIGN KEY(mission_id) REFERENCES missions(id)
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL,
  container_id TEXT,
  FOREIGN KEY(challenge_id) REFERENCES challenges(id)
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  submitted_by_member_id TEXT,
  flag_slot INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(challenge_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS oracle_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  oracle TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  challenge_id TEXT,
  attempt_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function now(): string {
  return new Date().toISOString();
}

/** node:sqlite rejects undefined. Missing text becomes an empty string, never a thrown bind error. */
function sqliteText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class Ledger {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
    const submissionColumns = this.db.prepare("PRAGMA table_info(submissions)").all() as Array<{ name: string }>;
    if (!submissionColumns.some((row) => row.name === "submitted_by_member_id")) {
      this.db.exec("ALTER TABLE submissions ADD COLUMN submitted_by_member_id TEXT");
    }
  }

  createMission(id: string, autonomy: Autonomy): void {
    this.db.prepare(
      "INSERT INTO missions(id, status, autonomy, created_at) VALUES (?, 'running', ?, ?)",
    ).run(id, autonomy, now());
  }

  resumeMission(id: string, autonomy: Autonomy): void {
    const row = this.db.prepare("SELECT autonomy FROM missions WHERE id=?").get(id) as
      | { autonomy: Autonomy }
      | undefined;
    if (!row) {
      this.createMission(id, autonomy);
      return;
    }
    if (row.autonomy !== autonomy) throw new Error(`mission ${id} autonomy mismatch`);
  }

  createChallenge(id: string, missionId: string, flagCount: number): void {
    this.db.prepare(
      "INSERT INTO challenges(id, mission_id, status, flag_count, remaining_flags) VALUES (?, ?, 'queued', ?, ?)",
    ).run(id, missionId, flagCount, flagCount);
  }

  resumeChallenge(id: string, missionId: string, flagCount: number): void {
    const row = this.db.prepare(
      "SELECT mission_id, flag_count FROM challenges WHERE id=?",
    ).get(id) as { mission_id: string; flag_count: number } | undefined;
    if (!row) {
      this.createChallenge(id, missionId, flagCount);
      return;
    }
    if (row.mission_id !== missionId || row.flag_count !== flagCount) {
      throw new Error(`challenge ${id} recovery identity mismatch`);
    }
  }

  createAttempt(id: string, challengeId: string, generation: number, containerId?: string): void {
    this.db.prepare(
      "INSERT INTO attempts(id, challenge_id, status, generation, container_id) VALUES (?, ?, 'running', ?, ?)",
    ).run(id, challengeId, generation, containerId ?? null);
    this.db.prepare("UPDATE challenges SET status='running' WHERE id=?").run(challengeId);
  }

  resumeAttempt(id: string, challengeId: string, generation: number, containerId?: string): void {
    const row = this.db.prepare(
      "SELECT challenge_id, generation FROM attempts WHERE id=?",
    ).get(id) as { challenge_id: string; generation: number } | undefined;
    if (!row) {
      this.createAttempt(id, challengeId, generation, containerId);
      return;
    }
    if (row.challenge_id !== challengeId || row.generation !== generation) {
      throw new Error(`attempt ${id} recovery identity mismatch`);
    }
    this.db.prepare("UPDATE attempts SET status='running', container_id=? WHERE id=?").run(containerId ?? null, id);
    this.db.prepare("UPDATE challenges SET status='running' WHERE id=? AND remaining_flags>0").run(challengeId);
  }

  recoverInterruptedSubmissions(challengeId: string): number {
    const result = this.db.prepare(
      "UPDATE submissions SET status='unknown' WHERE challenge_id=? AND status='submitting'",
    ).run(challengeId);
    return Number(result.changes);
  }

  setChallengeStatus(id: string, status: ChallengeStatus): void {
    this.db.prepare("UPDATE challenges SET status=? WHERE id=?").run(status, id);
  }

  /** Reconcile authoritative platform completion without inventing a local submission. */
  settlePlatformCompleted(challengeId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const challenge = this.db.prepare("SELECT mission_id FROM challenges WHERE id=?").get(challengeId) as
        | { mission_id: string }
        | undefined;
      if (!challenge) throw new Error(`unknown challenge ${challengeId}`);
      this.db.prepare("UPDATE challenges SET status='solved', remaining_flags=0 WHERE id=?").run(challengeId);
      this.db.prepare("UPDATE attempts SET status='stopped' WHERE challenge_id=? AND status='running'").run(challengeId);
      this.db.prepare(
        "UPDATE missions SET status='solved' WHERE id=? AND NOT EXISTS (SELECT 1 FROM challenges WHERE mission_id=? AND status!='solved')",
      ).run(challenge.mission_id, challenge.mission_id);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  insertSubmitting(
    challengeId: string,
    attemptId: string,
    fingerprint: string,
    submittedByMemberId?: string,
  ): "ok" | "duplicate" {
    try {
      this.db.prepare(
        "INSERT INTO submissions(challenge_id, attempt_id, fingerprint, submitted_by_member_id, status, created_at) VALUES (?, ?, ?, ?, 'submitting', ?)",
      ).run(challengeId, attemptId, fingerprint, submittedByMemberId ?? null, now());
      return "ok";
    } catch (err) {
      const message = String(err);
      if (message.includes("UNIQUE")) return "duplicate";
      throw err;
    }
  }

  /**
   * Create a recoverable marker for a fingerprint's first in-flight call.
   * Existing rows remain the last completed platform fact while a repeat call
   * is in flight; the append-only outcome journal records every completion.
   */
  beginContestSubmission(
    challengeId: string,
    attemptId: string,
    fingerprint: string,
    submittedByMemberId?: string,
  ): void {
    this.db.prepare(
      `INSERT INTO submissions(
        challenge_id, attempt_id, fingerprint, submitted_by_member_id, status, created_at
      ) VALUES (?, ?, ?, ?, 'submitting', ?)
      ON CONFLICT(challenge_id, fingerprint) DO NOTHING`,
    ).run(challengeId, attemptId, fingerprint, submittedByMemberId ?? null, now());
  }

  finishSubmission(
    challengeId: string,
    fingerprint: string,
    status: Exclude<SubmissionStatus, "submitting" | "duplicate">,
    flagSlot?: number,
  ): void {
    this.db.prepare(
      "UPDATE submissions SET status=?, flag_slot=? WHERE challenge_id=? AND fingerprint=? AND status='submitting'",
    ).run(status, flagSlot ?? null, challengeId, fingerprint);
  }

  markUnknown(challengeId: string, fingerprint: string): void {
    this.db.prepare(
      "UPDATE submissions SET status='unknown' WHERE challenge_id=? AND fingerprint=? AND status='submitting'",
    ).run(challengeId, fingerprint);
  }

  /**
   * Audit row for a contest fingerprint. Does not change remaining_flags.
   * Each explicit adapter completion replaces the latest projection for this fingerprint.
   * The append-only event journal preserves every individual platform response.
   */
  recordContestSubmissionStatus(
    challengeId: string,
    fingerprint: string,
    status: "accepted" | "rejected" | "duplicate" | "unknown",
    completedBy?: { attemptId: string; submittedByMemberId?: string },
  ): void {
    if (completedBy) {
      this.db.prepare(
        `UPDATE submissions
         SET status=?, attempt_id=?, submitted_by_member_id=?, created_at=?
         WHERE challenge_id=? AND fingerprint=?`,
      ).run(
        status,
        completedBy.attemptId,
        completedBy.submittedByMemberId ?? null,
        now(),
        challengeId,
        fingerprint,
      );
      return;
    }
    this.db.prepare(
      "UPDATE submissions SET status=? WHERE challenge_id=? AND fingerprint=?",
    ).run(status, challengeId, fingerprint);
  }

  acceptedCas(challengeId: string, attemptId: string): { won: boolean; remaining: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(
        "UPDATE challenges SET remaining_flags=remaining_flags-1, solved_by=COALESCE(solved_by, ?) WHERE id=? AND remaining_flags>0",
      ).run(attemptId, challengeId);
      const after = this.db.prepare(
        "SELECT remaining_flags FROM challenges WHERE id=?",
      ).get(challengeId) as { remaining_flags: number } | undefined;
      if (!after) throw new Error(`unknown challenge ${challengeId}`);
      if (Number(result.changes) !== 1) {
        this.db.exec("COMMIT");
        return { won: false, remaining: after.remaining_flags };
      }
      if (after.remaining_flags === 0) {
        this.db.prepare("UPDATE challenges SET status='solved' WHERE id=?").run(challengeId);
      }
      this.db.exec("COMMIT");
      return { won: true, remaining: after.remaining_flags };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  attemptExists(id: string): boolean {
    return this.db.prepare("SELECT id FROM attempts WHERE id=?").get(id) !== undefined;
  }

  setAttemptStatus(id: string, status: AttemptStatus): void {
    this.db.prepare("UPDATE attempts SET status=? WHERE id=?").run(status, id);
  }

  attempts(challengeId: string): Array<{ id: string; status: string; generation: number }> {
    return this.db.prepare(
      "SELECT id, status, generation FROM attempts WHERE challenge_id=? ORDER BY generation ASC, id ASC",
    ).all(challengeId) as Array<{ id: string; status: string; generation: number }>;
  }

  recordOracle(input: {
    challengeId: string;
    attemptId: string;
    candidateRef: string;
    fingerprint: string;
    oracle: OracleVerdict;
    reason: string;
    evidenceRef?: string;
  }): void {
    this.db.prepare(
      "INSERT INTO oracle_results(challenge_id, attempt_id, candidate_ref, fingerprint, oracle, reason, evidence_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      sqliteText(input.challengeId),
      sqliteText(input.attemptId),
      sqliteText(input.candidateRef),
      sqliteText(input.fingerprint),
      sqliteText(input.oracle),
      sqliteText(input.reason),
      typeof input.evidenceRef === "string" ? input.evidenceRef : null,
      now(),
    );
  }

  hasOraclePass(challengeId: string, attemptId: string, fingerprint: string): boolean {
    const row = this.db.prepare(
      "SELECT id FROM oracle_results WHERE challenge_id=? AND attempt_id=? AND fingerprint=? AND oracle='pass' LIMIT 1",
    ).get(challengeId, attemptId, fingerprint);
    return row !== undefined;
  }

  appendEvent(kind: string, payload: Record<string, unknown>, ids: { missionId: string; challengeId?: string; attemptId?: string }): void {
    this.db.prepare(
      "INSERT INTO runtime_events(mission_id, challenge_id, attempt_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ids.missionId, ids.challengeId ?? null, ids.attemptId ?? null, kind, JSON.stringify(payload), now());
  }

  listEvents(filter?: { challengeId?: string; kind?: string }): Array<{
    kind: string;
    payload: Record<string, unknown>;
    createdAt: string;
    challengeId?: string;
    attemptId?: string;
  }> {
    const rows = this.db.prepare(
      "SELECT kind, payload, created_at, challenge_id, attempt_id FROM runtime_events WHERE (? IS NULL OR challenge_id=?) AND (? IS NULL OR kind=?) ORDER BY id ASC",
    ).all(filter?.challengeId ?? null, filter?.challengeId ?? null, filter?.kind ?? null, filter?.kind ?? null) as Array<{
      kind: string;
      payload: string;
      created_at: string;
      challenge_id: string | null;
      attempt_id: string | null;
    }>;
    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      return {
        kind: row.kind,
        payload,
        createdAt: row.created_at,
        ...(row.challenge_id ? { challengeId: row.challenge_id } : {}),
        ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      };
    });
  }

  missionAutonomy(id: string): Autonomy {
    const row = this.db.prepare("SELECT autonomy FROM missions WHERE id=?").get(id) as { autonomy: Autonomy } | undefined;
    if (!row) throw new Error(`unknown mission ${id}`);
    return row.autonomy;
  }

  challenge(id: string): { remaining_flags: number; status: string; flag_count: number; solved_by: string | null } {
    const row = this.db.prepare(
      "SELECT remaining_flags, status, flag_count, solved_by FROM challenges WHERE id=?",
    ).get(id) as { remaining_flags: number; status: string; flag_count: number; solved_by: string | null } | undefined;
    if (!row) throw new Error(`unknown challenge ${id}`);
    return row;
  }

  submissionByFingerprint(challengeId: string, fingerprint: string): { status: SubmissionStatus; challenge_id: string } | undefined {
    return this.db.prepare(
      "SELECT status, challenge_id FROM submissions WHERE challenge_id=? AND fingerprint=?",
    ).get(challengeId, fingerprint) as { status: SubmissionStatus; challenge_id: string } | undefined;
  }

  listOracleResults(challengeId: string): Array<{
    candidateRef: string;
    fingerprint: string;
    oracle: OracleVerdict;
    evidenceRef: string | null;
  }> {
    return (
      this.db.prepare(
        "SELECT candidate_ref, fingerprint, oracle, evidence_ref FROM oracle_results WHERE challenge_id=? ORDER BY id ASC",
      ).all(challengeId) as Array<{
        candidate_ref: string;
        fingerprint: string;
        oracle: OracleVerdict;
        evidence_ref: string | null;
      }>
    ).map((row) => ({
      candidateRef: row.candidate_ref,
      fingerprint: row.fingerprint,
      oracle: row.oracle,
      evidenceRef: row.evidence_ref,
    }));
  }

  listSubmissions(challengeId: string): Array<{
    fingerprint: string;
    status: SubmissionStatus;
    submittedByMemberId?: string;
  }> {
    const rows = this.db.prepare(
      "SELECT fingerprint, status, submitted_by_member_id FROM submissions WHERE challenge_id=? ORDER BY id ASC",
    ).all(challengeId) as Array<{
      fingerprint: string;
      status: SubmissionStatus;
      submitted_by_member_id: string | null;
    }>;
    return rows.map((row) => ({
      fingerprint: row.fingerprint,
      status: row.status,
      ...(row.submitted_by_member_id ? { submittedByMemberId: row.submitted_by_member_id } : {}),
    }));
  }

  latestOracle(attemptId: string): { oracle: OracleVerdict; reason: string; evidence_ref: string | null } | undefined {
    return this.db.prepare(
      "SELECT oracle, reason, evidence_ref FROM oracle_results WHERE attempt_id=? ORDER BY id DESC LIMIT 1",
    ).get(attemptId) as { oracle: OracleVerdict; reason: string; evidence_ref: string | null } | undefined;
  }

  close(): void {
    this.db.close();
  }
}
