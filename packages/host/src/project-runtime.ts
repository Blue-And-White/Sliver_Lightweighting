import type { ChallengeBundle } from "./challenge-bundle.ts";

/**
 * In-flight Project/Group control-plane snapshot. Host-owned; not a DSH session.
 * stopEpoch is the close generation: incremented once on the first close(), then
 * consumed so a later close of the same generation does not re-run stop-all.
 */

export const PROJECT_RUNTIME_SCHEMA = "silver.project-runtime.v1" as const;

export type ProjectRuntimeStatus = "active" | "reviewing" | "interrupted" | "stalled" | "ended" | "closed";

export type ProjectGroupSnapshot = {
  groupId: string;
  sessionId?: string;
  stalled?: boolean;
};

export type ProjectSnapshot = {
  schema?: typeof PROJECT_RUNTIME_SCHEMA;
  challengeId: string;
  targetUrl: string;
  status: ProjectRuntimeStatus;
  stopEpoch: number;
  groups: ProjectGroupSnapshot[];
  stalledGroupIds: string[];
  bundle?: ChallengeBundle;
};

export class ProjectRuntime {
  private readonly projects = new Map<string, ProjectSnapshot>();

  restore(rows: readonly ProjectSnapshot[]): void {
    this.projects.clear();
    for (const row of rows) {
      if (!row.challengeId || !row.targetUrl) continue;
      this.projects.set(row.challengeId, {
        schema: PROJECT_RUNTIME_SCHEMA,
        challengeId: row.challengeId,
        targetUrl: row.targetUrl,
        status: row.status,
        stopEpoch: Number.isInteger(row.stopEpoch) ? row.stopEpoch : 0,
        groups: (row.groups ?? []).map((group) => ({ ...group })),
        stalledGroupIds: [...(row.stalledGroupIds ?? [])],
        ...(row.bundle ? { bundle: row.bundle } : {}),
      });
    }
  }

  snapshot(): ProjectSnapshot[] {
    return [...this.projects.values()].map((row) => ({
      schema: PROJECT_RUNTIME_SCHEMA,
      challengeId: row.challengeId,
      targetUrl: row.targetUrl,
      status: row.status,
      stopEpoch: row.stopEpoch,
      groups: row.groups.map((group) => ({ ...group })),
      stalledGroupIds: row.groups.filter((group) => group.stalled).map((group) => group.groupId),
      ...(row.bundle ? { bundle: row.bundle } : {}),
    }));
  }

  open(input: { challengeId: string; targetUrl: string; bundle?: ProjectSnapshot["bundle"] }): ProjectSnapshot {
    const existing = this.projects.get(input.challengeId);
    if (existing && (existing.status === "active" || existing.status === "reviewing" || existing.status === "interrupted")) {
      existing.targetUrl = input.targetUrl;
      if (input.bundle) existing.bundle = input.bundle;
      if (existing.status === "interrupted") existing.status = "active";
      return existing;
    }
    const created: ProjectSnapshot = {
      schema: PROJECT_RUNTIME_SCHEMA,
      challengeId: input.challengeId,
      targetUrl: input.targetUrl,
      status: "active",
      stopEpoch: existing?.stopEpoch ?? 0,
      groups: (existing?.groups ?? []).map((group) => ({
        groupId: group.groupId,
        ...(group.sessionId ? { sessionId: group.sessionId } : {}),
      })),
      stalledGroupIds: [],
      ...(input.bundle ? { bundle: input.bundle } : existing?.bundle ? { bundle: existing.bundle } : {}),
    };
    this.projects.set(input.challengeId, created);
    return created;
  }

  noteGroupSession(challengeId: string, groupId: string, sessionId: string): void {
    const project = this.requireOpen(challengeId);
    if (!project) return;
    const existing = project.groups.find((row) => row.groupId === groupId);
    if (existing) existing.sessionId = sessionId;
    else project.groups.push({ groupId, sessionId });
  }

  noteReviewing(challengeId: string): void {
    const project = this.projects.get(challengeId);
    if (!project || project.status === "closed" || project.status === "ended") return;
    project.status = "reviewing";
  }

  noteReviewReleased(challengeId: string): void {
    const project = this.projects.get(challengeId);
    if (!project || project.status !== "reviewing") return;
    project.status = "active";
  }

  noteGroupStall(challengeId: string, groupId: string): void {
    const project = this.requireOpen(challengeId);
    if (!project) return;
    const existing = project.groups.find((row) => row.groupId === groupId);
    if (existing) existing.stalled = true;
    else project.groups.push({ groupId, stalled: true });
  }

  /** All Group roots went idle. Releases the execution slot; not a platform win. */
  noteAllGroupsStalled(challengeId: string): void {
    const project = this.projects.get(challengeId);
    if (!project || project.status === "closed" || project.status === "ended" || project.status === "reviewing") return;
    project.status = "stalled";
  }

  /** Worker process ended without an operator interrupt. Not in-flight for resume. */
  noteWorkerEnded(challengeId: string): void {
    const project = this.projects.get(challengeId);
    if (!project || project.status === "closed" || project.status === "stalled" || project.status === "reviewing") return;
    project.status = "ended";
  }

  close(challengeId: string): { applied: boolean; stopEpoch: number } {
    const project = this.projects.get(challengeId);
    if (!project) return { applied: false, stopEpoch: 0 };
    if (project.status === "closed") return { applied: false, stopEpoch: project.stopEpoch };
    project.status = "closed";
    project.stopEpoch += 1;
    return { applied: true, stopEpoch: project.stopEpoch };
  }

  /**
   * Align in-memory project to a durable stopEpoch without bumping past it.
   * Fails closed if the project is missing or runtime stopEpoch diverges above the journal.
   */
  ensureClosedAt(challengeId: string, stopEpoch: number): { stopEpoch: number } {
    if (!Number.isInteger(stopEpoch) || stopEpoch < 1) {
      throw new Error(`ensureClosedAt: invalid durable stopEpoch=${stopEpoch} for ${challengeId}`);
    }
    const project = this.projects.get(challengeId);
    if (!project) {
      throw new Error(`ensureClosedAt: project missing for ${challengeId}`);
    }
    if (project.stopEpoch > stopEpoch) {
      throw new Error(
        `ensureClosedAt: runtime stopEpoch ${project.stopEpoch} > durable stopEpoch ${stopEpoch} for ${challengeId}`,
      );
    }
    project.status = "closed";
    if (project.stopEpoch < stopEpoch) project.stopEpoch = stopEpoch;
    if (project.stopEpoch !== stopEpoch) {
      throw new Error(
        `ensureClosedAt: stopEpoch mismatch runtime=${project.stopEpoch} durable=${stopEpoch} for ${challengeId}`,
      );
    }
    return { stopEpoch: project.stopEpoch };
  }

  interrupt(challengeId?: string): void {
    const rows = challengeId ? [this.projects.get(challengeId)] : [...this.projects.values()];
    for (const project of rows) {
      if (!project) continue;
      if (project.status === "active") project.status = "interrupted";
    }
  }

  inFlight(): ProjectSnapshot[] {
    return this.snapshot().filter(
      (row) => row.status === "active" || row.status === "reviewing" || row.status === "interrupted",
    );
  }

  private requireOpen(challengeId: string): ProjectSnapshot | undefined {
    const project = this.projects.get(challengeId);
    if (!project || project.status === "closed" || project.status === "ended" || project.status === "stalled") {
      return undefined;
    }
    return project;
  }
}
