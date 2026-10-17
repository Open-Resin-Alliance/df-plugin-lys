import type { LysData, LysSupport, LysSupportSettings, LysVector } from './types';

/**
 * The authored support graph.
 *
 * LYS states its topology: `parentBaseId` names the support hosting this
 * support's BASE end, `parentTipId` the one hosting its TIP end. Both are ids
 * with no parameter — the attachment POINT is this support's own authored
 * endpoint. This module reads exactly that and nothing more: no projection, no
 * geometry inference, no thresholds.
 *
 * Endpoint coincidence is deliberately NOT a relation here. In the corpus it is
 * mostly base-base pairs of separate supports standing on the plate at the same
 * spot, and tip-tip fan-in at the model surface; treating it as a shared node
 * would fuse unrelated supports (see REBUILD_SCOPE.md §2).
 */

/** Which end of a child attaches to a host. */
export type HostEnd = 'base' | 'tip';

/** One authored support, normalised. Frame and geometry decisions belong to the emitter. */
export interface LysNode {
  id: string;
  base: LysVector;
  tip: LysVector;
  baseNormal?: LysVector;
  tipNormal?: LysVector;
  settings?: LysSupportSettings;
  /** Host of the base end, or null when that end is free. */
  hostBaseId: string | null;
  /** Host of the tip end, or null when that end is free. */
  hostTipId: string | null;
  /** The object the tip-side endpoint belongs to. */
  objectIdTip: string | null;
  /** The object the base-side endpoint belongs to. */
  objectIdBase: string | null;
  mini: boolean;
  isBaseTip: boolean;
  /** Present on girder/grid members; its authored column height is `settings.base.joinLength`. */
  gridNodeIndex: number | null;
}

/** A host relation, with the end it attaches preserved. */
export interface HostEdge {
  childId: string;
  end: HostEnd;
  hostId: string;
}

export interface GraphDiagnostics {
  /** Records dropped for a missing or non-finite endpoint. */
  malformed: string[];
  /** Refs naming an id that is not in the node set. */
  dangling: HostEdge[];
  /** Refs naming a record that was dropped as malformed — broken source, not a broken graph. */
  malformedHosts: HostEdge[];
  /** Refs naming the support itself. */
  selfRefs: HostEdge[];
  /** Host chains that never reach a free end, as the ids of one cycle each. */
  cycles: string[][];
}

export interface LysSupportGraph {
  /** Nodes in scene order — emission order depends on it. */
  nodes: LysNode[];
  byId: Map<string, LysNode>;
  hostEdges: HostEdge[];
  /** Host id -> the ends attached to it, in scene order. */
  childrenByHost: Map<string, HostEdge[]>;
  diagnostics: GraphDiagnostics;
}

const isFiniteVec = (v: unknown): v is LysVector => {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z);
};

/** A parent ref is a non-empty string id; the corpus writes `null` for a free end. */
const hostRef = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

export interface ReadResult {
  nodes: LysNode[];
  malformed: string[];
}

/** Records -> nodes. No geometry decisions beyond rejecting a record with no usable endpoints. */
export function readLysNodes(data: LysData): ReadResult {
  const byId = data?.supports?.present?.byId ?? {};
  const nodes: LysNode[] = [];
  const malformed: string[] = [];

  for (const [id, s] of Object.entries(byId) as [string, LysSupport][]) {
    if (!s || !isFiniteVec(s.base) || !isFiniteVec(s.tip)) {
      malformed.push(id);
      continue;
    }
    nodes.push({
      id: s.id ?? id,
      base: s.base,
      tip: s.tip,
      baseNormal: isFiniteVec(s.baseNormal) ? s.baseNormal : undefined,
      tipNormal: isFiniteVec(s.tipNormal) ? s.tipNormal : undefined,
      settings: s.settings,
      hostBaseId: hostRef(s.parentBaseId),
      hostTipId: hostRef(s.parentTipId),
      objectIdTip: hostRef(s.objectIdTip),
      objectIdBase: hostRef(s.objectIdBase),
      mini: s.mini === true,
      isBaseTip: s.isBaseTip === true,
      gridNodeIndex: typeof s.gridNodeIndex === 'number' && Number.isFinite(s.gridNodeIndex)
        ? s.gridNodeIndex
        : null,
    });
  }

  return { nodes, malformed };
}

export interface RelateResult {
  byId: Map<string, LysNode>;
  hostEdges: HostEdge[];
  childrenByHost: Map<string, HostEdge[]>;
  diagnostics: GraphDiagnostics;
}

/**
 * The one cycle walk. A host chain is a tree in the corpus; a cycle means a ref
 * pair that no emission order can satisfy, so it is reported rather than
 * tolerated.
 */
function findCycles(nodes: LysNode[], byId: Map<string, LysNode>): string[][] {
  const cycles: string[][] = [];
  const settled = new Set<string>();
  for (const start of nodes) {
    if (settled.has(start.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: LysNode | undefined = start;
    while (current) {
      if (onPath.has(current.id)) {
        cycles.push(path.slice(path.indexOf(current.id)));
        break;
      }
      if (settled.has(current.id)) break;
      path.push(current.id);
      onPath.add(current.id);
      const next: string | undefined = current.hostBaseId ?? current.hostTipId ?? undefined;
      if (!next || !byId.has(next)) break;
      current = byId.get(next);
    }
    for (const id of path) settled.add(id);
  }
  return cycles;
}

/** Nodes -> host edges, the children index, and the integrity diagnostics. */
export function relateHosts(nodes: LysNode[], droppedIds: readonly string[] = []): RelateResult {
  const byId = new Map<string, LysNode>();
  for (const node of nodes) byId.set(node.id, node);
  const dropped = new Set(droppedIds);

  const hostEdges: HostEdge[] = [];
  const childrenByHost = new Map<string, HostEdge[]>();
  const dangling: HostEdge[] = [];
  const malformedHosts: HostEdge[] = [];
  const selfRefs: HostEdge[] = [];

  const link = (childId: string, end: HostEnd, hostId: string | null) => {
    if (!hostId) return;
    const edge: HostEdge = { childId, end, hostId };
    if (hostId === childId) {
      selfRefs.push(edge);
      return;
    }
    if (dropped.has(hostId)) {
      malformedHosts.push(edge);
      return;
    }
    if (!byId.has(hostId)) {
      dangling.push(edge);
      return;
    }
    hostEdges.push(edge);
    const bucket = childrenByHost.get(hostId);
    if (bucket) bucket.push(edge);
    else childrenByHost.set(hostId, [edge]);
  };

  for (const node of nodes) {
    link(node.id, 'base', node.hostBaseId);
    link(node.id, 'tip', node.hostTipId);
  }

  return {
    byId,
    hostEdges,
    childrenByHost,
    diagnostics: {
      malformed: [],
      dangling,
      malformedHosts,
      selfRefs,
      cycles: findCycles(nodes, byId),
    },
  };
}

export interface BuildOptions {
  /**
   * Throw on a dangling ref, self-ref or cycle. Whole-scene builds are strict;
   * a caller that scopes records to one object must pass `false` when a support
   * may legitimately name a host outside the slice.
   */
  strict?: boolean;
}

const describeEdge = (e: HostEdge): string => `${e.childId}.${e.end} -> ${e.hostId}`;

/** Read + relate over a whole scene payload. */
export function buildSupportGraph(data: LysData, options: BuildOptions = {}): LysSupportGraph {
  const { nodes, malformed } = readLysNodes(data);
  const related = relateHosts(nodes, malformed);
  const diagnostics: GraphDiagnostics = { ...related.diagnostics, malformed };

  if (options.strict !== false) {
    // A ref to a record dropped as malformed is broken source data, not a broken
    // graph: the caller falls back to "no host" for that end, as the converter
    // does today. Only an id that names nothing at all is corruption.
    const problems: string[] = [];
    if (diagnostics.dangling.length > 0) {
      problems.push(`${diagnostics.dangling.length} dangling host ref(s): ${diagnostics.dangling.slice(0, 5).map(describeEdge).join(', ')}`);
    }
    if (diagnostics.selfRefs.length > 0) {
      problems.push(`${diagnostics.selfRefs.length} self ref(s): ${diagnostics.selfRefs.slice(0, 5).map(describeEdge).join(', ')}`);
    }
    if (diagnostics.cycles.length > 0) {
      problems.push(`${diagnostics.cycles.length} host cycle(s): ${diagnostics.cycles.slice(0, 3).map((c) => c.join(' -> ')).join(' | ')}`);
    }
    if (problems.length > 0) {
      throw new Error(`LYS support graph is not a forest: ${problems.join('; ')}`);
    }
  }

  return {
    nodes,
    byId: related.byId,
    hostEdges: related.hostEdges,
    childrenByHost: related.childrenByHost,
    diagnostics,
  };
}

export type Degree = 0 | 1 | 2;

/** How many ends are hosted. The classifier's primary input. */
export function degreeOf(node: LysNode): Degree {
  return ((node.hostBaseId ? 1 : 0) + (node.hostTipId ? 1 : 0)) as Degree;
}

export function degreeHistogram(graph: LysSupportGraph): Record<string, number> {
  const histogram: Record<string, number> = { '0': 0, '1': 0, '2': 0 };
  for (const node of graph.nodes) {
    const key = String(degreeOf(node));
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return histogram;
}

/**
 * Parents before children, so the emitter can resolve a host's built geometry
 * when it reaches the child. A node whose host is missing keeps its own place.
 */
export function emissionOrder(graph: LysSupportGraph): LysNode[] {
  const ordered: LysNode[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const place = (node: LysNode): void => {
    if (placed.has(node.id) || visiting.has(node.id)) return;
    visiting.add(node.id);
    for (const hostId of [node.hostBaseId, node.hostTipId]) {
      const host = hostId ? graph.byId.get(hostId) : undefined;
      if (host) place(host);
    }
    visiting.delete(node.id);
    placed.add(node.id);
    ordered.push(node);
  };

  for (const node of graph.nodes) place(node);
  return ordered;
}
