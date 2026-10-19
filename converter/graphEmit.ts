import * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';
import type { Brace, Branch, DragonfruitImportFormat, Joint, Knot, Leaf, Roots, Segment, Stick, Trunk, Twig, Vec3 } from '@/supports/types';
import type { ContactDiskProfile } from '@/supports/SupportPrimitives/ContactCone/types';
import type { SupportSettings } from '@/supports/Settings';
import { getJointDiameter } from '@/supports/constants';
import { isKickstandHostType, knotHostId } from '@/supports/supportTypeRegistry';
import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone';
import { recomputeLeafContactConeAxisAndLength } from '@/supports/state';
import { buildKickstandData } from '@/supports/SupportTypes/Kickstand/kickstandBuilder';
import { twigDiskJointStandoff } from '@/supports/SupportTypes/Twig/twigJointStandoff';
import { resolveTwigDiameterAtSegmentT, twigJointDiameterForLocalDiameter } from '@/supports/SupportTypes/Twig/twigTaper';
import { computeLowestZ } from '@/utils/geometry';
import { quaternionFromGlobalEulerDegrees } from '@/utils/rotation';
import { calculateSmoothedNormal } from '@/supports/PlacementLogic/PlacementUtils';
import { createContactAssembly } from './contactAssembly';
import { ensureMeshRaycastIndex, raycastMeshBVH } from './meshRaycast';
import { pickContactTipSettings, pickEndpointTipSettings, pickDiskStandoff, gridColumnHeightMm, inferLeafTipEndpoint, pickLeafEndpointDiameter } from './helpers';
import { decideKnot, parameterOnSegment, projectOntoSkeleton, type HostSegment, type HostSkeleton } from './knotPolicy';
import type { LysData, LysObject, LysTipSettings } from './types';
import { classifySupportGraph, hasUsableNormal, type ClassifyOptions, type SupportClass } from './graphClassify';
import { buildSupportGraph, emissionOrder, type HostEnd, type LysNode } from './supportGraph';

/**
 * The emit pass: one walk of the graph in host-before-child order, each node
 * built once.
 *
 * A hosted class resolves against its host's published DragonFruit skeleton, so
 * a host is always emitted before its children. A class present in the graph
 * that no emitter builds is reported in `notYetWired` — never silently dropped.
 */

/** The per-object frame a node's authored coordinates are read in. */
export interface ObjectFrame {
  /** `transformObjectPoint` plus the object's own XY: the final payload frame. */
  transformPoint(v: Vec3): THREE.Vector3;
  /**
   * The point in the GHOST MESH's frame: `transformObjectPoint` as the old
   * converter had it, carrying the object's lift but not its XY.
   *
   * The caller builds the ghost mesh in a group at `(0, 0, pos.z)` — the XY shift
   * is applied to the payload afterwards, not to the mesh — so a raycast must be
   * fed points in this frame or it is aimed a whole object-position away from the
   * mesh and hits the wrong surface (or nothing).
   */
  meshFramePoint(v: Vec3): THREE.Vector3;
  /** `transformObjectNormal`: inverse scale, then rotation, renormalised. */
  transformNormal(v: Vec3): THREE.Vector3;
  /**
   * World offset between a converter contact point and the same point on the
   * raycast ghost mesh, whose inner mesh is offset by `-pivot` before the group's
   * scale and rotation. Used by the twig contact-normal raycast.
   */
  meshPivotShift: THREE.Vector3;
  /**
   * The drop the importer applies after conversion. Supports are built in
   * pre-offset space, so anything measured from the plate subtracts it. Zero when
   * no mesh is supplied, which is the snapshot harness path.
   */
  plateDropZ: number;
  /**
   * The object's authored position. `transformPoint` already includes it; the
   * root/base convention does not use the object transform at all, so it needs
   * the XY read directly.
   */
  objectPosition: Vec3;
  mesh?: THREE.Mesh;
}

/**
 * The frame the current converter builds per object. The authored rotation is
 * used as-is: the file-type path strips Z before conversion, the snapshot harness
 * does not, and this pass must reproduce whichever payload it is handed.
 */
export function makeObjectFrame(object: LysObject | undefined, mesh?: THREE.Mesh): ObjectFrame {
  const pivot = (object?.formerCenter ?? object?.center ?? { x: 0, y: 0, z: 0 }) as Vec3;
  const pos = (object?.position ?? { x: 0, y: 0, z: 0 }) as Vec3;
  const scale = (object?.scale ?? { x: 1, y: 1, z: 1 }) as Vec3;
  const rot = (object?.rotation ?? { x: 0, y: 0, z: 0 }) as Vec3;
  const q = quaternionFromGlobalEulerDegrees(rot);
  const scratch = new THREE.Vector3();

  // The drop the caller will apply afterwards, measured from the ghost mesh's
  // lowest point once the object transform is on it.
  let plateDropZ = 0;
  if (mesh?.geometry) {
    mesh.geometry.computeBoundingBox();
    const bbox = mesh.geometry.boundingBox;
    if (bbox) {
      const geomCenter = bbox.getCenter(new THREE.Vector3());
      const localTransform = new THREE.Matrix4()
        .compose(new THREE.Vector3(0, 0, 0), q, new THREE.Vector3(scale.x || 1, scale.y || 1, scale.z || 1))
        .multiply(new THREE.Matrix4().makeTranslation(-geomCenter.x, -geomCenter.y, -geomCenter.z));
      const lowest = computeLowestZ(mesh.geometry, localTransform);
      if (Number.isFinite(lowest)) plateDropZ = -lowest;
    }
  }

  return {
    mesh,
    plateDropZ,
    objectPosition: pos,
    transformPoint(v: Vec3): THREE.Vector3 {
      scratch.set(v.x * scale.x, v.y * scale.y, v.z * scale.z).applyQuaternion(q);
      return new THREE.Vector3(scratch.x + pos.x, scratch.y + pos.y, scratch.z + pos.z);
    },
    meshFramePoint(v: Vec3): THREE.Vector3 {
      scratch.set(v.x * scale.x, v.y * scale.y, v.z * scale.z).applyQuaternion(q);
      return new THREE.Vector3(scratch.x, scratch.y, scratch.z + pos.z);
    },
    transformNormal(v: Vec3): THREE.Vector3 {
      scratch.set(
        v.x * (Math.abs(scale.x) > 1e-8 ? 1 / scale.x : 0),
        v.y * (Math.abs(scale.y) > 1e-8 ? 1 / scale.y : 0),
        v.z * (Math.abs(scale.z) > 1e-8 ? 1 / scale.z : 0),
      ).applyQuaternion(q);
      if (scratch.lengthSq() > 1e-8) scratch.normalize();
      return scratch.clone();
    },
    meshPivotShift: new THREE.Vector3(pivot.x * scale.x, pivot.y * scale.y, pivot.z * scale.z).applyQuaternion(q),
  };
}

/**
 * The true model-surface normal at a contact, from the mesh the caller supplied.
 *
 * Lychee's authored normal is the approach direction of the sphere it contacts
 * with, not the surface normal, and at steep angles the two diverge badly — so a
 * contact disk seated on the authored normal sits at the wrong angle on the face.
 * The shaft keeps the authored angle and the disk pivots to the real one.
 *
 * Frame note: the caller's contact points do not share a frame with the ghost
 * mesh, whose inner mesh is offset by `-pivot` before the group's scale and
 * rotation. Subtracting `meshPivotShift` lands the point on that mesh before the
 * cast, and the smoothed normal comes back in world frame.
 */
function raycastSurfaceNormal(
  contactWorld: THREE.Vector3,
  authoredNormal: THREE.Vector3,
  meshPivotShift: THREE.Vector3,
  mesh?: THREE.Mesh,
): { normal: Vec3; raycastHit: boolean } {
  const fallback = { normal: { x: authoredNormal.x, y: authoredNormal.y, z: authoredNormal.z }, raycastHit: false };
  if (!mesh || authoredNormal.lengthSq() <= 1e-8) return fallback;

  const meshFrameContact = contactWorld.clone().sub(meshPivotShift);
  const dir = authoredNormal.clone().normalize().multiplyScalar(-1); // travel INTO the surface
  // Originate well outside the mesh so the ray enters from outside the solid.
  ensureMeshRaycastIndex(mesh);
  const boundingRadius = mesh.geometry.boundingSphere?.radius ?? 0;
  const origin = meshFrameContact.clone().addScaledVector(dir, -(boundingRadius * 2 + 50));

  const raycaster = new THREE.Raycaster();
  raycaster.set(origin, dir);
  const intersects = raycastMeshBVH(mesh, raycaster);
  if (intersects.length === 0) return fallback;

  // Pick the intersection nearest the (compensated) contact point.
  let best = intersects[0];
  let bestDist = best.point.distanceTo(meshFrameContact);
  for (const hit of intersects) {
    const dist = hit.point.distanceTo(meshFrameContact);
    if (dist < bestDist) { best = hit; bestDist = dist; }
  }

  const smoothed = calculateSmoothedNormal(best);
  const n = new THREE.Vector3(smoothed.x, smoothed.y, smoothed.z);
  if (n.lengthSq() <= 1e-8) return fallback;
  n.normalize();
  return { normal: { x: n.x, y: n.y, z: n.z }, raycastHit: true };
}

export interface EmitDiagnostics {
  /** Entities built, by class. */
  emitted: Record<string, number>;
  /** Classes present in the graph that this pass does not build yet. */
  notYetWired: string[];
  /** Nodes the emitter dropped, with the reason — the converter's warn-and-skip, kept explicit. */
  skipped: string[];
}

/** The emitter fills every collection, so none of them is optional while it runs. */
export type EmitFormat = DragonfruitImportFormat
  & Required<Pick<DragonfruitImportFormat, 'roots' | 'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'knots' | 'kickstands'>>;

interface EmitState {
  format: EmitFormat;
  settings: SupportSettings;
  objects: Record<string, LysObject>;
  frames: Map<string, ObjectFrame>;
  /** Published skeletons, keyed by the LYS support id that owns them. */
  hosts: Map<string, HostRecord>;
  /** Ids referenced as a host by at least one node. */
  hasChildren: Set<string>;
  /**
   * Every knot by its site — (shaft, position, diameter). One store for every path
   * that creates a knot, because a site on a shaft is one knot however many
   * supports attach there. The old code keyed this way for braces alone, so a leaf
   * fanned onto a twig with six siblings got seven knots at one point.
   */
  knotsBySite: Map<string, Knot>;
  /** Every node id the graph holds, so a ref to a deleted support reads as such. */
  nodeIds: Set<string>;
  mesh?: THREE.Mesh;
  diagnostics: EmitDiagnostics;
}

/** What a child needs from an already-emitted host: its skeleton, and its entity when a lookup needs it. */
interface HostRecord {
  skeleton: HostSkeleton;
  /** Shaft diameter per segment id — a kickstand sizes itself from its host shaft. */
  segmentDiameter: Map<string, number>;
  twig?: Twig;
}

/**
 * Which object a node belongs to: the tip-side object, then the base-side one,
 * then the scene's first object — the same order the current converter resolves
 * ownership in, minus its warning (the emitter reports through `skipped`).
 */
function ownerOf(state: EmitState, node: LysNode): string {
  const tip = node.objectIdTip;
  if (tip && state.objects[tip]) return tip;
  const base = node.objectIdBase;
  if (base && state.objects[base]) return base;
  const first = Object.keys(state.objects)[0];
  return first ?? 'unknown';
}

function frameFor(state: EmitState, owner: string): ObjectFrame {
  const cached = state.frames.get(owner);
  if (cached) return cached;
  const frame = makeObjectFrame(state.objects[owner], state.mesh);
  state.frames.set(owner, frame);
  return frame;
}

/** True when a transformed normal is present and not degenerate. */
function isUsableNormalVec(v: THREE.Vector3 | null): v is THREE.Vector3 {
  return !!v && v.lengthSq() > 1e-8;
}

/**
 * Why a child could not reach its host: a ref the file never defines is a stale
 * reference in the source, not a conversion failure.
 */
function missingHostReason(state: EmitState, hostId: string | null | undefined): string {
  if (!hostId) return 'names no host';
  return state.nodeIds.has(hostId)
    ? `host ${hostId} was not emitted`
    : `host ${hostId} is not in the file`;
}

/** The ends whose transformed normal is missing or degenerate. */
function unusableNormalEnds(baseNormal: THREE.Vector3 | null, tipNormal: THREE.Vector3 | null): string[] {
  const ends: string[] = [];
  if (!isUsableNormalVec(baseNormal)) ends.push('base');
  if (!isUsableNormalVec(tipNormal)) ends.push('tip');
  return ends;
}

/**
 * A floating two-cone stick: one segment between the two socket joints, a cone
 * at each end. Ported from the current converter's stick path so the shaft
 * signature and joint positions the acceptance snapshot records are reproduced
 * by construction rather than re-derived.
 */
function emitStick(state: EmitState, node: LysNode): void {
  const owner = ownerOf(state, node);
  const frame = frameFor(state, owner);
  const baseWorld = frame.transformPoint(node.base);
  const tipWorld = frame.transformPoint(node.tip);
  const baseNormal = node.baseNormal ? frame.transformNormal(node.baseNormal) : null;
  const tipNormal = node.tipNormal ? frame.transformNormal(node.tipNormal) : null;

  if (!isUsableNormalVec(baseNormal) || !isUsableNormalVec(tipNormal)) {
    const unusableEnds = unusableNormalEnds(baseNormal, tipNormal);
    state.diagnostics.skipped.push(`${node.id}: stick without a usable normal at the ${unusableEnds.join(' and ')} end`);
    return;
  }

  const baseEndpoint = pickEndpointTipSettings(node, 'base');
  const tipEndpoint = pickEndpointTipSettings(node, 'tip');
  const tipDefaults = state.settings.tip;

  const { socketJoint: socketJointA, contactCone: contactConeA } = createContactAssembly(
    node, baseWorld, { x: tipWorld.x, y: tipWorld.y, z: tipWorld.z },
    baseEndpoint, tipDefaults, frame.mesh, true, true, baseNormal, false,
  );
  const { socketJoint: socketJointB, contactCone: contactConeB } = createContactAssembly(
    node, tipWorld, { x: baseWorld.x, y: baseWorld.y, z: baseWorld.z },
    tipEndpoint, tipDefaults, frame.mesh, true, true, tipNormal, false,
  );

  const shaftDiameter = node.settings?.base?.joinDiameter
    || baseEndpoint?.diameter
    || tipEndpoint?.diameter
    || state.settings.shaft.diameterMm;

  const segment: Segment = {
    id: uuidv4(),
    type: 'straight',
    diameter: shaftDiameter,
    bottomJoint: socketJointA,
    topJoint: socketJointB,
  };
  const stick: Stick = { id: uuidv4(), modelId: owner, segments: [segment], contactConeA, contactConeB };
  state.format.sticks.push(stick);
  state.hosts.set(node.id, {
    skeleton: { kind: 'stick', segments: [{ id: segment.id, start: socketJointA.pos, end: socketJointB.pos }] },
    segmentDiameter: new Map([[segment.id, shaftDiameter]]),
  });
  state.diagnostics.emitted.stick = (state.diagnostics.emitted.stick ?? 0) + 1;
}

/** `pickTwigContactDiameter`: point diameter, body diameter, then the tip profile's contact diameter. */
function pickContactDiameterMm(endpointSettings: LysTipSettings | undefined, tipDefaults: SupportSettings['tip']): number {
  const pointDiameter = endpointSettings?.pointDiameter;
  if (typeof pointDiameter === 'number' && Number.isFinite(pointDiameter) && pointDiameter > 0) return pointDiameter;
  const diameter = endpointSettings?.diameter;
  if (typeof diameter === 'number' && Number.isFinite(diameter) && diameter > 0) return diameter;
  return tipDefaults.contactDiameterMm;
}

/**
 * A floating two-disk twig: one segment between two socket joints that sit off
 * their disk centres by the native angle-aware standoff, so an imported twig is
 * structurally identical to a hand-placed one (the knot-drag and taper paths
 * resolve a host twig through those joints).
 *
 * The disk seats against the true model-surface normal (raycast) while the shaft
 * keeps the authored angle — the same split the current converter makes.
 */
function emitTwig(state: EmitState, node: LysNode): void {
  const owner = ownerOf(state, node);
  const frame = frameFor(state, owner);
  const baseWorld = frame.transformPoint(node.base);
  const tipWorld = frame.transformPoint(node.tip);
  const baseNormal = node.baseNormal ? frame.transformNormal(node.baseNormal) : null;
  const tipNormal = node.tipNormal ? frame.transformNormal(node.tipNormal) : null;

  if (!isUsableNormalVec(baseNormal) || !isUsableNormalVec(tipNormal)) {
    const unusableEnds = unusableNormalEnds(baseNormal, tipNormal);
    state.diagnostics.skipped.push(`${node.id}: twig without a usable normal at the ${unusableEnds.join(' and ')} end`);
    return;
  }

  const axisA = tipWorld.clone().sub(baseWorld);
  if (axisA.lengthSq() <= 1e-8) {
    state.diagnostics.skipped.push(`${node.id}: twig with coincident contacts`);
    return;
  }
  axisA.normalize();
  const axisB = axisA.clone().multiplyScalar(-1);

  const tipDefaults = state.settings.tip;
  // Raycast in the ghost mesh's frame, not the payload's: the mesh carries the
  // object's lift but not its XY, and the caller applies the XY shift afterwards.
  const baseSurfaceVec = raycastSurfaceNormal(frame.meshFramePoint(node.base), baseNormal, frame.meshPivotShift, frame.mesh).normal;
  const tipSurfaceVec = raycastSurfaceNormal(frame.meshFramePoint(node.tip), tipNormal, frame.meshPivotShift, frame.mesh).normal;

  const contactDiameterA = pickContactDiameterMm(pickEndpointTipSettings(node, 'base'), tipDefaults);
  const contactDiameterB = pickContactDiameterMm(pickEndpointTipSettings(node, 'tip'), tipDefaults);

  const diskProfile: ContactDiskProfile = {
    type: 'disk',
    ...pickDiskStandoff(tipDefaults),
  };

  const jointDiameterA = twigJointDiameterForLocalDiameter(contactDiameterA);
  const jointDiameterB = twigJointDiameterForLocalDiameter(contactDiameterB);
  const diskThicknessA = twigDiskJointStandoff({
    surfaceNormal: baseSurfaceVec,
    coneAxis: { x: axisA.x, y: axisA.y, z: axisA.z },
    profile: diskProfile,
    jointDiameterMm: jointDiameterA,
  });
  const diskThicknessB = twigDiskJointStandoff({
    surfaceNormal: tipSurfaceVec,
    coneAxis: { x: axisB.x, y: axisB.y, z: axisB.z },
    profile: diskProfile,
    jointDiameterMm: jointDiameterB,
  });

  const socketJointA = {
    id: uuidv4(),
    pos: {
      x: baseWorld.x + baseSurfaceVec.x * diskThicknessA,
      y: baseWorld.y + baseSurfaceVec.y * diskThicknessA,
      z: baseWorld.z + baseSurfaceVec.z * diskThicknessA,
    },
    diameter: jointDiameterA,
  };
  const socketJointB = {
    id: uuidv4(),
    pos: {
      x: tipWorld.x + tipSurfaceVec.x * diskThicknessB,
      y: tipWorld.y + tipSurfaceVec.y * diskThicknessB,
      z: tipWorld.z + tipSurfaceVec.z * diskThicknessB,
    },
    diameter: jointDiameterB,
  };

  const segment: Segment = {
    id: uuidv4(),
    type: 'straight',
    diameter: Math.min(contactDiameterA, contactDiameterB),
    bottomJoint: socketJointA,
    topJoint: socketJointB,
  };

  const twig: Twig = {
    id: uuidv4(),
    modelId: owner,
    segments: [segment],
    contactDiskA: {
      id: uuidv4(),
      pos: { x: baseWorld.x, y: baseWorld.y, z: baseWorld.z },
      surfaceNormal: baseSurfaceVec,
      coneAxis: { x: axisA.x, y: axisA.y, z: axisA.z },
      diskLengthOverride: diskThicknessA,
      profile: diskProfile,
      contactDiameterMm: contactDiameterA,
    },
    contactDiskB: {
      id: uuidv4(),
      pos: { x: tipWorld.x, y: tipWorld.y, z: tipWorld.z },
      surfaceNormal: tipSurfaceVec,
      coneAxis: { x: axisB.x, y: axisB.y, z: axisB.z },
      diskLengthOverride: diskThicknessB,
      profile: diskProfile,
      contactDiameterMm: contactDiameterB,
    },
  };
  state.format.twigs.push(twig);
  // A twig's skeleton is its JOINT line, not its disk centres: the runtime knot
  // host and the taper math both resolve through the joints.
  state.hosts.set(node.id, {
    skeleton: { kind: 'twig', segments: [{ id: segment.id, start: socketJointA.pos, end: socketJointB.pos }] },
    segmentDiameter: new Map([[segment.id, segment.diameter]]),
    twig,
  });
  state.diagnostics.emitted.twig = (state.diagnostics.emitted.twig ?? 0) + 1;
}

/**
 * A rooted support: a plate root, a collar joint whose height comes from the
 * authored join length, and a shaft up to the cone.
 *
 * The base position is authored in post-scale, post-rotation world XY relative
 * to the object's world position, so it is floor-anchored rather than put
 * through the object transform — the one place the two coordinate conventions in
 * this format meet.
 */
function emitTrunk(state: EmitState, node: LysNode): void {
  const owner = ownerOf(state, node);
  const frame = frameFor(state, owner);
  const tipWorld = frame.transformPoint(node.tip);
  // Authored in post-scale, post-rotation world XY relative to the object, then
  // carried by the object's own XY — the two conventions of this format meeting.
  const baseRefWorld = new THREE.Vector3(
    node.base.x + frame.objectPosition.x,
    node.base.y + frame.objectPosition.y,
    0,
  );

  const tipSettings = pickContactTipSettings(node);
  const baseSettings = node.settings?.base;
  const rootDefaults = state.settings.roots;
  const shaftDefaults = state.settings.shaft;

  const diskHeight = rootDefaults.diskHeightMm;
  const coneHeight = rootDefaults.coneHeightMm;
  const totalBaseHeight = diskHeight + coneHeight;
  const pillarDiameter = baseSettings?.joinDiameter || tipSettings?.diameter || shaftDefaults.diameterMm;

  const rootId = uuidv4();
  const root: Roots = {
    id: rootId,
    modelId: owner,
    // The plate sits a drop below the space the shaft is built in.
    transform: { pos: { x: baseRefWorld.x, y: baseRefWorld.y, z: 0 - frame.plateDropZ }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: rootDefaults.diameterMm,
    diskHeight,
    coneHeight,
  };

  // `joinLength` is the visible collar; `newJoinLength` is what the source solved
  // with. Both are plate-space, so both subtract the drop the caller will apply.
  const visibleJoinLength = Number.isFinite(baseSettings?.joinLength as number)
    ? Math.max(0, baseSettings?.joinLength as number)
    : null;
  const solveJoinLength = Number.isFinite(baseSettings?.newJoinLength as number)
    ? Math.max(0, baseSettings?.newJoinLength as number)
    : visibleJoinLength;

  const joint0SolveRise = (solveJoinLength ?? totalBaseHeight) - frame.plateDropZ;
  const joint0VisibleRiseRaw = visibleJoinLength !== null ? visibleJoinLength - frame.plateDropZ : joint0SolveRise;
  // The knee clears the root collar by a hair: below that the collar swallows it.
  const minimumVisibleKneeRise = totalBaseHeight + 0.05 - frame.plateDropZ;
  const joint0Rise = Math.max(joint0VisibleRiseRaw, minimumVisibleKneeRise);
  const joint0SolvePos: Vec3 = { x: baseRefWorld.x, y: baseRefWorld.y, z: baseRefWorld.z + joint0SolveRise };
  const joint0: Joint = {
    id: uuidv4(),
    pos: { x: baseRefWorld.x, y: baseRefWorld.y, z: baseRefWorld.z + joint0Rise },
    // The pillar runs through on both sides, so the joint is sized from it.
    diameter: getJointDiameter(pillarDiameter),
  };

  const transformedTipNormal = node.tipNormal ? frame.transformNormal(node.tipNormal) : null;
  const { socketJoint, contactCone } = createContactAssembly(
    node, tipWorld, joint0SolvePos, tipSettings, state.settings.tip, frame.mesh, true, true, transformedTipNormal, true, pillarDiameter,
  );

  const segments: Segment[] = [
    { id: uuidv4(), type: 'straight', diameter: pillarDiameter, bottomJoint: undefined, topJoint: joint0 },
    { id: uuidv4(), type: 'straight', diameter: pillarDiameter, bottomJoint: joint0, topJoint: socketJoint },
  ];
  const trunk: Trunk = { id: uuidv4(), modelId: owner, rootId, segments, contactCone };

  state.format.roots.push(root);
  state.format.trunks.push(trunk);
  // The trunk's skeleton starts at the ROOT TOP, not at the authored base: the
  // root's collar occupies the span between them.
  state.hosts.set(node.id, {
    skeleton: {
      kind: 'trunk',
      segments: [
        { id: segments[0].id, start: { x: root.transform.pos.x, y: root.transform.pos.y, z: root.transform.pos.z + diskHeight + coneHeight }, end: joint0.pos },
        { id: segments[1].id, start: joint0.pos, end: socketJoint.pos },
      ],
    },
    segmentDiameter: new Map([[segments[0].id, pillarDiameter], [segments[1].id, pillarDiameter]]),
  });
  state.diagnostics.emitted.trunk = (state.diagnostics.emitted.trunk ?? 0) + 1;
}

/**
 * Which of the two ends attaches to the host.
 *
 * The base end wins when both refs name one host — the order the old code reads
 * them in — except when BOTH name the SAME host: its hint test then fails and it
 * picks the end by normal, then by distance to the host.
 */
export function resolveAttachEnd(node: LysNode, host: HostSkeleton, pA: THREE.Vector3, pB: THREE.Vector3): HostEnd {
  const bothRefsSameHost = !!node.hostBaseId && !!node.hostTipId && node.hostBaseId === node.hostTipId;
  if (!bothRefsSameHost) return node.hostBaseId ? 'base' : 'tip';

  const baseUsable = hasUsableNormal(node.baseNormal);
  const tipUsable = hasUsableNormal(node.tipNormal);
  if (baseUsable !== tipUsable) {
    // The endpoint carrying a normal is the model contact, so the other end attaches.
    return tipUsable ? 'base' : 'tip';
  }
  const distanceToHostA = projectOntoSkeleton(pA, host.segments)?.distanceMm ?? Number.POSITIVE_INFINITY;
  const distanceToHostB = projectOntoSkeleton(pB, host.segments)?.distanceMm ?? Number.POSITIVE_INFINITY;
  return distanceToHostA <= distanceToHostB ? 'base' : 'tip';
}

/**
 * A hosted support: a knot on its host's shaft, and then either a branch below it
 * or — when the shaft turns out to be nothing but cone — a leaf at it.
 *
 * Which of the two is settled HERE, after the knot exists, because the shaft
 * length is measured from the knot the policy chose. That is the one decision that
 * spans classify and emit.
 */
function emitHosted(state: EmitState, node: LysNode): void {
  const hostId = node.hostBaseId ?? node.hostTipId;
  if (!hostId) {
    state.diagnostics.skipped.push(`${node.id}: hosted with no host ref`);
    return;
  }
  const record = state.hosts.get(hostId);
  if (!record) {
    state.diagnostics.skipped.push(`${node.id}: ${missingHostReason(state, hostId)}`);
    return;
  }

  const owner = ownerOf(state, node);
  const frame = frameFor(state, owner);
  const pA = frame.transformPoint(node.base);
  const pB = frame.transformPoint(node.tip);
  const attachEnd = resolveAttachEnd(node, record.skeleton, pA, pB);
  const attachPoint = attachEnd === 'base' ? pA : pB;
  const contactPoint = attachEnd === 'base' ? pB : pA;

  const tipSettings = pickContactTipSettings(node);
  const tipLen = tipSettings?.length || state.settings.tip.lengthMm;
  const isLikelyLeafLike = node.mini || attachPoint.distanceTo(contactPoint) - tipLen <= 0.2;
  const usedExplicitParentHint = !(node.hostBaseId && node.hostTipId && node.hostBaseId === node.hostTipId);
  const sourceTipMinusBaseZ = Number.isFinite(node.tip.z) && Number.isFinite(node.base.z)
    ? node.tip.z - node.base.z
    : null;

  const decision = decideKnot({
    attachPoint,
    sourceTipMinusBaseZ,
    contactPoint,
    host: record.skeleton,
    usedExplicitParentHint,
    isLikelyLeafLike,
  });
  if (!decision) {
    state.diagnostics.skipped.push(`${node.id}: host ${hostId} published no skeleton`);
    return;
  }

  const knotImportHint: NonNullable<Knot['_importHint']> = decision.chose === 'authored' ? 'preserve' : 'project';
  // Several supports attaching at one point on a shaft are one knot, so this is
  // shared: a leaf fanned onto a twig beside six siblings does not get its own.
  const knot: Knot = knotAt(state, decision.parentShaftId, decision.t, decision.pos, undefined, knotImportHint);
  // Sharing is identity only. The geometry below stays on THIS node's own attach
  // point, because a shared knot's position is the first caller's: the site key
  // rounds, so another node's point can differ from it by up to half a thousandth,
  // and that is enough to flip a boundary test (a girder branch losing its column
  // joint) or nudge a joint.
  const knotPos: Vec3 = decision.pos;

  const shaftLength = new THREE.Vector3(knotPos.x, knotPos.y, knotPos.z).distanceTo(contactPoint) - tipLen;
  const isLeaf = (node.mini || shaftLength <= 0.2) && !state.hasChildren.has(node.id);
  const shaftDiameter = node.settings?.base?.joinDiameter
    || tipSettings?.diameter
    || state.settings.shaft.diameterMm;
  const transformedTipNormal = node.tipNormal ? frame.transformNormal(node.tipNormal) : null;

  const { socketJoint, contactCone } = createContactAssembly(
    node, contactPoint, knotPos, tipSettings, state.settings.tip, frame.mesh, true, true, transformedTipNormal, true,
    // A leaf is all cone, with no shaft to take a width from.
    isLeaf ? undefined : shaftDiameter,
  );

  if (isLeaf) {
    socketJoint.pos = knotPos;
    // Aim and length the cone with the canonical routine the load path and the
    // live drag preview use, so the import does not snap on first drag. The model
    // contact is held fixed: only the knot-side angle and length change.
    const leafSurfaceNormal = contactCone.surfaceNormal ?? contactCone.normal;
    const { axis, lengthMm } = recomputeLeafContactConeAxisAndLength(
      contactCone.pos, leafSurfaceNormal, knotPos, contactCone.profile,
    );
    contactCone.normal = axis;
    contactCone.profile.lengthMm = lengthMm;

    const tipEndpoint = inferLeafTipEndpoint(contactPoint, pA, pB);
    const anchorEndpoint = tipEndpoint === 'tip' ? 'base' : 'tip';
    contactCone.profile.contactDiameterMm = pickLeafEndpointDiameter(node, tipEndpoint, contactCone.profile.contactDiameterMm);
    contactCone.profile.bodyDiameterMm = pickLeafEndpointDiameter(node, anchorEndpoint, contactCone.profile.bodyDiameterMm);

    // A leaf on a twig is sized like a hand-placed one: the local taper diameter
    // at the attach parameter, and the twig joint rule for its knot.
    if (record.twig) {
      const hostTwigDiameter = resolveTwigDiameterAtSegmentT(record.twig, decision.parentShaftId, decision.tClamped);
      if (hostTwigDiameter !== null && hostTwigDiameter > 0) {
        contactCone.profile.bodyDiameterMm = hostTwigDiameter;
        knot.diameter = twigJointDiameterForLocalDiameter(hostTwigDiameter);
      }
    }

    const leaf: Leaf = { id: uuidv4(), modelId: owner, parentKnotId: knot.id, contactCone };
    state.format.leaves.push(leaf);
    state.diagnostics.emitted.leaf = (state.diagnostics.emitted.leaf ?? 0) + 1;
    return;
  }

  // A girder member names its own column height; anything else is a knot-to-cone run.
  const columnHeight = gridColumnHeightMm(node);
  const columnTopZ = columnHeight !== null ? columnHeight - frame.plateDropZ : null;
  const columnJoint: Joint | null = columnTopZ !== null && columnTopZ > knotPos.z
    ? { id: uuidv4(), pos: { x: knotPos.x, y: knotPos.y, z: columnTopZ }, diameter: getJointDiameter(shaftDiameter) }
    : null;

  const segments: Segment[] = columnJoint
    ? [
      { id: uuidv4(), type: 'straight', diameter: shaftDiameter, bottomJoint: undefined, topJoint: columnJoint },
      { id: uuidv4(), type: 'straight', diameter: shaftDiameter, bottomJoint: columnJoint, topJoint: socketJoint },
    ]
    : [{ id: uuidv4(), type: 'straight', diameter: shaftDiameter, bottomJoint: undefined, topJoint: socketJoint }];

  const branch: Branch = { id: uuidv4(), modelId: owner, parentKnotId: knot.id, segments, contactCone };
  state.format.branches.push(branch);

  // Publish so a grandchild can attach: this chain starts at the branch's knot.
  let cursor = knotPos;
  state.hosts.set(node.id, {
    skeleton: {
      kind: 'branch',
      segments: segments.map((seg) => {
        const start = cursor;
        const end = seg.topJoint?.pos ?? getFinalSocketPosition(contactCone);
        cursor = end;
        return { id: seg.id, start, end };
      }),
    },
    segmentDiameter: new Map(segments.map((seg) => [seg.id, seg.diameter ?? shaftDiameter])),
  });
  state.diagnostics.emitted.branch = (state.diagnostics.emitted.branch ?? 0) + 1;
}

/**
 * The host projection a brace uses: not simply the nearest point. A brace
 * endpoint that clamps to a segment's very end is usually a mis-binding, so
 * candidates are penalised for being at an end and for being far from the height
 * their position along the host's own axis implies.
 */
function projectBracePoint(host: HostSkeleton, point: THREE.Vector3): { parentShaftId: string; t: number; pointOnLine: Vec3; segment: HostSegment } | null {
  const segments = host.segments;
  if (segments.length === 0) return null;

  const axisStart = segments[0].start;
  const axisEnd = segments[segments.length - 1].end;
  const ax = axisEnd.x - axisStart.x;
  const ay = axisEnd.y - axisStart.y;
  const az = axisEnd.z - axisStart.z;
  const axisLenSq = ax * ax + ay * ay + az * az;
  const axisAlpha = axisLenSq > 1e-8
    ? Math.min(1, Math.max(0, ((point.x - axisStart.x) * ax + (point.y - axisStart.y) * ay + (point.z - axisStart.z) * az) / axisLenSq))
    : 0;
  const desiredIndex = axisAlpha * (segments.length - 1);

  let best: { id: string; t: number; pointOnLine: Vec3; score: number; segment: HostSegment } | null = null;
  for (let i = 0; i < segments.length; i++) {
    const projection = projectOntoSkeleton(point, [segments[i]]);
    if (!projection) continue;
    const isEndpoint = projection.t <= 0.02 || projection.t >= 0.98;
    const endpointPenalty = isEndpoint ? Math.max(0, projection.distanceMm - 0.35) * 4 + 0.75 : 0;
    const indexPenalty = Math.abs(i - desiredIndex) * 0.25;
    const score = projection.distanceMm + endpointPenalty + indexPenalty;
    if (!best || score < best.score) {
      best = { id: projection.segmentId, t: projection.t, pointOnLine: projection.point, score, segment: segments[i] };
    }
  }
  if (!best) return null;
  return { parentShaftId: best.id, t: best.t, pointOnLine: best.pointOnLine, segment: best.segment };
}

/**
 * A member spanning two hosts: one knot on each, positioned at the AUTHORED
 * endpoints rather than at the projection (projecting both ends squashes a brace
 * whenever a host clamps near a segment boundary). The projections are still what
 * name the shaft and parameter each knot rides.
 *
 * The graph gives the pairing outright — `parentBaseId` names the base end's host
 * and `parentTipId` the tip end's — so the old code's candidate scoring exists
 * only for refs that no longer resolve, which never reach here.
 */
function emitBrace(state: EmitState, node: LysNode): void {
  const hostBaseId = node.hostBaseId;
  const hostTipId = node.hostTipId;
  const hostA = hostBaseId ? state.hosts.get(hostBaseId) : undefined;
  const hostB = hostTipId ? state.hosts.get(hostTipId) : undefined;
  if (!hostA || !hostB) {
    state.diagnostics.skipped.push(`${node.id}: brace ${missingHostReason(state, !hostA ? hostBaseId : hostTipId)}`);
    return;
  }

  const owner = ownerOf(state, node);
  const frame = frameFor(state, owner);
  const pA = frame.transformPoint(node.base);
  const pB = frame.transformPoint(node.tip);
  const projA = projectBracePoint(hostA.skeleton, pA);
  const projB = projectBracePoint(hostB.skeleton, pB);
  if (!projA || !projB) {
    state.diagnostics.skipped.push(`${node.id}: brace host published no skeleton`);
    return;
  }

  const tipDiameter = node.settings?.tip?.diameter;
  const baseTipDiameter = node.settings?.baseTip?.diameter;
  const joinDiameter = node.settings?.base?.joinDiameter;
  const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const braceDiameter = positive(tipDiameter) ?? positive(baseTipDiameter) ?? positive(joinDiameter) ?? 0.5;
  const braceJointDiameter = getJointDiameter(braceDiameter);

  // A brace renders at its knots' diameters, capped by its own profile, so each
  // knot is sized by the shaft it lands on: the brace then tapers to meet each
  // host at that host's thickness. A tapered twig is read at the attach parameter.
  const knotDiameterForHost = (record: HostRecord, shafts: { parentShaftId: string; t: number }): number => {
    if (record.skeleton.kind === 'twig' && record.twig) {
      const local = resolveTwigDiameterAtSegmentT(record.twig, shafts.parentShaftId, shafts.t);
      if (local !== null && local > 0) return twigJointDiameterForLocalDiameter(local);
    }
    const hostShaft = record.segmentDiameter.get(shafts.parentShaftId);
    return hostShaft !== undefined && hostShaft > 0 ? getJointDiameter(hostShaft) : braceJointDiameter;
  };

  const knotA = knotAt(state, projA.parentShaftId, parameterOnSegment(pA, projA.segment), pA, knotDiameterForHost(hostA, projA), 'braceImported');
  const knotB = knotAt(state, projB.parentShaftId, parameterOnSegment(pB, projB.segment), pB, knotDiameterForHost(hostB, projB), 'braceImported');

  const brace: Brace = {
    id: uuidv4(),
    modelId: owner,
    startKnotId: knotA.id,
    endKnotId: knotB.id,
    profile: { diameter: braceDiameter },
  };
  state.format.braces.push(brace);

  // A brace spans its two knots and carries no segment, so it publishes that span
  // under the pseudo-shaft id the runtime parses — braces do host other braces.
  state.hosts.set(node.id, {
    skeleton: {
      kind: 'brace',
      segments: [{ id: knotHostId('brace', brace.id), start: knotA.pos as Vec3, end: knotB.pos as Vec3 }],
    },
    segmentDiameter: new Map([[knotHostId('brace', brace.id), braceDiameter]]),
  });
  state.diagnostics.emitted.brace = (state.diagnostics.emitted.brace ?? 0) + 1;
}

/**
 * The one knot at a site.
 *
 * Endpoints agreeing on shaft, position and diameter are one attachment point, so
 * they are one knot — the identity the old code keyed on for braces and failed to
 * apply anywhere else. The first caller wins the hint when several agree on a
 * site, which on the corpus never differs; the diameter likewise cannot disagree,
 * because a site's diameter comes from the host's own taper at that parameter.
 */
const knotSiteKey = (parentShaftId: string, pos: Vec3, diameter: number | undefined): string => {
  const round = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 'none');
  return `${parentShaftId}|${round(pos.x)},${round(pos.y)},${round(pos.z)}|${round(diameter)}`;
};

/**
 * Claim a site for a knot someone else built (the kickstand builder), keeping its
 * object as-is. Returns the knot already at that site when there is one, so the
 * caller can repoint at it instead of adding a second knot to the same point.
 *
 * The knot is NOT filed in `knots`: a kickstand carries its host knot on the
 * build, and the load path reads it from there. Filing it in both would hand the
 * same object to every pass twice over.
 */
function registerKnot(state: EmitState, knot: Knot): Knot {
  const key = knotSiteKey(knot.parentShaftId, knot.pos as Vec3, knot.diameter);
  const existing = state.knotsBySite.get(key);
  if (existing) return existing;
  state.knotsBySite.set(key, knot);
  return knot;
}

function knotAt(state: EmitState, parentShaftId: string, t: number, pos: Vec3, diameter: number | undefined, hint?: Knot['_importHint']): Knot {
  const existing = state.knotsBySite.get(knotSiteKey(parentShaftId, pos, diameter));
  if (existing) return existing;

  // Only the paths that had a hint stamp one: a knot the kickstand builder made
  // carries none, and inventing one would change how the load path normalizes it.
  const knot: Knot = {
    id: uuidv4(),
    parentShaftId,
    t,
    pos: { ...pos },
    diameter,
    ...(hint ? { _importHint: hint } : {}),
  };
  state.knotsBySite.set(knotSiteKey(parentShaftId, pos, diameter), knot);
  state.format.knots.push(knot);
  return knot;
}

/**
 * A grounded column bracing a shaft: its root stands on the plate at the end that
 * does NOT attach, and its column rises to the host it leans on.
 *
 * Kickstands attach to trunk and branch shafts only — a twig or stick host is not
 * a shaft this contract fits, and a kickstand cannot host another.
 */
function emitKickstand(state: EmitState, node: LysNode): void {
  const hostId = node.hostBaseId ?? node.hostTipId;
  const record = hostId ? state.hosts.get(hostId) : undefined;
  if (!hostId || !record) {
    state.diagnostics.skipped.push(`${node.id}: kickstand ${missingHostReason(state, hostId)}`);
    return;
  }
  const hostKind = record.skeleton.kind;
  if (!isKickstandHostType(hostKind)) {
    state.diagnostics.skipped.push(`${node.id}: kickstand cannot attach to a ${hostKind} host`);
    return;
  }

  const owner = ownerOf(state, node);
  const frame = frameFor(state, owner);
  const pA = frame.transformPoint(node.base);
  const pB = frame.transformPoint(node.tip);
  const attachEnd = resolveAttachEnd(node, record.skeleton, pA, pB);
  const attachPoint = attachEnd === 'base' ? pA : pB;

  // The end that does not attach carries the root, and it stands on the plate, not
  // on the model: a grounded end is authored in plate XY already, so it takes the
  // object's position but not its rotation. Rotating it walks the foot off its grid
  // node by however far the object leans.
  const rootEndpoint = attachEnd === 'base' ? node.tip : node.base;
  const rootBaseWorld = new THREE.Vector3(
    rootEndpoint.x + frame.objectPosition.x,
    rootEndpoint.y + frame.objectPosition.y,
    0,
  );

  // A girder names its column height in plate-space `joinLength`; anything else
  // rises to its own contact. The column stands straight to that height and the
  // terminal segment leans from there to the host.
  const columnJoinLength = gridColumnHeightMm(node);
  const columnTopZ = columnJoinLength !== null ? columnJoinLength - frame.plateDropZ : attachPoint.z;

  const projection = projectOntoSkeleton(attachPoint, record.skeleton.segments);
  if (!projection) {
    state.diagnostics.skipped.push(`${node.id}: host ${hostId} published no skeleton`);
    return;
  }
  const hostDiameterMm = record.segmentDiameter.get(projection.segmentId) ?? state.settings.shaft.diameterMm;

  const build = buildKickstandData({
    modelId: owner,
    // The plate sits a drop below the space the shaft is built in.
    rootPos: { x: rootBaseWorld.x, y: rootBaseWorld.y, z: rootBaseWorld.z - frame.plateDropZ },
    host: {
      segmentId: projection.segmentId,
      supportKind: hostKind,
      t: Math.min(1, Math.max(0, projection.t)),
      pos: projection.point,
      diameterMm: hostDiameterMm,
      minT: 0,
    },
    ...(columnJoinLength !== null
      ? { authoredColumn: { topPos: { x: rootBaseWorld.x, y: rootBaseWorld.y, z: columnTopZ } } }
      : {}),
  });

  // Register the host knot at its site. The builder made a fresh one, so when the
  // site is already taken the column is repointed at the knot that exists rather
  // than adding a second knot to the same point.
  const hostKnot = registerKnot(state, build.hostKnot);
  if (hostKnot.id !== build.hostKnot.id) {
    build.kickstand.hostKnotId = hostKnot.id;
    build.hostKnot = hostKnot;
  }
  state.format.kickstands.push(build);

  // Publish, so a brace can attach to the column — girder members do.
  let cursor: Vec3 = {
    x: build.root.transform.pos.x,
    y: build.root.transform.pos.y,
    z: build.root.transform.pos.z + build.root.diskHeight + build.root.coneHeight,
  };
  const segments: HostSegment[] = build.kickstand.segments.map((seg) => {
    const start = cursor;
    const end = seg.topJoint?.pos ?? build.hostKnot.pos;
    cursor = end;
    return { id: seg.id, start, end };
  });
  state.hosts.set(node.id, {
    skeleton: { kind: 'kickstand', segments },
    segmentDiameter: new Map(build.kickstand.segments.map((seg) => [seg.id, seg.diameter ?? state.settings.shaft.diameterMm])),
  });
  state.diagnostics.emitted.kickstand = (state.diagnostics.emitted.kickstand ?? 0) + 1;
}

const EMITTERS: Partial<Record<SupportClass, (state: EmitState, node: LysNode) => void>> = {
  stick: emitStick,
  twig: emitTwig,
  trunk: emitTrunk,
  branch: emitHosted,
  leaf: emitHosted,
  brace: emitBrace,
  kickstand: emitKickstand,
};

export function emitSupportGraph(
  data: LysData,
  settings: SupportSettings,
  mesh?: THREE.Mesh,
  classifyOptions?: ClassifyOptions,
): { format: EmitFormat; diagnostics: EmitDiagnostics } {
  const graph = buildSupportGraph(data, { strict: false });
  const objects = (data?.objects?.present?.byId ?? {}) as Record<string, LysObject>;
  const firstObject = Object.keys(objects)[0];
  const pivot = (objects[firstObject]?.formerCenter ?? objects[firstObject]?.center ?? { x: 0, y: 0, z: 0 }) as Vec3;

  const format: EmitFormat = {
    version: 1,
    meta: { source: 'lys_conversion', objectCenter: pivot, updatedAt: Date.now() },
    roots: [], trunks: [], branches: [], leaves: [], twigs: [], sticks: [], braces: [], knots: [], kickstands: [],
  };
  const diagnostics: EmitDiagnostics = { emitted: {}, notYetWired: [], skipped: [] };
  const state: EmitState = {
    format,
    settings,
    objects,
    frames: new Map(),
    hosts: new Map(),
    hasChildren: new Set(graph.hostEdges.map((edge) => edge.hostId)),
    knotsBySite: new Map(),
    nodeIds: new Set(graph.nodes.map((n) => n.id)),
    mesh,
    diagnostics,
  };
  if (!firstObject) diagnostics.skipped.push('scene has no objects');

  const options: ClassifyOptions = classifyOptions ?? {
    stickVsTwigCutoffMm: settings.meshToMesh?.stickVsTwigCutoffMm ?? 5,
    defaultTipLengthMm: settings.tip.lengthMm,
  };
  const kindById = new Map<string, SupportClass>();
  const present = new Set<SupportClass>();
  for (const classification of classifySupportGraph(graph, options)) {
    kindById.set(classification.node.id, classification.kind);
    present.add(classification.kind);
  }

  for (const node of emissionOrder(graph)) {
    const kind = kindById.get(node.id);
    if (!kind) continue;
    const emit = EMITTERS[kind];
    if (!emit) continue;
    emit(state, node);
  }

  diagnostics.notYetWired = [...present].filter((kind) => !EMITTERS[kind]).sort();
  return { format, diagnostics };
}
