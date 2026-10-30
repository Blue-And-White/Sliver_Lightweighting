import fs from "node:fs";
import path from "node:path";

export interface SkillCatalogEntry {
  name: string;
  description: string;
  dir: string;
}

export interface LiveSkillPatchOptions {
  catalogDescriptionMaxLength?: number;
}

/** One-level DSH catalog for explicitly configured roots: <root>/<name>/SKILL.md or <root>/<name>.md. Not references/. */
export function listVisibleSkillCatalog(root: string | string[]): SkillCatalogEntry[] {
  const roots = Array.isArray(root) ? root : [root];
  const entries: SkillCatalogEntry[] = [];
  const seenNames = new Set<string>();
  for (const rootDir of roots) {
    if (!fs.existsSync(rootDir)) continue;
    for (const name of fs.readdirSync(rootDir).sort((a, b) => a.localeCompare(b))) {
      const full = path.join(rootDir, name);
      let skillFile: string | undefined;
      let skillName = name;
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          const nested = path.join(full, "SKILL.md");
          if (fs.existsSync(nested)) skillFile = nested;
        } else if (st.isFile() && name.endsWith(".md") && name !== "README.md") {
          skillFile = full;
          skillName = name.replace(/\.md$/i, "");
        }
      } catch {
        continue;
      }
      if (!skillFile) continue;
      const parsed = parseSkillFrontmatter(fs.readFileSync(skillFile, "utf8"));
      if (!parsed) continue;
      const entryName = parsed.name || skillName;
      if (seenNames.has(entryName)) continue;
      seenNames.add(entryName);
      entries.push({ name: entryName, description: parsed.description, dir: path.dirname(skillFile) });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function liveSkillPatchYaml(skillRoot: string | string[], opts: LiveSkillPatchOptions = {}): string {
  const skillRoots = Array.isArray(skillRoot) ? skillRoot : [skillRoot];
  const catalogDescriptionMaxLength = Math.max(3, Math.floor(opts.catalogDescriptionMaxLength ?? 500));
  return [
    "# Optional DSH-native skill roots. Do not inherit ~/.dsh or bundled DSH skills.",
    "- id: skill",
    "  disabled: false",
    "- id: skill-filesystem",
    "  disabled: false",
    "  config:",
    "    includeDefaultRoots: false",
    "    customSkillDirs:",
    ...skillRoots.map((root) => `      - ${JSON.stringify(root)}`),
    "- id: tool-skill",
    "  disabled: false",
    "  config:",
    `    catalogDescriptionMaxLength: ${catalogDescriptionMaxLength}`,
    "",
  ].join("\n");
}

export function mirrorLiveSkillRoots(skillRoot: string | string[], destRoot: string): string[] {
  const roots = Array.isArray(skillRoot) ? skillRoot : [skillRoot];
  const mirrored: string[] = [];
  fs.rmSync(destRoot, { recursive: true, force: true });
  roots.forEach((root, index) => {
    const source = path.resolve(root);
    const st = safeLstat(source);
    if (!st || st.isSymbolicLink()) return;
    const dest = path.join(destRoot, `root-${index}`);
    copyRegularTree(source, dest);
    if (fs.existsSync(dest)) mirrored.push(dest);
  });
  return mirrored;
}

function parseSkillFrontmatter(text: string): { name: string; description: string } | undefined {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const yaml = text.slice(4, end);
  const name = /^name:\s*(.+)$/m.exec(yaml)?.[1]?.trim() ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return undefined;
  const block = /^description:\s*>-\s*\n((?:[ \t]+.+\n)+)/m.exec(yaml + "\n");
  const single = /^description:\s*(.+)$/m.exec(yaml);
  const description = (block ? (block[1] ?? "").replace(/^[ \t]+/gm, " ").replace(/\n/g, " ") : single?.[1] ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!description) return undefined;
  return { name, description };
}

function copyRegularTree(src: string, dest: string): void {
  const st = safeLstat(src);
  if (!st || st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRegularTree(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function safeLstat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}
