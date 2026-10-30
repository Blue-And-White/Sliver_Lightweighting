import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ContestBoardRow, ContestChallengeContent, ContestSubmitVerdict } from "@silver/host";
import type { MissionBrief } from "./mission.ts";

export interface ContestAdapterIdentity {
  modulePath: string;
  contentSha256: string;
}

type ContestAdapterModule = {
  createContestAdapter?: (context: {
    mission: Pick<MissionBrief, "title" | "target" | "inScope" | "body">;
  }) => ContestCapabilityAdapter | Promise<ContestCapabilityAdapter>;
};

export interface ContestCapabilityAdapter {
  /** list().isCompleted is fresh platform authority for every eligible challenge. */
  boardCompletionAuthoritative?: boolean;
  list?(): Promise<ContestBoardRow[]>;
  start?(boardId: string): Promise<{ boardId: string; containerAddr: string[] } & ContestChallengeContent>;
  verify?(boardId: string, raw: string): Promise<Record<string, unknown>>;
  submit?(boardId: string, flag: string): Promise<ContestSubmitVerdict>;
  close?(boardId: string, options?: { signal: AbortSignal }): Promise<void>;
  requestHint?(boardId: string): Promise<{ ok: true; hint: string } | { ok: false; error: string }>;
}

export function contestAdapterIdentity(modulePath: string): ContestAdapterIdentity {
  const resolved = path.resolve(modulePath);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`contest adapter module is not a file: ${resolved}`);
  }
  return {
    modulePath: resolved,
    contentSha256: createHash("sha256").update(fs.readFileSync(resolved)).digest("hex"),
  };
}

export async function loadContestAdapter(input: {
  modulePath: string;
  mission: MissionBrief;
}): Promise<ContestCapabilityAdapter> {
  const { modulePath } = contestAdapterIdentity(input.modulePath);
  const loaded = (await import(pathToFileURL(modulePath).href)) as ContestAdapterModule;
  if (typeof loaded.createContestAdapter !== "function") {
    throw new Error("contest adapter module must export createContestAdapter(context)");
  }
  const adapter = await loaded.createContestAdapter({
    mission: {
      title: input.mission.title,
      target: input.mission.target,
      inScope: [...input.mission.inScope],
      body: input.mission.body,
    },
  });
  if (!adapter || typeof adapter !== "object") {
    throw new Error("contest adapter factory returned no adapter");
  }
  if (adapter.boardCompletionAuthoritative !== undefined && typeof adapter.boardCompletionAuthoritative !== "boolean") {
    throw new Error("contest adapter boardCompletionAuthoritative must be a boolean when provided");
  }
  const methods = ["list", "start", "verify", "submit", "close", "requestHint"] as const;
  for (const method of methods) {
    if (adapter[method] !== undefined && typeof adapter[method] !== "function") {
      throw new Error(`contest adapter ${method} must be a function when provided`);
    }
  }
  if (!methods.some((method) => typeof adapter[method] === "function")) {
    throw new Error("contest adapter must provide list(), start(), verify(), submit(), close(), or requestHint()");
  }
  return adapter;
}
