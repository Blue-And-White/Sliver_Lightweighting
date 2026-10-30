import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const ROOM_GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS room_graph_nodes (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  swarm_id TEXT NOT NULL,
  graph TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  evidence TEXT,
  authority TEXT,
  owner TEXT NOT NULL,
  turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS room_graph_nodes_scope_updated
  ON room_graph_nodes(room_id, swarm_id, graph, updated_at DESC);
CREATE INDEX IF NOT EXISTS room_graph_nodes_scope_turn
  ON room_graph_nodes(room_id, swarm_id, turn_id);
CREATE TABLE IF NOT EXISTS room_graph_edges (
  room_id TEXT NOT NULL,
  swarm_id TEXT NOT NULL,
  src_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(room_id, swarm_id, src_id, relation, dst_id)
);
CREATE INDEX IF NOT EXISTS room_graph_edges_scope_src
  ON room_graph_edges(room_id, swarm_id, src_id);
CREATE INDEX IF NOT EXISTS room_graph_edges_scope_dst
  ON room_graph_edges(room_id, swarm_id, dst_id);
`;

const HIGH_SIGNAL_INTEL_KINDS = [
  "credential",
  "identity",
  "hint",
  "capability",
  "vulnerability",
  "foothold",
  "shell",
  "webshell",
  "tunnel",
  "pivot",
  "environment_reset",
];

const TERMINAL_INTENT_STATES = [
  "complete",
  "completed",
  "done",
  "blocked",
  "cancelled",
  "canceled",
  "failed",
  "rejected",
  "closed",
  "superseded",
  "abandoned",
];

export type RoomGraphName = "intel" | "exploration";

export type RoomGraphNode = {
  id: string;
  graph: RoomGraphName;
  kind: string;
  state: string;
  summary: string;
  detail?: string;
  evidence?: unknown;
  authority?: string;
  owner: string;
  turnId?: string;
  createdAt: string;
  updatedAt: string;
};

export type RoomGraphLink = {
  nodeId: string;
  relation: string;
  direction?: "from" | "to";
};

export type RoomGraphWriteInput = {
  nodeId?: string;
  kind?: string;
  state?: string;
  summary?: string;
  detail?: string;
  evidence?: unknown;
  authority?: string;
  turnId?: string;
  links?: RoomGraphLink[];
};

type RoomGraphRow = {
  id: string;
  graph: string;
  kind: string;
  state: string;
  summary: string;
  detail: string | null;
  evidence: string | null;
  authority: string | null;
  owner: string;
  turn_id: string | null;
  created_at: string;
  updated_at: string;
};

type RoomGraphEdgeRow = {
  src_id: string;
  relation: string;
  dst_id: string;
  created_at: string;
};

function now(): string {
  return new Date().toISOString();
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveLimit(value: unknown, fallback: number, maximum = 200): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function nonNegativeOffset(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

function parseEvidence(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function projectNode(row: RoomGraphRow): RoomGraphNode {
  return {
    id: row.id,
    graph: row.graph === "intel" ? "intel" : "exploration",
    kind: row.kind,
    state: row.state,
    summary: row.summary,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.evidence ? { evidence: parseEvidence(row.evidence) } : {}),
    ...(row.authority ? { authority: row.authority } : {}),
    owner: row.owner,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectEdge(row: RoomGraphEdgeRow): Record<string, string> {
  return {
    from: row.src_id,
    relation: row.relation,
    to: row.dst_id,
    createdAt: row.created_at,
  };
}

/**
 * Room-scoped dual graph. The Runtime stores model-authored semantics and
 * mechanically projects them; it never infers routes, vulnerabilities, or
 * platform meaning from prose.
 */
export class RoomGraphStore {
  private readonly db: DatabaseSync;
  readonly roomId: string;
  readonly swarmId: string;

  constructor(
    db: DatabaseSync,
    roomId: string,
    swarmId: string,
  ) {
    this.db = db;
    this.roomId = roomId;
    this.swarmId = swarmId;
    db.exec(ROOM_GRAPH_SCHEMA);
  }

  ensureGoal(summary: string, detail?: string): RoomGraphNode {
    const existing = this.db.prepare(
      `SELECT * FROM room_graph_nodes
       WHERE room_id=? AND swarm_id=? AND graph='exploration' AND kind='goal'
       ORDER BY created_at ASC LIMIT 1`,
    ).get(this.roomId, this.swarmId) as RoomGraphRow | undefined;
    if (existing) {
      const nextDetail = detail?.trim() || null;
      if (existing.summary !== summary || existing.detail !== nextDetail) {
        const updatedAt = now();
        this.db.prepare(
          `UPDATE room_graph_nodes
           SET summary=?, detail=?, authority='mission', updated_at=?
           WHERE id=? AND room_id=? AND swarm_id=?`,
        ).run(summary, nextDetail, updatedAt, existing.id, this.roomId, this.swarmId);
        return projectNode({ ...existing, summary, detail: nextDetail, authority: "mission", updated_at: updatedAt });
      }
      return projectNode(existing);
    }
    return this.write("exploration", "runtime", {
      kind: "goal",
      state: "open",
      summary,
      ...(detail ? { detail } : {}),
      authority: "mission",
    }).node;
  }

  write(
    graph: RoomGraphName,
    owner: string,
    input: RoomGraphWriteInput,
  ): { node: RoomGraphNode; linksAdded: number; ignoredLinks: number } {
    const nodeId = text(input.nodeId);
    const stamp = now();
    let row: RoomGraphRow | undefined;
    if (nodeId) {
      row = this.db.prepare(
        `SELECT * FROM room_graph_nodes WHERE room_id=? AND swarm_id=? AND graph=? AND id=?`,
      ).get(this.roomId, this.swarmId, graph, nodeId) as RoomGraphRow | undefined;
      if (!row) throw new Error(`room graph node not found: ${nodeId}`);
      const kind = text(input.kind) || row.kind;
      const state = text(input.state) || row.state;
      const summary = text(input.summary) || row.summary;
      const detail = input.detail === undefined ? row.detail : text(input.detail) || null;
      const evidence = input.evidence === undefined ? row.evidence : JSON.stringify(input.evidence);
      const authority = input.authority === undefined ? row.authority : text(input.authority) || null;
      const turnId = input.turnId === undefined ? row.turn_id : text(input.turnId) || null;
      this.db.prepare(
        `UPDATE room_graph_nodes
         SET kind=?, state=?, summary=?, detail=?, evidence=?, authority=?, turn_id=?, updated_at=?
         WHERE room_id=? AND swarm_id=? AND graph=? AND id=?`,
      ).run(
        kind,
        state,
        summary,
        detail,
        evidence,
        authority,
        turnId,
        stamp,
        this.roomId,
        this.swarmId,
        graph,
        nodeId,
      );
    } else {
      const kind = text(input.kind);
      const summary = text(input.summary);
      if (!kind || !summary) throw new Error("kind and summary are required for a new graph node");
      const id = randomUUID();
      this.db.prepare(
        `INSERT INTO room_graph_nodes(
          id, room_id, swarm_id, graph, kind, state, summary, detail, evidence,
          authority, owner, turn_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        this.roomId,
        this.swarmId,
        graph,
        kind,
        text(input.state) || (kind === "intent" ? "exploring" : "observed"),
        summary,
        text(input.detail) || null,
        input.evidence === undefined ? null : JSON.stringify(input.evidence),
        text(input.authority) || null,
        owner,
        text(input.turnId) || null,
        stamp,
        stamp,
      );
      row = this.db.prepare("SELECT * FROM room_graph_nodes WHERE id=?").get(id) as RoomGraphRow;
    }
    const finalRow = this.db.prepare("SELECT * FROM room_graph_nodes WHERE id=?").get(nodeId || row!.id) as RoomGraphRow;
    const links = Array.isArray(input.links) ? input.links : [];
    let linksAdded = 0;
    let ignoredLinks = 0;
    for (const link of links) {
      const otherId = text(link?.nodeId);
      const relation = text(link?.relation);
      if (!otherId || !relation || !this.hasNode(otherId)) {
        ignoredLinks += 1;
        continue;
      }
      const from = link.direction === "to" ? otherId : finalRow.id;
      const to = link.direction === "to" ? finalRow.id : otherId;
      const changed = this.db.prepare(
        `INSERT OR IGNORE INTO room_graph_edges(room_id, swarm_id, src_id, relation, dst_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(this.roomId, this.swarmId, from, relation, to, stamp).changes;
      linksAdded += Number(changed);
    }
    return { node: projectNode(finalRow), linksAdded, ignoredLinks };
  }

  query(input: Record<string, unknown> = {}): {
    nodes: RoomGraphNode[];
    edges: Record<string, string>[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  } {
    const clauses = ["room_id=?", "swarm_id=?"];
    const values: Array<string | number> = [this.roomId, this.swarmId];
    const graph = text(input.graph);
    if (graph === "intel" || graph === "exploration") {
      clauses.push("graph=?");
      values.push(graph);
    }
    const kinds = stringList(input.kinds ?? input.kind);
    if (kinds.length) {
      clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      values.push(...kinds);
    }
    const states = stringList(input.states ?? input.state);
    if (states.length) {
      clauses.push(`state IN (${states.map(() => "?").join(",")})`);
      values.push(...states);
    }
    const ids = stringList(input.nodeIds ?? input.nodeId);
    if (ids.length) {
      clauses.push(`id IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }
    const turnId = text(input.turnId);
    if (turnId) {
      clauses.push("turn_id=?");
      values.push(turnId);
    }
    const query = text(input.query).toLowerCase();
    if (query) {
      clauses.push("(lower(summary) LIKE ? OR lower(COALESCE(detail, '')) LIKE ? OR lower(kind) LIKE ?)");
      const needle = `%${query}%`;
      values.push(needle, needle, needle);
    }
    const limit = positiveLimit(input.limit, 50);
    const offset = nonNegativeOffset(input.offset);
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS count FROM room_graph_nodes WHERE ${clauses.join(" AND ")}`,
    ).get(...values) as { count: number };
    values.push(limit, offset);
    const rows = this.db.prepare(
      `SELECT * FROM room_graph_nodes WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ).all(...values) as RoomGraphRow[];
    const total = Number(totalRow.count);
    return {
      nodes: rows.map(projectNode),
      edges: this.edgesFor(rows.map((row) => row.id)),
      total,
      offset,
      limit,
      hasMore: offset + rows.length < total,
    };
  }

  overview(): Record<string, unknown> {
    const goals = this.selectRecent("exploration", ["goal"], 8);
    const receipts = this.selectRecent("exploration", ["receipt"], 16);
    const activeIntents = this.selectActiveIntents(16);
    const alreadyProjected = new Set(
      [...goals, ...receipts, ...activeIntents].map((node) => node.id),
    );
    const recentExploration = this.selectRecent("exploration", [], 48)
      .filter((node) => !alreadyProjected.has(node.id))
      .slice(0, 24);
    const highSignalIntel = this.selectRecent("intel", HIGH_SIGNAL_INTEL_KINDS, 16);
    const projectedIntel = new Set(highSignalIntel.map((node) => node.id));
    const recentIntel = this.selectRecent("intel", [], 40)
      .filter((node) => !projectedIntel.has(node.id))
      .slice(0, 24);
    const counts = this.db.prepare(
      `SELECT graph, kind, state, COUNT(*) AS count
       FROM room_graph_nodes WHERE room_id=? AND swarm_id=?
       GROUP BY graph, kind, state ORDER BY graph, kind, state`,
    ).all(this.roomId, this.swarmId) as Array<{ graph: string; kind: string; state: string; count: number }>;
    const visible = [
      ...goals,
      ...receipts,
      ...activeIntents,
      ...highSignalIntel,
      ...recentIntel,
      ...recentExploration,
    ];
    return {
      goals,
      receipts,
      highSignalIntel,
      activeIntents,
      roomId: this.roomId,
      swarmId: this.swarmId,
      missionRef: "mission-brief.md",
      recentExploration,
      recentIntel,
      counts,
      edges: this.edgesFor([...new Set(visible.map((node) => node.id))]),
    };
  }

  snapshot(): Record<string, unknown> {
    const rows = this.db.prepare(
      `SELECT * FROM room_graph_nodes WHERE room_id=? AND swarm_id=? ORDER BY created_at ASC`,
    ).all(this.roomId, this.swarmId) as RoomGraphRow[];
    const edges = this.db.prepare(
      `SELECT src_id, relation, dst_id, created_at FROM room_graph_edges
       WHERE room_id=? AND swarm_id=? ORDER BY created_at ASC`,
    ).all(this.roomId, this.swarmId) as RoomGraphEdgeRow[];
    return { roomId: this.roomId, swarmId: this.swarmId, nodes: rows.map(projectNode), edges: edges.map(projectEdge) };
  }

  hasTurnIntent(turnId: string): boolean {
    if (!turnId.trim()) return false;
    return Boolean(this.db.prepare(
      `SELECT 1 FROM room_graph_nodes
       WHERE room_id=? AND swarm_id=? AND graph='exploration' AND kind='intent' AND turn_id=? LIMIT 1`,
    ).get(this.roomId, this.swarmId, turnId));
  }

  abandonActiveIntent(turnId: string): number {
    const normalized = turnId.trim();
    if (!normalized) return 0;
    return Number(this.db.prepare(
      `UPDATE room_graph_nodes SET state='abandoned', updated_at=?
       WHERE room_id=? AND swarm_id=? AND graph='exploration' AND kind='intent' AND turn_id=?
       AND lower(state) NOT IN (${TERMINAL_INTENT_STATES.map(() => "?").join(",")})`,
    ).run(now(), this.roomId, this.swarmId, normalized, ...TERMINAL_INTENT_STATES).changes);
  }

  private hasNode(nodeId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM room_graph_nodes WHERE room_id=? AND swarm_id=? AND id=? LIMIT 1",
    ).get(this.roomId, this.swarmId, nodeId));
  }

  private selectRecent(graph: RoomGraphName, kinds: string[], limit: number): RoomGraphNode[] {
    const kindClause = kinds.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(
      `SELECT * FROM room_graph_nodes WHERE room_id=? AND swarm_id=? AND graph=?${kindClause}
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(this.roomId, this.swarmId, graph, ...kinds, limit) as RoomGraphRow[];
    return rows.map(projectNode);
  }

  private selectActiveIntents(limit: number): RoomGraphNode[] {
    const rows = this.db.prepare(
      `SELECT * FROM room_graph_nodes WHERE room_id=? AND swarm_id=? AND graph='exploration'
       AND kind='intent' AND lower(state) NOT IN (${TERMINAL_INTENT_STATES.map(() => "?").join(",")})
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(this.roomId, this.swarmId, ...TERMINAL_INTENT_STATES, limit) as RoomGraphRow[];
    return rows.map(projectNode);
  }

  private edgesFor(ids: string[]): Record<string, string>[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT src_id, relation, dst_id, created_at FROM room_graph_edges
       WHERE room_id=? AND swarm_id=? AND (src_id IN (${placeholders}) OR dst_id IN (${placeholders}))
       ORDER BY created_at ASC`,
    ).all(this.roomId, this.swarmId, ...ids, ...ids) as RoomGraphEdgeRow[];
    return rows.map(projectEdge);
  }

}
