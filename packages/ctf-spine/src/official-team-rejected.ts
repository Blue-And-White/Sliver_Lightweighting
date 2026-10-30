import fs from "node:fs";
import path from "node:path";

export const OFFICIAL_TEAM_REJECTED_FINGERPRINTS_SCHEMA =
  "silver.official-team-rejected-fingerprints.v1" as const;

type RejectedFingerprintsFile = {
  schema: typeof OFFICIAL_TEAM_REJECTED_FINGERPRINTS_SCHEMA;
  fingerprints: string[];
};

export function officialTeamRejectedFingerprintsPath(roomClockDir: string): string {
  return path.join(roomClockDir, "official-team-rejected-fingerprints.json");
}

export function writeOfficialTeamRejectedFingerprints(roomClockDir: string, fingerprints: string[]): void {
  const unique = [...new Set(fingerprints.map((row) => row.trim()).filter(Boolean))].sort();
  const next: RejectedFingerprintsFile = {
    schema: OFFICIAL_TEAM_REJECTED_FINGERPRINTS_SCHEMA,
    fingerprints: unique,
  };
  fs.mkdirSync(roomClockDir, { recursive: true });
  const file = officialTeamRejectedFingerprintsPath(roomClockDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function readOfficialTeamRejectedFingerprints(roomClockDir: string): Set<string> {
  const file = officialTeamRejectedFingerprintsPath(roomClockDir);
  if (!fs.existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RejectedFingerprintsFile;
    if (parsed?.schema !== OFFICIAL_TEAM_REJECTED_FINGERPRINTS_SCHEMA || !Array.isArray(parsed.fingerprints)) {
      return new Set();
    }
    return new Set(parsed.fingerprints.map((row) => String(row).trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}
