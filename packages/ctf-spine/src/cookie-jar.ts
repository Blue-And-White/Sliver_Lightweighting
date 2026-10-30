/** Host-side cookie jar. Values never appear on the model-visible HTTP surface. */
export class CookieJar {
  private readonly byOrigin = new Map<string, Map<string, string>>();

  ingest(url: string, setCookieHeaders: string[]): void {
    const origin = originOf(url);
    if (!origin) return;
    let jar = this.byOrigin.get(origin);
    if (!jar) {
      jar = new Map();
      this.byOrigin.set(origin, jar);
    }
    for (const header of setCookieHeaders) {
      const parsed = parseSetCookie(header);
      if (parsed) jar.set(parsed.name, parsed.value);
    }
  }

  headerFor(url: string): string | undefined {
    const origin = originOf(url);
    if (!origin) return undefined;
    const jar = this.byOrigin.get(origin);
    if (!jar || jar.size === 0) return undefined;
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  size(url?: string): number {
    if (!url) return [...this.byOrigin.values()].reduce((n, jar) => n + jar.size, 0);
    return this.byOrigin.get(originOf(url) ?? "")?.size ?? 0;
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function parseSetCookie(header: string): { name: string; value: string } | undefined {
  const pair = header.split(";")[0]?.trim() ?? "";
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name || /^(expires|path|domain|secure|httponly|samesite|max-age)$/i.test(name)) return undefined;
  return { name, value };
}
