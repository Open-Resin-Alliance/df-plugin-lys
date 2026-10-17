import type { Vec3 } from '@/supports/types';

/**
 * Where a hosted end's knot goes, and what parameter it sits at.
 *
 * The old converter spread this decision across `preserveAuthoredAttachPoint`,
 * `isClampedToShaftTip`, `isClampedToShaftBaseTerminal`, `isLeafAttachOnRootRegion`
 * and the twig-host override, then reported a `t` taken from the projection even
 * when it placed the knot at the authored point — so `t` and `pos` could describe
 * two different points. This is that decision in one place, with two differences:
 *
 *  - `t` is the parameter of the position actually chosen, and it is NOT clamped,
 *    so a knot beyond a host's end reports `outOfSegment` rather than a lie.
 *  - the position rules are unchanged, so nothing moves (REBUILD_SCOPE §5
 *    allowlist 3 permits only the parameter to differ).
 *
 * Positions are chosen the way the old code chose them: keep the authored attach
 * point unless the projection says it is far off the host's skeleton mid-span.
 */

export interface HostSegment {
  id: string;
  start: Vec3;
  end: Vec3;
}

export interface HostSkeleton {
  kind: 'trunk' | 'branch' | 'twig' | 'stick' | 'kickstand' | 'brace';
  segments: HostSegment[];
}

export interface KnotInput {
  /** The child's authored attach endpoint, already in the converter's frame. */
  attachPoint: Vec3;
  /**
   * `tip.z - base.z` in the SOURCE frame, or null when either is unusable. The
   * ordering test reads the source frame (the old code does), because that is
   * what says which way the author pointed the support.
   */
  sourceTipMinusBaseZ: number | null;
  /** The child's contact endpoint, in the converter's frame. */
  contactPoint: Vec3;
  host: HostSkeleton;
  /** True when an end ref (`parentBaseId`/`parentTipId`) named this host. */
  usedExplicitParentHint: boolean;
  /** Mini, or an authored shaft of no length — the old code's `isLikelyLeafLike`. */
  isLikelyLeafLike: boolean;
}

export interface KnotDecision {
  parentShaftId: string;
  /** Unclamped parameter of `pos` along its host segment. */
  t: number;
  /** The same parameter clamped to the segment — what the old code reported. */
  tClamped: number;
  pos: Vec3;
  chose: 'authored' | 'projected';
  /** Perpendicular distance from the authored point to the host skeleton. */
  deltaMm: number;
  /** True when `pos` lies beyond its segment's ends. */
  outOfSegment: boolean;
}

/** The projection tolerance the old code used to decide "this point is on the host". */
const ON_HOST_TOLERANCE_MM = 0.5;
/** Where a parameter counts as pinned to a segment end. */
const ENDPOINT_T = 0.02;

export interface Projection {
  segmentIndex: number;
  segmentId: string;
  /** Closest point on the skeleton. */
  point: Vec3;
  /** Unclamped parameter on the matched segment. */
  t: number;
  distanceMm: number;
}

export function projectOntoSkeleton(point: Vec3, segments: HostSegment[]): Projection | null {
  let best: Projection | null = null;
  for (let i = 0; i < segments.length; i++) {
    const { id, start, end } = segments[i];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    const raw = lengthSq > 1e-12
      ? ((point.x - start.x) * dx + (point.y - start.y) * dy + (point.z - start.z) * dz) / lengthSq
      : 0;
    const t = Math.min(1, Math.max(0, raw));
    const closest: Vec3 = { x: start.x + dx * t, y: start.y + dy * t, z: start.z + dz * t };
    const distanceMm = Math.hypot(point.x - closest.x, point.y - closest.y, point.z - closest.z);
    if (!best || distanceMm < best.distanceMm) {
      best = { segmentIndex: i, segmentId: id, point: closest, t: raw, distanceMm };
    }
  }
  return best;
}

/** Parameter of a point on one segment, along the skeleton's own axis direction. */
export function parameterOnSegment(point: Vec3, segment: HostSegment): number {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const dz = segment.end.z - segment.start.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq <= 1e-12) return 0;
  return ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy + (point.z - segment.start.z) * dz) / lengthSq;
}

export function decideKnot(input: KnotInput): KnotDecision | null {
  const { attachPoint, sourceTipMinusBaseZ, contactPoint, host, usedExplicitParentHint, isLikelyLeafLike } = input;
  const projection = projectOntoSkeleton(attachPoint, host.segments);
  if (!projection) return null;
  const hostSegment = host.segments[projection.segmentIndex];

  const deltaMm = projection.distanceMm;
  const hasLargeDelta = deltaMm > ON_HOST_TOLERANCE_MM;
  const pinnedToTip = projection.t >= 1 - ENDPOINT_T;
  const pinnedToBase = projection.t <= ENDPOINT_T;

  // A child clamps to a host end when the authored point is far off the skeleton
  // and the projection runs out of segment — the authored point is then the only
  // statement about where it goes.
  const clampedToShaftTip = pinnedToTip && hasLargeDelta;
  const authoredDeltaZ = Math.abs(attachPoint.z - projection.point.z);
  // A leaf-shaped base landing below the projection but still above the plate is
  // resting on the root pad, not floating: keep the authored point so it does not
  // flip to dangle off the trunk's base.
  const remainsAbovePlate = attachPoint.z >= 0;
  const restsOnRootPad = remainsAbovePlate && attachPoint.z <= projection.point.z;
  const leafAttachOnRootRegion = isLikelyLeafLike && restsOnRootPad;
  const clampedToShaftBaseTerminal = pinnedToBase && hasLargeDelta
    && (!isLikelyLeafLike || authoredDeltaZ <= ON_HOST_TOLERANCE_MM || leafAttachOnRootRegion);

  const preserve = usedExplicitParentHint
    && (deltaMm <= ON_HOST_TOLERANCE_MM || clampedToShaftTip || clampedToShaftBaseTerminal);

  let pos: Vec3 = preserve ? attachPoint : projection.point;
  let chose: KnotDecision['chose'] = preserve ? 'authored' : 'projected';

  // Endpoint ordering: projection can put the knot on the far side of the child's
  // own tip, which flips it to point the wrong way. The authored point never does.
  if (usedExplicitParentHint && (preserve || !(pinnedToTip || pinnedToBase))) {
    const importedTipMinusKnot = contactPoint.z - pos.z;
    if (sourceTipMinusBaseZ !== null && Math.abs(sourceTipMinusBaseZ) > 1e-4 && sourceTipMinusBaseZ * importedTipMinusKnot < 0) {
      pos = attachPoint;
      chose = 'authored';
    }
  }

  // A twig host reprojects strictly onto its joint line: the runtime knot host
  // does, so a knot kept off the line would snap the first time it is dragged.
  if (host.kind === 'twig') {
    pos = projection.point;
    chose = 'projected';
  }

  const t = parameterOnSegment(pos, hostSegment);
  return {
    parentShaftId: projection.segmentId,
    t,
    tClamped: Math.min(1, Math.max(0, t)),
    pos,
    chose,
    deltaMm,
    outOfSegment: t < 0 || t > 1,
  };
}
