/**
 * Project existing workspace materials into the official ACP prompt.
 * Images become ACP `type: "image"` blocks for dsh-attachment-local ingest.
 * PDF/ZIP/other binaries stay ordinary files for read/bash — this is not a
 * generic parse platform.
 */
import fs from "node:fs";
import path from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
} as const;

export const LIVE_MATERIALS_DIR = "materials";

export function adjacentMaterialsDir(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  return path.join(path.dirname(path.resolve(filePath)), LIVE_MATERIALS_DIR);
}

export function seedAdjacentMaterials(dest: string, sources: Array<string | undefined>): string[] {
  const copied: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) continue;
    for (const name of fs.readdirSync(source)) {
      if (name.startsWith(".")) continue;
      const from = path.join(source, name);
      if (!fs.statSync(from).isFile()) continue;
      const rel = path.join(LIVE_MATERIALS_DIR, name);
      if (seen.has(rel)) continue;
      seen.add(rel);
      const to = path.join(dest, rel);
      if (fs.existsSync(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied.push(rel);
    }
  }
  return copied;
}

/**
 * First-import durable copies via official attachment-local.
 * Resume must not call this for already-present workspace files.
 */
export async function persistSeededMaterials(
  dshHome: string,
  dest: string,
  rels: readonly string[],
): Promise<string[]> {
  if (rels.length === 0) return [];
  const { Context } = await import("@deepseek-ai/cordis");
  const { LocalAttachmentStore } = await import("@deepseek-ai/dsh-attachment-local");
  const ctx = new Context();
  const store = new LocalAttachmentStore(ctx, { dshHome });
  const ids: string[] = [];
  for (const rel of rels) {
    const file = path.join(dest, rel);
    const bytes = fs.readFileSync(file);
    const ref = await store.saveFile({
      data: new Uint8Array(bytes),
      name: path.basename(rel),
    });
    ids.push(String(ref.attachmentId));
  }
  return ids;
}

export function liveSessionPrompt(
  task: string,
  cwd: string,
  opts?: { images?: boolean },
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text: task }];
  if (opts?.images === false) return blocks;
  const dir = path.join(cwd, LIVE_MATERIALS_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return blocks;
  for (const name of fs.readdirSync(dir).sort()) {
    const ext = path.extname(name).toLowerCase() as keyof typeof IMAGE_MIME;
    const mime = IMAGE_MIME[ext];
    if (!mime) continue;
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    blocks.push({
      type: "image",
      mimeType: mime,
      data: fs.readFileSync(file).toString("base64"),
    });
  }
  return blocks;
}
