import { spawnSync } from "node:child_process";

/** First-party Node cell image. Isolation smoke may still use busybox. */
export const SILVER_CELL_IMAGE = "silver-cell:local";

export function dockerImageExists(image: string): boolean {
  const inspect = spawnSync("docker", ["image", "inspect", image], {
    encoding: "utf8",
    timeout: 8000,
  });
  return inspect.status === 0;
}

export function dockerImageHasSilverRuntime(image: string): boolean {
  const inspect = spawnSync("docker", ["image", "inspect", image], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (inspect.status !== 0) return false;
  try {
    const rows = JSON.parse(inspect.stdout) as Array<{ Config?: { Labels?: Record<string, string> | null } }>;
    return rows.some((row) => row.Config?.Labels?.["org.silver.cell-runtime"] === "dsh");
  } catch {
    return false;
  }
}

/** --live worker needs Node. Never fall back to busybox. */
export function resolveCellImage(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SILVER_CELL_IMAGE) {
    if (!dockerImageHasSilverRuntime(env.SILVER_CELL_IMAGE)) {
      throw new Error(
        `SILVER_CELL_IMAGE must reference a local Silver DSH runtime image; run npm run cell:image or use an image labeled org.silver.cell-runtime=dsh`,
      );
    }
    return env.SILVER_CELL_IMAGE;
  }
  if (dockerImageHasSilverRuntime(SILVER_CELL_IMAGE)) return SILVER_CELL_IMAGE;
  if (dockerImageExists(SILVER_CELL_IMAGE)) {
    throw new Error(`${SILVER_CELL_IMAGE} is not a Silver DSH runtime image; rebuild it with npm run cell:image`);
  }
  return SILVER_CELL_IMAGE;
}

/** Present Node cell image, or undefined so tests can skipIf instead of pulling. */
export function resolveExistingCellImage(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SILVER_CELL_IMAGE) {
    return dockerImageHasSilverRuntime(env.SILVER_CELL_IMAGE) ? env.SILVER_CELL_IMAGE : undefined;
  }
  if (dockerImageHasSilverRuntime(SILVER_CELL_IMAGE)) return SILVER_CELL_IMAGE;
  return undefined;
}
