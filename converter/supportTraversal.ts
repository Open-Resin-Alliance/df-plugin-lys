import type { DragonfruitImportFormat, Joint, Knot, Segment, Vec3 } from '@/supports/types';

/**
 * One walk of every placed point in an import payload.
 *
 * The import applies three transforms after conversion — a plate drop, a Z
 * rotation and a world XY placement — and each needs the same set of points.
 * They share this traversal so a collection or a field cannot be covered by one
 * and missed by another.
 *
 * Two kinds of point are distinguished because they transform differently: a
 * POSITION moves with a translation and turns about a pivot, while a DIRECTION
 * only turns. A caller that ignores `direction` is a pure translation.
 */
export interface SupportVisitor {
  /** A placed point: joint, contact, root, knot or bezier control point. */
  position(pos: Vec3): void;
  /** A unit vector: contact normal, surface normal, disk axis or bezier tangent. */
  direction?(dir: Vec3): void;
}

/**
 * Joints and knots are shared objects: a joint sits on the two segments it
 * joins, and one host knot can serve two kickstands. Visiting by identity keeps
 * a shared object from being transformed once per reference.
 */
class VisitOnce {
  private readonly seen = new Set<string>();

  constructor(private readonly visitor: SupportVisitor) {}

  position(pos: Vec3 | undefined | null): void {
    if (pos) this.visitor.position(pos);
  }

  direction(dir: Vec3 | undefined | null): void {
    if (dir && this.visitor.direction) this.visitor.direction(dir);
  }

  /** A joint or knot, transformed once however many times it is referenced. */
  keyed(entity: { id?: string; pos?: Vec3 } | undefined | null): void {
    if (!entity?.pos) return;
    const key = typeof entity.id === 'string' ? entity.id : null;
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    this.visitor.position(entity.pos);
  }
}

/** A cone contact: its point, the axis it is aimed along, and the surface it sits on. */
function visitContactCone(
  v: VisitOnce,
  cone: { pos?: Vec3; normal?: Vec3; surfaceNormal?: Vec3 } | undefined | null,
): void {
  if (!cone) return;
  v.position(cone.pos);
  v.direction(cone.normal);
  v.direction(cone.surfaceNormal);
}

/** A disk contact: its point, the surface it seats against, and its cone axis. */
function visitContactDisk(
  v: VisitOnce,
  disk: { pos?: Vec3; surfaceNormal?: Vec3; coneAxis?: Vec3 } | undefined | null,
): void {
  if (!disk) return;
  v.position(disk.pos);
  v.direction(disk.surfaceNormal);
  v.direction(disk.coneAxis);
}

/** Both joints of every segment, plus the curve data a bezier carries. */
function visitSegments(v: VisitOnce, segments: Segment[] | undefined | null): void {
  for (const seg of segments ?? []) {
    v.keyed(seg?.bottomJoint as Joint | undefined);
    v.keyed(seg?.topJoint as Joint | undefined);
    if (seg?.type === 'bezier') {
      v.position(seg.controlPoint1);
      v.position(seg.controlPoint2);
      v.direction(seg.startTangent);
      v.direction(seg.endTangent);
    }
  }
}

/**
 * Visits every point in the payload, in a fixed order.
 *
 * A knot is visited before the kickstands, so a host knot shared by two builds
 * is reached once whichever collection names it first.
 */
export function visitSupportGeometry(
  data: Partial<DragonfruitImportFormat> | null | undefined,
  visitor: SupportVisitor,
): void {
  if (!data) return;
  const v = new VisitOnce(visitor);

  for (const root of data.roots ?? []) v.position(root?.transform?.pos);

  for (const trunk of data.trunks ?? []) {
    visitSegments(v, trunk?.segments);
    visitContactCone(v, trunk?.contactCone);
  }

  for (const branch of data.branches ?? []) {
    visitSegments(v, branch?.segments);
    visitContactCone(v, branch?.contactCone);
  }

  for (const leaf of data.leaves ?? []) visitContactCone(v, leaf?.contactCone);

  for (const twig of data.twigs ?? []) {
    visitSegments(v, twig?.segments);
    visitContactDisk(v, twig?.contactDiskA);
    visitContactDisk(v, twig?.contactDiskB);
  }

  for (const stick of data.sticks ?? []) {
    visitSegments(v, stick?.segments);
    visitContactCone(v, stick?.contactConeA);
    visitContactCone(v, stick?.contactConeB);
  }

  for (const stump of data.stumps ?? []) {
    v.position(stump?.rootPos);
    v.keyed(stump?.joint);
    visitSegments(v, stump?.segments);
    visitContactCone(v, stump?.contactCone);
  }

  for (const knot of data.knots ?? []) v.keyed(knot as Knot);

  for (const build of data.kickstands ?? []) {
    v.position(build?.root?.transform?.pos);
    v.keyed(build?.hostKnot as Knot | undefined);
    visitSegments(v, build?.kickstand?.segments);
  }
}
