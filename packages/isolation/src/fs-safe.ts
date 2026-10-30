import fs from "node:fs";
import path from "node:path";
import { PathError } from "./errors.ts";
import { TARGET_ID_RE } from "./types.ts";

export function directoryOpenFlags(): number {
  let flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;
  if (typeof fs.constants.O_NOFOLLOW === "number") {
    flags |= fs.constants.O_NOFOLLOW;
  }
  return flags;
}

export function fileOpenNoFollowFlags(): number {
  let flags = fs.constants.O_RDONLY;
  if (typeof fs.constants.O_NOFOLLOW === "number") {
    flags |= fs.constants.O_NOFOLLOW;
  }
  return flags;
}

export function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

export function safeExistingDir(raw: string, label: string): string {
  if (isSymlink(raw)) {
    throw new PathError(`${label} is a symlink`);
  }
  if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) {
    throw new PathError(`${label} is not a directory`);
  }
  return fs.realpathSync(raw);
}

export function safeExistingFile(raw: string, label: string): string {
  if (isSymlink(raw)) {
    throw new PathError(`${label} is a symlink`);
  }
  if (!fs.existsSync(raw) || !fs.statSync(raw).isFile()) {
    throw new PathError(`${label} is not a regular file`);
  }
  return fs.realpathSync(raw);
}

export function safeChallengeDir(execDir: string, challengeId: string): string {
  if (!TARGET_ID_RE.test(challengeId)) {
    throw new PathError("target_id contains unsafe path characters");
  }
  const targetsDir = safeExistingDir(path.join(execDir, "targets"), "targets directory");
  const targetDir = path.join(targetsDir, challengeId);
  if (isSymlink(targetDir) || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw new PathError("target cell directory is not a safe directory");
  }
  const target = fs.realpathSync(targetDir);
  if (!target.startsWith(targetsDir + path.sep)) {
    throw new PathError("target cell directory escapes execution targets");
  }
  const workspace = path.join(target, "workspace");
  if (isSymlink(workspace) || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new PathError("target workspace is not a safe directory");
  }
  const resolvedWorkspace = fs.realpathSync(workspace);
  if (!resolvedWorkspace.startsWith(target + path.sep) && resolvedWorkspace !== target) {
    throw new PathError("target workspace escapes target cell");
  }
  return target;
}

export function ensureChildDir(
  parent: string,
  name: string,
  root: string,
  mode = 0o755,
): string {
  if (path.basename(name) !== name) {
    throw new PathError("container execution path component is unsafe");
  }
  const parentFd = fs.openSync(parent, directoryOpenFlags());
  try {
    try {
      fs.mkdirSync(path.join(parent, name), { mode });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new PathError("container execution directory is unsafe");
      }
    }
    const childFd = fs.openSync(path.join(parent, name), directoryOpenFlags());
    fs.closeSync(childFd);
  } catch (err) {
    if (err instanceof PathError) throw err;
    throw new PathError("container execution directory is unsafe");
  } finally {
    fs.closeSync(parentFd);
  }
  const child = path.join(parent, name);
  const resolved = fs.realpathSync(child);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new PathError("container execution directory escapes target cell");
  }
  return resolved;
}

export function prepareExecutionView(targetDir: string, challengeId: string): string {
  if (isSymlink(targetDir) || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw new PathError("target cell directory is not a safe directory");
  }
  const target = fs.realpathSync(targetDir);
  if (challengeId !== path.basename(target) || !TARGET_ID_RE.test(challengeId)) {
    throw new PathError("target_id contains unsafe path characters");
  }
  const runtimeDir = ensureChildDir(target, ".container-runtime", target);
  const execution = ensureChildDir(runtimeDir, "execution", target);
  const targets = ensureChildDir(execution, "targets", target);
  ensureChildDir(execution, ".secrets", target, 0o700);
  const link = path.join(targets, challengeId);
  if (fs.existsSync(link) || isSymlink(link)) {
    if (
      !isSymlink(link) ||
      fs.readlinkSync(link) !== path.join("..", "..", "..") ||
      fs.realpathSync(link) !== target
    ) {
      throw new PathError("container execution view target is unsafe");
    }
    return execution;
  }
  fs.symlinkSync(path.join("..", "..", ".."), link);
  return execution;
}
