import type { ChallengeRuntime } from "@silver/host";

type TechnicalProgressRuntime = Pick<ChallengeRuntime, "progressFor">;

/** Keep artifact/tool-output interpretation off the Official Team Host control path. */
export function technicalProgressForLiveRun(input: {
  officialTeamMode: boolean;
  runtime: TechnicalProgressRuntime;
  challengeId: string;
  attemptId?: string;
}): ReturnType<ChallengeRuntime["progressFor"]> | undefined {
  if (input.officialTeamMode) return undefined;
  return input.runtime.progressFor(input.challengeId, input.attemptId);
}
