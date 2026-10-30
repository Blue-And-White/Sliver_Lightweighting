/**
 * Host RPC material captured from a private inherited fd and then closed.
 * The closure is the plugin's channel. It is not a model-readable variable.
 */
import fs from "node:fs";

export const HOST_CHANNEL_FD_ENV = "SILVER_HOST_CHANNEL_FD";

let captured = false;
let origin: string | undefined;
let capability: string | undefined;
let submitPath: string | undefined;

export function captureModelUnreadableHostChannel(): void {
  const nextOrigin = process.env.SILVER_HOST_RPC?.trim();
  const legacyCapability = process.env.SILVER_HOST_CAPABILITY?.trim();
  const fdText = process.env[HOST_CHANNEL_FD_ENV]?.trim();
  delete process.env.SILVER_HOST_CAPABILITY;
  delete process.env.SILVER_CONVERGENCE_SUBMIT_PATH;
  delete process.env[HOST_CHANNEL_FD_ENV];
  if (legacyCapability) {
    throw new Error("silver-ctf-spine: Host capability must not be delivered through the process environment");
  }
  if (fdText) {
    const fd = Number(fdText);
    if (!Number.isInteger(fd) || fd < 3) {
      throw new Error("silver-ctf-spine: invalid private Host channel fd");
    }
    let raw = "";
    try {
      raw = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    const parsed = JSON.parse(raw) as { capability?: unknown; submitPath?: unknown };
    const nextCapability = typeof parsed.capability === "string" ? parsed.capability.trim() : "";
    const nextSubmit = typeof parsed.submitPath === "string" ? parsed.submitPath.trim() : "";
    if (nextCapability) capability = nextCapability;
    if (nextSubmit) submitPath = nextSubmit;
  }
  if (nextOrigin) origin = nextOrigin;
  captured = true;
}

/** Test isolation. Production callers use captureModelUnreadableHostChannel. */
export function resetHostChannelForTests(): void {
  captured = false;
  origin = undefined;
  capability = undefined;
  submitPath = undefined;
}

export function hostChannel(): { origin?: string; capability?: string; submitPath?: string } {
  if (!captured) {
    const liveOrigin = process.env.SILVER_HOST_RPC?.trim();
    return {
      ...(liveOrigin ? { origin: liveOrigin } : {}),
    };
  }
  return {
    ...(origin ? { origin } : {}),
    ...(capability ? { capability } : {}),
    ...(submitPath ? { submitPath } : {}),
  };
}
