/**
 * TEST-ONLY ctx.web providers for local HTTP product scenes.
 * Official web_search / web_fetch still execute; these backends are not the
 * public DeepSeek search API or dsh-web-fetch-http SSRF policy.
 */
export const name = "silver-live-web-local";
export const inject = ["web"] as const;

export const TEST_SEARCH_PROVIDER_ID = "silver-test-search";
export const TEST_FETCH_PROVIDER_ID = "silver-test-fetch";
const FETCH_MAX_CHARS = 200_000;

interface SearchHit {
  url: string;
  title?: string;
  snippet?: string;
}

interface LiveWebLocalContext {
  web: {
    registerSearchProvider(provider: {
      id: string;
      available(): boolean;
      search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<{
        sources: SearchHit[];
        truncated: boolean;
      }>;
    }): () => void;
    registerFetchProvider(provider: {
      id: string;
      available(): boolean;
      fetch(request: { url: string }, signal?: AbortSignal): Promise<{
        url: string;
        statusCode: number;
        body: { kind: "html" | "text"; content: string };
        truncated: boolean;
      }>;
    }): () => void;
  };
}

export function apply(ctx: LiveWebLocalContext): void {
  const hits = parseSearchHits(process.env.SILVER_TEST_ONLY_WEB_SEARCH_HITS);
  ctx.web.registerSearchProvider({
    id: TEST_SEARCH_PROVIDER_ID,
    available: () => true,
    search: async (request) => {
      const q = request.query.toLowerCase();
      const matched = hits.filter(
        (hit) =>
          !q ||
          hit.url.toLowerCase().includes(q) ||
          (hit.title ?? "").toLowerCase().includes(q) ||
          (hit.snippet ?? "").toLowerCase().includes(q),
      );
      const sources = (matched.length > 0 ? matched : hits).slice(0, request.maxResults ?? hits.length);
      return { sources, truncated: false };
    },
  });
  ctx.web.registerFetchProvider({
    id: TEST_FETCH_PROVIDER_ID,
    available: () => true,
    fetch: async (request, signal) => fetchLocal(request.url, signal),
  });
}

function parseSearchHits(raw: string | undefined): SearchHit[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const rec = row as { url?: unknown; title?: unknown; snippet?: unknown };
      if (typeof rec.url !== "string" || !rec.url) return [];
      return [
        {
          url: rec.url,
          ...(typeof rec.title === "string" ? { title: rec.title } : {}),
          ...(typeof rec.snippet === "string" ? { snippet: rec.snippet } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

async function fetchLocal(
  url: string,
  signal?: AbortSignal,
): Promise<{
  url: string;
  statusCode: number;
  body: { kind: "html" | "text"; content: string };
  truncated: boolean;
}> {
  const response = await fetch(url, signal ? { redirect: "follow", signal } : { redirect: "follow" });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const truncated = text.length > FETCH_MAX_CHARS;
  return {
    url: response.url || url,
    statusCode: response.status,
    body: {
      kind: contentType.includes("html") ? "html" : "text",
      content: truncated ? text.slice(0, FETCH_MAX_CHARS) : text,
    },
    truncated,
  };
}
