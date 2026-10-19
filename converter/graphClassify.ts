import type { HostEnd, LysNode, LysSupportGraph } from './supportGraph';
import { coneLengthMm } from './helpers';

/**
 * Classification from the authored graph.
 *
 * The bucket comes from the graph: how many DISTINCT hosts the two end refs
 * name. Two ends naming one host is a branch, not a brace — the old code agreed,
 * because it deduped the refs into one parent list.
 *
 * Only the within-bucket choice needs geometry, and only three inputs:
 *   - 0 hosts: is the base standing on the plate, and are both normals usable
 *   - 1 host:  is the base standing on the plate, and is there any shaft at all
 *   - 2 hosts: nothing (a spanning member)
 *
 * The span cutoff is not LYS data: the format does not distinguish a twig from a
 * stick, so that threshold is DragonFruit's (`settings.meshToMesh`). It is a
 * named option here, not a buried constant.
 */

export type SupportClass = 'trunk' | 'twig' | 'stick' | 'branch' | 'leaf' | 'kickstand' | 'brace';

export interface ClassifyOptions {
  /** `settings.meshToMesh.stickVsTwigCutoffMm`. Non-positive or non-finite disables the twig side. */
  stickVsTwigCutoffMm: number;
  /** `settings.tip.lengthMm`, used when a node authors no cone length. */
  defaultTipLengthMm: number;
  /** `|base.z|` at or below this is "standing on the plate". The old converter uses 0.2. */
  groundedZMm?: number;
}

export interface NodeClassification {
  node: LysNode;
  kind: SupportClass;
  /** Distinct hosts named by the two end refs. */
  hostCount: 0 | 1 | 2;
  /** End attached to the host; only meaningful when `hostCount === 1`. */
  attachEnd: HostEnd | null;
  /** End that must reach the model. `null` when both ends may be contacts. */
  contactEnd: HostEnd | null;
  grounded: boolean;
  /** Authored base-to-tip distance. */
  spanMm: number;
  /** Authored attach-to-contact distance minus the cone length; drives branch vs leaf. */
  shaftMm: number;
  /** Whether any other node names this one as a host. */
  hasChildren: boolean;
  reason: string;
}

/** A normal is usable when it is finite and not a zero vector. */
export function hasUsableNormal(v: LysNode['baseNormal']): boolean {
  if (!v) return false;
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && v.x * v.x + v.y * v.y + v.z * v.z > 1e-8;
}

const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);


export function classifySupportGraph(graph: LysSupportGraph, options: ClassifyOptions): NodeClassification[] {
  const groundedZMm = options.groundedZMm ?? 0.2;
  const cutoff = options.stickVsTwigCutoffMm;
  const cutoffUsable = Number.isFinite(cutoff) && cutoff > 0;
  const results: NodeClassification[] = [];

  for (const node of graph.nodes) {
    const hosts = new Set([node.hostBaseId, node.hostTipId].filter((id): id is string => !!id));
    const hostCount = hosts.size as 0 | 1 | 2;
    const grounded = Number.isFinite(node.base.z) && Math.abs(node.base.z) <= groundedZMm;
    const spanMm = distance(node.base, node.tip);
    const hasChildren = graph.childrenByHost.has(node.id);
    const base: Omit<NodeClassification, 'kind' | 'attachEnd' | 'contactEnd' | 'shaftMm' | 'reason'> = {
      node,
      hostCount,
      grounded,
      spanMm,
      hasChildren,
    };

    if (hostCount >= 2) {
      results.push({ ...base, kind: 'brace', attachEnd: null, contactEnd: null, shaftMm: spanMm, reason: 'two distinct hosts' });
      continue;
    }

    if (hostCount === 1) {
      // The old code takes parentBaseId before parentTipId, so the base end wins
      // when both name the same host.
      const attachEnd: HostEnd = node.hostBaseId ? 'base' : 'tip';
      const contactEnd: HostEnd = attachEnd === 'base' ? 'tip' : 'base';
      const attachPoint = attachEnd === 'base' ? node.base : node.tip;
      const contactPoint = contactEnd === 'base' ? node.base : node.tip;
      const shaftMm = distance(attachPoint, contactPoint) - coneLengthMm(node, options.defaultTipLengthMm);

      // `type` is not a discriminator: the old guard `!Number.isFinite(type) || type === 0 || type === 1`
      // passes 0, 1 and every non-numeric value, and the corpus authors nothing else.
      if (grounded && !node.mini && !node.isBaseTip) {
        results.push({ ...base, kind: 'kickstand', attachEnd, contactEnd, shaftMm, reason: 'hosted, plate-grounded base' });
        continue;
      }
      if ((node.mini || shaftMm <= 0.2) && !hasChildren) {
        results.push({ ...base, kind: 'leaf', attachEnd, contactEnd, shaftMm, reason: node.mini ? 'mini with no shaft' : `shaft ${shaftMm.toFixed(3)}mm <= 0.2` });
        continue;
      }
      results.push({
        ...base,
        kind: 'branch',
        attachEnd,
        contactEnd,
        shaftMm,
        reason: hasChildren ? 'hosted, has children' : `shaft ${shaftMm.toFixed(3)}mm`,
      });
      continue;
    }

    const dualNormals = hasUsableNormal(node.baseNormal) && hasUsableNormal(node.tipNormal);
    if (!dualNormals) {
      results.push({ ...base, kind: 'trunk', attachEnd: null, contactEnd: 'tip', shaftMm: spanMm, reason: 'free ends, normals unusable' });
      continue;
    }
    if (node.mini) {
      results.push({ ...base, kind: 'twig', attachEnd: null, contactEnd: null, shaftMm: spanMm, reason: 'mini is mesh-to-mesh at any length' });
      continue;
    }
    if (!grounded) {
      const shortEnough = cutoffUsable && spanMm <= cutoff + 1e-6;
      results.push({
        ...base,
        kind: shortEnough ? 'twig' : 'stick',
        attachEnd: null,
        contactEnd: null,
        shaftMm: spanMm,
        reason: `floating, span ${spanMm.toFixed(3)}mm ${shortEnough ? '<=' : '>'} cutoff ${cutoff}`,
      });
      continue;
    }
    results.push({ ...base, kind: 'trunk', attachEnd: null, contactEnd: 'tip', shaftMm: spanMm, reason: 'plate-grounded base' });
  }

  return results;
}

/** Class counts in the shape the acceptance baselines report them. */
export function classCounts(classifications: NodeClassification[]): Record<string, number> {
  const counts: Record<string, number> = { roots: 0, trunks: 0, branches: 0, leaves: 0, twigs: 0, sticks: 0, braces: 0, kickstands: 0 };
  for (const c of classifications) {
    switch (c.kind) {
      case 'trunk':
        counts.trunks += 1;
        counts.roots += 1;
        break;
      case 'branch':
        counts.branches += 1;
        break;
      case 'leaf':
        counts.leaves += 1;
        break;
      case 'twig':
        counts.twigs += 1;
        break;
      case 'stick':
        counts.sticks += 1;
        break;
      case 'brace':
        counts.braces += 1;
        break;
      case 'kickstand':
        counts.kickstands += 1;
        break;
    }
  }
  return counts;
}
