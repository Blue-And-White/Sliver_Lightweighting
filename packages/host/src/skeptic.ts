import type { NotebookEntry } from "@silver/ctf-spine";
import type { IntelViewItem } from "./intel-pool.ts";

export type SkepticKind =
  | "missing_surfaces"
  | "weak_assumptions"
  | "chain_gaps"
  | "cheap_checks"
  | "alternative_lenses";

export interface SkepticQuestion {
  kind: SkepticKind;
  question: string;
}

export interface SkepticReport {
  attemptId: string;
  questions: SkepticQuestion[];
  confidence: "untrusted";
}

const FORBIDDEN =
  /route_dead|do_not_try|verified_not_vulnerable|already solved|dead[- ]path|已证伪|死路|nogood|should be abandoned|highest priority/i;
const TARGET_TOUCH_TOOLS = new Set([
  "room_info",
  "challenge_info",
  "bash",
  "read",
  "grep",
  "glob",
  "read_artifact",
  "grep_artifacts",
  "terminal_open",
]);

export function critique(input: {
  attemptId: string;
  idleCycles: number;
  lastTools: string[];
  notebook: NotebookEntry[];
  intel: IntelViewItem[];
  remainingFlags: number;
}): SkepticReport {
  const questions: SkepticQuestion[] = [];
  if (!input.lastTools.some((tool) => TARGET_TOUCH_TOOLS.has(tool))) {
    questions.push({
      kind: "missing_surfaces",
      question: "Which in-scope URL or binary still has no tool event or artifact locator?",
    });
  }
  const hasObs = input.intel.some((row) => row.kind === "observation" || row.kind === "primitive_signal");
  const hasChain = input.intel.some((row) => row.kind === "candidate_chain");
  if (hasObs && !hasChain) {
    questions.push({
      kind: "chain_gaps",
      question: "There are observations without a candidate_chain. What cheap check would turn an existing locator into a new capability?",
    });
  }
  if (input.notebook.some((row) => row.zone === "local_prune")) {
    questions.push({
      kind: "weak_assumptions",
      question: "A local_prune note is private to this attempt. What one-shot check would reopen that surface instead of treating it as globally closed?",
    });
  }
  if (input.idleCycles >= 2) {
    questions.push({
      kind: "cheap_checks",
      question: "Idle cycles produced no new artifact content. What is the cheapest unused differential (status/length/hash) to record next?",
    });
  }
  questions.push({
    kind: "alternative_lenses",
    question: "If the current lens is wrong, which one other class (web/pwn/crypto/rev) has a single cheap tool you have not run?",
  });
  return {
    attemptId: input.attemptId,
    questions: questions.filter((row) => !FORBIDDEN.test(row.question)),
    confidence: "untrusted",
  };
}

export function reportLooksLikeVerdict(report: SkepticReport): boolean {
  return FORBIDDEN.test(JSON.stringify(report));
}
