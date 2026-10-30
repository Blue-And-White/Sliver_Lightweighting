import type { AwdMoveKind, CandidateRef, DirtyKind, ImplantDurability, OperatorDecision } from "@silver/protocol";

export interface AwdImplantSpec {
  stealth: boolean;
  token: string;
  channel?: string;
  durability?: ImplantDurability;
}

export interface OperatorMove {
  moveId: string;
  challengeId: string;
  attemptId: string;
  kind: AwdMoveKind;
  summary: string;
  status: "pending" | "rejected" | "applied";
  createdAt: string;
  resolvedAt?: string;
  note?: string;
  fingerprint?: string;
  candidate?: CandidateRef;
  submittedByMemberId?: string;
  implant?: AwdImplantSpec;
  honeypot?: string;
  dirty?: DirtyKind;
}

export type OperatorMoveView = Pick<
  OperatorMove,
  "moveId" | "challengeId" | "attemptId" | "kind" | "summary" | "status" | "createdAt" | "resolvedAt" | "note"
>;

export class OperatorInbox {
  private readonly byChallenge = new Map<string, OperatorMove[]>();
  private seq = 0;

  enqueue(input: Omit<OperatorMove, "moveId" | "status" | "createdAt"> & { status?: OperatorMove["status"] }): OperatorMove {
    const move: OperatorMove = {
      ...input,
      moveId: `m${this.seq}`,
      status: input.status ?? "pending",
      createdAt: new Date().toISOString(),
    };
    this.seq += 1;
    const list = this.byChallenge.get(input.challengeId) ?? [];
    list.push(move);
    this.byChallenge.set(input.challengeId, list);
    return move;
  }

  get(challengeId: string, moveId: string): OperatorMove | undefined {
    return this.byChallenge.get(challengeId)?.find((row) => row.moveId === moveId);
  }

  pending(challengeId: string): OperatorMove[] {
    return (this.byChallenge.get(challengeId) ?? []).filter((row) => row.status === "pending");
  }

  view(challengeId: string): OperatorMoveView[] {
    return (this.byChallenge.get(challengeId) ?? []).map(toView);
  }

  resolve(move: OperatorMove, decision: OperatorDecision, note?: string): void {
    move.status = decision === "approve" ? "applied" : "rejected";
    move.resolvedAt = new Date().toISOString();
    if (note) move.note = note;
  }
}

function toView(move: OperatorMove): OperatorMoveView {
  const row: OperatorMoveView = {
    moveId: move.moveId,
    challengeId: move.challengeId,
    attemptId: move.attemptId,
    kind: move.kind,
    summary: move.summary,
    status: move.status,
    createdAt: move.createdAt,
  };
  if (move.resolvedAt) row.resolvedAt = move.resolvedAt;
  if (move.note) row.note = move.note;
  return row;
}
