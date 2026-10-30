import fs from "node:fs";
import path from "node:path";
import { OwnershipError } from "./errors.ts";
import { fileOpenNoFollowFlags } from "./fs-safe.ts";
import { CONTAINER_ID_RE } from "./types.ts";

export function cidfilePath(execDir: string, challengeId: string): string {
  const dir = path.join(execDir, ".runtime", "target-cell-containers");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${challengeId}.cid`);
}

export function validateContainerId(containerId: string): string {
  if (!CONTAINER_ID_RE.test(containerId)) {
    throw new OwnershipError("docker create returned an invalid container id");
  }
  return containerId;
}

export function readCidfileContainerId(cidfile: string, execDir: string): string {
  const expectedParent = path.join(execDir, ".runtime", "target-cell-containers");
  if (path.dirname(cidfile) !== expectedParent) {
    throw new OwnershipError("container cidfile escapes execution");
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(cidfile, fileOpenNoFollowFlags());
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128) {
      throw new OwnershipError("container cidfile is not trusted");
    }
    const buf = Buffer.alloc(129);
    const n = fs.readSync(fd, buf, 0, 129, 0);
    if (n > 128) {
      throw new OwnershipError("container cidfile is not trusted");
    }
    const text = buf.subarray(0, n).toString("utf8");
    return validateContainerId(text.trim());
  } catch (err) {
    if (err instanceof OwnershipError) throw err;
    throw new OwnershipError("container cidfile unreadable");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
