export interface OracleAttemptView {
  candidateRef: string;
  oracle: string;
  evidenceRef: string | null;
}

export interface CandidateRecord {
  candidateRef: string;
  fingerprint: string;
  oracle: string;
  evidenceRef: string | null;
  submission?: string;
  oracleAttempts?: OracleAttemptView[];
}

export interface OracleRow {
  candidateRef: string;
  fingerprint: string;
  oracle: string;
  evidenceRef: string | null;
}

/**
 * One terminal row per fingerprint. Submission attaches only after preflight pass.
 * Earlier fail/pass rows stay in oracleAttempts, never mixed with the terminal line.
 */
export function aggregateCandidateRecords(
  oracles: OracleRow[],
  submissions: Array<{ fingerprint: string; status: string }>,
): CandidateRecord[] {
  const submissionByFp = new Map(submissions.map((row) => [row.fingerprint, row.status]));
  const order: string[] = [];
  const groups = new Map<string, OracleRow[]>();
  for (const row of oracles) {
    const existing = groups.get(row.fingerprint);
    if (existing) existing.push(row);
    else {
      order.push(row.fingerprint);
      groups.set(row.fingerprint, [row]);
    }
  }
  return order.map((fingerprint) => {
    const attempts = groups.get(fingerprint) ?? [];
    const pass = lastWhere(attempts, (row) => row.oracle === "pass");
    const last = attempts[attempts.length - 1];
    const terminal = pass ?? last;
    const recorded: CandidateRecord = {
      candidateRef: terminal?.candidateRef ?? "",
      fingerprint,
      oracle: pass ? "pass" : (last?.oracle ?? "fail"),
      evidenceRef: terminal?.evidenceRef ?? null,
    };
    const submission = pass ? submissionByFp.get(fingerprint) : undefined;
    if (submission) recorded.submission = submission;
    if (attempts.length > 1) {
      recorded.oracleAttempts = attempts.map((row) => ({
        candidateRef: row.candidateRef,
        oracle: row.oracle,
        evidenceRef: row.evidenceRef,
      }));
    }
    return recorded;
  });
}

function lastWhere<T>(rows: T[], pred: (row: T) => boolean): T | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row && pred(row)) return row;
  }
  return undefined;
}
