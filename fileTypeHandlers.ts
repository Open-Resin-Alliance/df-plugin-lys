import * as THREE from 'three';
import type { PluginFileTypeHandler } from '@/features/plugins/pluginFileTypeBridge';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import type { DragonfruitImportFormat, Joint } from '@/supports/types';
import { hollowFromGeometry, type HollowOptions } from '@/utils/meshHollowing';
import { LysParser } from './LysParser';
import type { LysData, LysObject, LysSupport } from './converter/types';
import { LysConverter } from './LysConverter';
import { createDefaultSettings } from '@/supports/Settings/types';
import { computeLowestZ } from '@/utils/geometry';
import { eulerFromGlobalEuler, quaternionFromGlobalEulerDegrees } from '@/utils/rotation';
import { v4 as uuidv4 } from 'uuid';

/** Base64-encode a typed array for cavity position storage. */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  throw new Error('No base64 encoding available');
}

/**
 * File-type import bridge for `.lys` scene files.
 *
 * Provides a non-React async import path used by the plugin file-type capability.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured result from a successful LYS file import.
 * The host scene manager consumes this payload to create scene objects and
 * load support geometry.
 *
 * Structurally a `PluginSceneImportModel` (see the host's pluginFileTypeBridge):
 * `modelId` is the contract binding this model to its supports. The host uses it
 * as the model id AND stamps it onto every support in `supportData`, so the two
 * must describe the same model. On the multi-object path each payload carries
 * only the supports `buildSupportsByOwner` assigned to that object, resolved
 * from the LYS file's own `objectIdTip`/`objectIdBase`.
 */
export type LysImportPayload = {
  modelId: string;
  /**
   * Display name derived from the object's `name` field in the LYS scene data
   * (e.g. "Archers_Assembled05"). Extension stripped if present. Undefined when
   * the scene object has no name; the host falls back to the project filename.
   */
  objName?: string;
  geometry: THREE.BufferGeometry;
  transform: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  };
  /** DragonFruit internal support format, ready for `loadFromImportFormat`. */
  supportData: ReturnType<typeof LysConverter.convert> | null;
  /** Hollowing configuration and hole punches extracted from LYS scene data. */
  meshModifiers?: ModelMeshModifiers;
};

// ---------------------------------------------------------------------------
// Internal helpers (extracted from the React hook)
// ---------------------------------------------------------------------------

function normalizeLysRotation(
  rotation: { x?: number; y?: number; z?: number } | null | undefined,
) {
  // The converter stage handles X/Y object rotation directly, but Z is applied in a
  // dedicated post-conversion pass to keep support coordinates coherent.
  const x = Number.isFinite(rotation?.x) ? (rotation!.x as number) : 0;
  const y = Number.isFinite(rotation?.y) ? (rotation!.y as number) : 0;
  return { x, y, z: 0 };
}

/**
 * Applies a uniform Z translation to converted support geometry.
 *
 * Used when model min-Z alignment introduces an additional vertical offset after conversion.
 */
function applySupportZOffset(importData: DragonfruitImportFormat | null | undefined, deltaZ: number) {
  if (!importData || !Number.isFinite(deltaZ) || Math.abs(deltaZ) < 1e-6) return;

  const shiftedJointIds = new Set<string>();
  const shiftJoint = (joint: Joint | null | undefined) => {
    if (!joint?.pos) return;
    const key = typeof joint.id === 'string' ? joint.id : null;
    if (key && shiftedJointIds.has(key)) return;
    joint.pos.z += deltaZ;
    if (key) shiftedJointIds.add(key);
  };

  for (const trunk of importData.trunks || []) {
    const socketJointId = trunk?.contactCone?.socketJointId;
    for (const seg of trunk?.segments || []) {
      if (socketJointId) {
        if (seg?.bottomJoint?.id === socketJointId) shiftJoint(seg.bottomJoint);
        if (seg?.topJoint?.id === socketJointId) shiftJoint(seg.topJoint);
      } else {
        shiftJoint(seg?.bottomJoint);
        shiftJoint(seg?.topJoint);
      }
      if (seg?.type === 'bezier') {
        if (seg.controlPoint1) seg.controlPoint1.z += deltaZ;
        if (seg.controlPoint2) seg.controlPoint2.z += deltaZ;
      }
    }
    if (trunk?.contactCone?.pos) trunk.contactCone.pos.z += deltaZ;
  }

  for (const branch of importData.branches || []) {
    for (const seg of branch?.segments || []) {
      shiftJoint(seg?.bottomJoint);
      shiftJoint(seg?.topJoint);
      if (seg?.type === 'bezier') {
        if (seg.controlPoint1) seg.controlPoint1.z += deltaZ;
        if (seg.controlPoint2) seg.controlPoint2.z += deltaZ;
      }
    }
    if (branch?.contactCone?.pos) branch.contactCone.pos.z += deltaZ;
  }

  for (const leaf of importData.leaves || []) {
    if (leaf?.contactCone?.pos) leaf.contactCone.pos.z += deltaZ;
  }

  for (const twig of importData.twigs || []) {
    for (const seg of twig?.segments || []) {
      shiftJoint(seg?.bottomJoint);
      shiftJoint(seg?.topJoint);
      if (seg?.type === 'bezier') {
        if (seg.controlPoint1) seg.controlPoint1.z += deltaZ;
        if (seg.controlPoint2) seg.controlPoint2.z += deltaZ;
      }
    }
    if (twig?.contactDiskA?.pos) twig.contactDiskA.pos.z += deltaZ;
    if (twig?.contactDiskB?.pos) twig.contactDiskB.pos.z += deltaZ;
  }

  for (const stick of importData.sticks || []) {
    for (const seg of stick?.segments || []) {
      shiftJoint(seg?.bottomJoint);
      shiftJoint(seg?.topJoint);
      if (seg?.type === 'bezier') {
        if (seg.controlPoint1) seg.controlPoint1.z += deltaZ;
        if (seg.controlPoint2) seg.controlPoint2.z += deltaZ;
      }
    }
    if (stick?.contactConeA?.pos) stick.contactConeA.pos.z += deltaZ;
    if (stick?.contactConeB?.pos) stick.contactConeB.pos.z += deltaZ;
  }

  for (const knot of importData.knots || []) {
    if (knot?.pos) knot.pos.z += deltaZ;
  }
}

function summarizeImportSupportData(importData: ReturnType<typeof LysConverter.convert> | null | undefined) {
  if (!importData) {
    return {
      roots: 0,
      trunks: 0,
      branches: 0,
      leaves: 0,
      twigs: 0,
      sticks: 0,
      braces: 0,
      knots: 0,
      kickstands: 0,
    };
  }

  return {
    roots: importData.roots?.length ?? 0,
    trunks: importData.trunks?.length ?? 0,
    branches: importData.branches?.length ?? 0,
    leaves: importData.leaves?.length ?? 0,
    twigs: importData.twigs?.length ?? 0,
    sticks: importData.sticks?.length ?? 0,
    braces: importData.braces?.length ?? 0,
    knots: importData.knots?.length ?? 0,
    kickstands: importData.kickstands?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Core import function (plain async — no React state)
// ---------------------------------------------------------------------------

export type LysImportOptions = {
  importCenterXY?: { x: number; y: number } | null;
};

/**
 * Normalizes geometry lookup keys to stem-only lowercase identifiers.
 *
 * Examples:
 * - `o15.bin` -> `o15`
 * - `models/o15.BIN` -> `o15`
 */
export function normalizeGeometryLookupKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  const slash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
  const base = slash >= 0 ? lower.slice(slash + 1) : lower;
  return base.endsWith('.bin') ? base.slice(0, -4) : base;
}

/**
 * Returns the only geometry entry when exactly one normalized key is present.
 *
 * When multiple keys exist but one is a `_hollowing` variant of another
 * (e.g. `9d7a...614` + `9d7a...614_hollowing`), the non-hollowing key is
 * returned as the primary geometry. The `_hollowing` suffix is a Lychee
 * convention for cavity-interior meshes and should never be used as the
 * primary surface for support placement.
 */
function getSingleNormalizedGeometry(
  geometriesByName: Map<string, THREE.BufferGeometry>,
): { key: string; geometry: THREE.BufferGeometry } | null {
  const byNorm = new Map<string, THREE.BufferGeometry>();
  for (const [key, geometry] of geometriesByName) {
    const norm = normalizeGeometryLookupKey(key);
    if (!norm) continue;
    if (!byNorm.has(norm)) byNorm.set(norm, geometry);
  }
  if (byNorm.size === 0) return null;

  // Single entry → trivial return.
  if (byNorm.size === 1) {
    const [key, geometry] = byNorm.entries().next().value as [string, THREE.BufferGeometry];
    return { key, geometry };
  }

  // Multiple entries: prefer the primary (non-hollowing) variant.
  const hollowingSuffix = '_hollowing';
  for (const [norm, geometry] of byNorm) {
    if (norm.endsWith(hollowingSuffix)) continue;
    // Found a non-hollowing key — use it.
    return { key: norm, geometry };
  }

  // All keys are `_hollowing` variants — use the first one.
  const [key, geometry] = byNorm.entries().next().value as [string, THREE.BufferGeometry];
  return { key, geometry };
}

/**
 * Resolves the most likely geometry blob for a scene object.
 *
 * Match priority:
 * 1) direct object id key
 * 2) properties.hash (Lychee UUID field for multi-model scenes)
 * 3) object metadata candidate fields (mesh/model/file/hash-like keys)
 * 4) single-geometry fallback
 */
export function resolveObjectGeometryMatch(
  objId: string,
  obj: Partial<LysObject> | null | undefined,
  geometriesByName: Map<string, THREE.BufferGeometry>,
): { geometry: THREE.BufferGeometry | null; matchSource: string; matchKey?: string } {
  const direct = geometriesByName.get(objId) ?? geometriesByName.get(objId.toLowerCase());
  if (direct) {
    return { geometry: direct, matchSource: 'object-id', matchKey: objId };
  }

  // Lychee stores the geometry UUID in obj.properties.hash for multi-model scenes.
  const propertiesHash = typeof obj?.properties?.hash === 'string'
    ? normalizeGeometryLookupKey(obj.properties.hash)
    : null;
  if (propertiesHash) {
    const byHash = geometriesByName.get(propertiesHash) ?? geometriesByName.get(propertiesHash.toLowerCase());
    if (byHash) {
      return { geometry: byHash, matchSource: 'properties-hash', matchKey: propertiesHash };
    }
  }

  const candidates = new Set<string>();
  const pushCandidate = (v: unknown) => {
    if (v == null) return;
    if (typeof v !== 'string' && typeof v !== 'number') return;
    const normalized = normalizeGeometryLookupKey(String(v));
    if (!normalized) return;
    candidates.add(normalized);
  };

  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        for (const item of value) pushCandidate(item);
        continue;
      }

      if (typeof value === 'string' || typeof value === 'number') {
        pushCandidate(value);

        // Give higher weight to fields that look like mesh/geometry refs.
        if (/(mesh|geom|geometry|model|file|bin|hash|md5)/i.test(key)) {
          pushCandidate(value);
        }
      }
    }
  }

  for (const candidate of candidates) {
    const byCandidate = geometriesByName.get(candidate) ?? geometriesByName.get(candidate.toLowerCase());
    if (byCandidate) {
      return { geometry: byCandidate, matchSource: 'object-field-candidate', matchKey: candidate };
    }
  }

  const single = getSingleNormalizedGeometry(geometriesByName);
  if (single) {
    return {
      geometry: single.geometry,
      matchSource: 'single-shared-geometry-fallback',
      matchKey: single.key,
    };
  }

  return { geometry: null, matchSource: 'none' };
}

/**
 * Derive a display name from a LYS scene object's `name` field.
 * Strips trailing 3D-model extensions so the host shows "Archers_Assembled05"
 * rather than "Archers_Assembled05.stl". Returns undefined when the field is
 * absent or blank so the host can fall back to the project filename.
 */
function deriveModelName(name: unknown): string | undefined {
  const raw = (typeof name === 'string' ? name : '').trim();
  if (!raw) return undefined;
  return raw.replace(/\.(stl|obj|ply|3mf)$/i, '');
}

/** Normalize an LYS objectId field (may be string or number) to a string, or null. */
function normLysObjectId(val: unknown): string | null {
  if (typeof val === 'string' && val.trim()) return val.trim();
  if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  return null;
}

/**
 * Build a map of { ownerObjectId → { supportId → support } } for all supports in the scene.
 * Uses `objectIdTip` / `objectIdBase` on the support. Falls back to `fallbackObjectId`.
 */
function buildSupportsByOwner(
  supports: Record<string, LysSupport>,
  objectIds: Set<string>,
  fallbackObjectId: string,
): Map<string, Record<string, LysSupport>> {
  const result = new Map<string, Record<string, LysSupport>>();
  for (const id of objectIds) result.set(id, {});

  for (const [sid, support] of Object.entries(supports)) {
    const tipId = normLysObjectId(support.objectIdTip);
    const baseId = normLysObjectId(support.objectIdBase);
    const owner =
      (tipId && objectIds.has(tipId) ? tipId : null) ??
      (baseId && objectIds.has(baseId) ? baseId : null) ??
      fallbackObjectId;
    const bucket = result.get(owner);
    if (bucket) bucket[sid] = support;
    else {
      // Fallback owner may not be in objectIds; create bucket
      if (!result.has(owner)) result.set(owner, {});
      result.get(owner)![sid] = support;
    }
  }

  return result;
}

/**
 * Convert a single LYS object and its associated supports into a `LysImportPayload`.
 * `sceneDataForConvert` must already have Z-stripped rotations applied.
 */
function convertSingleObject(
  objId: string,
  rawObj: LysObject,
  objGeometry: THREE.BufferGeometry,
  supportsForObj: Record<string, LysSupport>,
  sceneDataForConvert: LysData,
  settings: ReturnType<typeof createDefaultSettings>,
  importCenterX: number,
  importCenterY: number,
  lysGeometriesByName: Map<string, THREE.BufferGeometry>,
  cavityGeometry?: THREE.BufferGeometry,
): LysImportPayload {
  // Stage 1: prepare filtered object-local scene payload.
  const importedModelId = uuidv4();

  console.log('[lys-import][debug] convertSingleObject:start', {
    objId,
    supportCount: Object.keys(supportsForObj).length,
    geometryVertexCount: objGeometry.getAttribute('position')?.count ?? 0,
    importedModelId,
  });

  // Build a filtered sceneData with only this object and its supports.
  const filteredSceneData = {
    ...sceneDataForConvert,
    objects: { present: { byId: { [objId]: sceneDataForConvert.objects?.present?.byId?.[objId] ?? rawObj } } },
    supports: { present: { byId: supportsForObj } },
  };

  const center = rawObj.formerCenter ?? rawObj.center ?? { x: 0, y: 0, z: 0 };
  const position = rawObj.position ?? { x: 0, y: 0, z: 0 };
  const scale = rawObj.scale ?? { x: 1, y: 1, z: 1 };
  const rot = normalizeLysRotation(rawObj.rotation);
  const objectQuaternion = quaternionFromGlobalEulerDegrees(rot);

  const ghostGroup = new THREE.Group();
  ghostGroup.position.set(0, 0, position.z);
  ghostGroup.scale.set(scale.x, scale.y, scale.z);
  ghostGroup.quaternion.copy(objectQuaternion);

  const ghostMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const ghostMesh = new THREE.Mesh(objGeometry, ghostMaterial);
  ghostMesh.position.set(-center.x, -center.y, -center.z);
  ghostGroup.add(ghostMesh);
  ghostGroup.updateMatrixWorld(true);
  ghostMesh.geometry.computeBoundingSphere();

  const dragonfruitData = LysConverter.convert(filteredSceneData, settings, ghostMesh);
  ghostMaterial.dispose();

  // Stage 2: solve model Z from transformed geometry min-Z + LYS lift.
  let resolvedModelZ: number | null = null;
  {
    objGeometry.computeBoundingBox();
    const bbox = objGeometry.boundingBox;
    if (bbox) {
      const geomCenter = bbox.getCenter(new THREE.Vector3());
      const rotationScale = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, 0),
        objectQuaternion,
        new THREE.Vector3(scale.x || 1, scale.y || 1, scale.z || 1),
      );
      const centerOffset = new THREE.Matrix4().makeTranslation(-geomCenter.x, -geomCenter.y, -geomCenter.z);
      const localTransform = rotationScale.clone().multiply(centerOffset);
      const lysLiftZ = Number.isFinite(position.z) ? position.z : 0;
      const transformedMinZ = computeLowestZ(objGeometry, localTransform);
      const finalModelZ = lysLiftZ - transformedMinZ;
      resolvedModelZ = finalModelZ;
      const supportDeltaZ = finalModelZ - lysLiftZ;
      if (Number.isFinite(supportDeltaZ) && Math.abs(supportDeltaZ) > 1e-6) {
        applySupportZOffset(dragonfruitData, supportDeltaZ);
        console.log(`[lys-import] Object ${objId}: applied support Z offset: ${supportDeltaZ.toFixed(3)}mm`);
      }
    }
  }

  LysConverter.reassignModelId(dragonfruitData, importedModelId);

  // Stage 3: apply deferred Z rotation + optional world XY placement.
  const rotZDeg = Number.isFinite(rawObj.rotation?.z) ? (rawObj.rotation?.z as number) : 0;
  if (Math.abs(rotZDeg) > 1e-6) {
    LysConverter.applyZRotation(dragonfruitData, position.x, position.y, rotZDeg * Math.PI / 180);
    console.log(`[lys-import] Object ${objId}: applied Z rotation: ${rotZDeg.toFixed(3)}°`);
  }

  if (Math.abs(importCenterX) > 1e-6 || Math.abs(importCenterY) > 1e-6) {
    LysConverter.applyWorldXYPlacement(dragonfruitData, importCenterX, importCenterY);
  }

  const finalModelZ = Number.isFinite(resolvedModelZ) ? (resolvedModelZ as number) : (position.z ?? 0);
  const transform = {
    position: new THREE.Vector3((position.x ?? 0) + importCenterX, (position.y ?? 0) + importCenterY, finalModelZ),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(scale.x, scale.y, scale.z),
  };

  if (rawObj.rotation) {
    const rXY = normalizeLysRotation(rawObj.rotation);
    transform.rotation.copy(eulerFromGlobalEuler({
      x: rXY.x * Math.PI / 180,
      y: rXY.y * Math.PI / 180,
      z: rotZDeg * Math.PI / 180,
    }));
  }

  console.log('[lys-import][debug] convertSingleObject:done', {
    objId,
    importedModelId,
    transform: {
      position: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
      rotation: { x: transform.rotation.x, y: transform.rotation.y, z: transform.rotation.z },
      scale: { x: transform.scale.x, y: transform.scale.y, z: transform.scale.z },
    },
    supportSummary: summarizeImportSupportData(dragonfruitData),
  });

  const meshModifiers = LysConverter.convertHollowing(
    sceneDataForConvert, objGeometry, lysGeometriesByName, undefined,
    { objectId: objId, cavityGeometry },
  );
  console.log('[lys-import][debug] convertSingleObject meshModifiers:', meshModifiers ? `hollowing=${!!meshModifiers.hollowing} holes=${meshModifiers.holePunches?.length ?? 0}` : 'undefined');

  return {
    modelId: importedModelId,
    objName: deriveModelName(rawObj.name),
    geometry: objGeometry,
    transform,
    supportData: dragonfruitData,
    meshModifiers,
  };
}

export async function importLysFile(
  file: File,
  options?: LysImportOptions,
): Promise<LysImportPayload | LysImportPayload[]> {
  // Parse options up front so both single-model and multi-model branches share behavior.
  const importCenterX = Number.isFinite(options?.importCenterXY?.x)
    ? Number(options!.importCenterXY!.x)
    : 0;
  const importCenterY = Number.isFinite(options?.importCenterXY?.y)
    ? Number(options!.importCenterXY!.y)
    : 0;

  console.log('[lys-import] Starting LYS import...');
  const data = await LysParser.parse(file);

  console.log('[lys-import] Geometry parsed. Vertices:', data.geometry.getAttribute('position').count);
  console.log('[lys-import] Geometries by name:', [...data.geometriesByName.keys()]);
  console.log('[lys-import] Converting scene data...');

  const settings = createDefaultSettings();

  if (!data.sceneData?.objects || !data.sceneData?.supports) {
    console.warn('[lys-import] No scene data found or invalid format');
    return {
      modelId: uuidv4(),
      geometry: data.geometry,
      transform: {
        position: new THREE.Vector3(0, 0, 0),
        rotation: new THREE.Euler(0, 0, 0),
        scale: new THREE.Vector3(1, 1, 1),
      },
      supportData: null,
      meshModifiers: LysConverter.convertHollowing(data.sceneData, data.geometry, data.geometriesByName),
    };
  }

  console.log('[lys-import][debug] After parser — sceneData keys:', Object.keys(data.sceneData ?? {}).join(', '));
  console.log('[lys-import][debug] sceneData.objects?.present?.byId keys:', Object.keys(data.sceneData?.objects?.present?.byId ?? {}).join(', ') || '(none)');

  const objects: Record<string, LysObject> = data.sceneData.objects?.present?.byId ?? {};
  const supports: Record<string, LysSupport> = data.sceneData.supports?.present?.byId ?? {};

  const sceneObjectIds = Object.keys(objects);
  console.log('[lys-import][debug] scene summary', {
    objectCount: sceneObjectIds.length,
    supportCount: Object.keys(supports).length,
    objectIds: sceneObjectIds,
    geometryKeys: [...data.geometriesByName.keys()],
  });

  // Clone scene data and strip Z rotation for the converter (Z is applied post-conversion).
  const sceneDataForConvert = JSON.parse(JSON.stringify(data.sceneData));
  const convertObjects = sceneDataForConvert?.objects?.present?.byId ?? {};
  for (const key of Object.keys(convertObjects)) {
    convertObjects[key].rotation = normalizeLysRotation(convertObjects[key].rotation);
  }

  // Resolve object->geometry mapping, including heuristic fallbacks.
  const objectsWithGeometry: Array<{
    id: string;
    obj: LysObject;
    geometry: THREE.BufferGeometry;
    matchSource: string;
    matchKey?: string;
  }> = [];
  for (const [objId, obj] of Object.entries(objects)) {
    const match = resolveObjectGeometryMatch(objId, obj, data.geometriesByName);
    if (match.geometry) {
      objectsWithGeometry.push({
        id: objId,
        obj,
        geometry: match.geometry,
        matchSource: match.matchSource,
        matchKey: match.matchKey,
      });
    }
  }

  const matchedObjectIdSet = new Set(objectsWithGeometry.map((o) => o.id));
  const unmatchedObjectIds = sceneObjectIds.filter((id) => !matchedObjectIdSet.has(id));

  console.log(`[lys-import] Objects with named geometry: ${objectsWithGeometry.map((o) => o.id).join(', ') || '(none)'}`);
  if (unmatchedObjectIds.length > 0) {
    console.warn('[lys-import][debug] objects missing matching geometry entry', {
      unmatchedObjectIds,
      availableGeometryKeys: [...data.geometriesByName.keys()],
    });
  }

  if (objectsWithGeometry.length > 0) {
    console.log('[lys-import][debug] object geometry match details', objectsWithGeometry.map((o) => ({
      objectId: o.id,
      matchSource: o.matchSource,
      matchKey: o.matchKey ?? null,
      geometryVertexCount: o.geometry.getAttribute('position')?.count ?? 0,
    })));
  }

  // -----------------------------------------------------------------------
  // Manifest-order geometry assignment fallback.
  //
  // When per-object field matching fails for all objects (every entry uses the
  // single-shared-geometry-fallback — i.e. all get model 1's mesh), and the
  // manifest recorded at least as many geometry files as there are scene objects,
  // assign by position: geometryOrder[i] → objectsWithGeometry[i].
  //
  // This works because Lychee writes geometry files to the manifest in the same
  // order it serializes objects in scene.bin. Object.entries() over the decoded
  // scene data preserves that serialization order, so objectsWithGeometry[i]
  // corresponds to geometryOrder[i] without any additional sorting.
  //
  // NOTE: do NOT sort objectsWithGeometry by numeric object ID here — that breaks
  // files where Lychee's creation order differs from internal ID order (e.g. a
  // scene where object "o3" was created before "o2").
  // -----------------------------------------------------------------------
  if (
    objectsWithGeometry.length > 1 &&
    data.geometryOrder.length >= objectsWithGeometry.length &&
    objectsWithGeometry.every((o) => o.matchSource === 'single-shared-geometry-fallback')
  ) {
    objectsWithGeometry.forEach((entry, idx) => {
      const stem = data.geometryOrder[idx];
      const geom = data.geometriesByName.get(stem) ?? data.geometriesByName.get(stem.toLowerCase());
      if (geom) {
        entry.geometry = geom;
        entry.matchSource = 'manifest-order-assignment';
        entry.matchKey = stem;
      }
    });
  }

  // -----------------------------------------------------------------------
  // Multi-model path: each object gets an independent payload.
  // -----------------------------------------------------------------------
  if (objectsWithGeometry.length > 1) {
    console.log('[lys-import][debug] entering multi-model import path', {
      modelCount: objectsWithGeometry.length,
      modelIds: objectsWithGeometry.map((o) => o.id),
    });

    const objectIds = new Set(objectsWithGeometry.map((o) => o.id));
    const fallbackId = objectsWithGeometry[0].id;
    const supportsByOwner = buildSupportsByOwner(supports, objectIds, fallbackId);

    const payloads: LysImportPayload[] = [];
    for (const { id: objId, obj, geometry: objGeom, matchKey } of objectsWithGeometry) {
      const supportsForObj = supportsByOwner.get(objId) ?? {};
      console.log(`[lys-import] Object ${objId}: ${Object.keys(supportsForObj).length} supports`);
      // This object's own cavity mesh (Lychee names it `<geometry-stem>_hollowing`).
      // Passed through so tilted-hole drill signs resolve against the right cavity.
      const cavityGeometry = matchKey
        ? data.geometriesByName.get(`${matchKey}_hollowing`)
          ?? data.geometriesByName.get(`${matchKey.toLowerCase()}_hollowing`)
        : undefined;
      const payload = convertSingleObject(
        objId, obj, objGeom, supportsForObj,
        sceneDataForConvert, settings, 0, 0, // no center shift for multi-model
        data.geometriesByName, cavityGeometry,
      );
      payloads.push(payload);
    }

    console.log('[lys-import][debug] multi-model payloads generated', {
      payloadCount: payloads.length,
      modelIds: payloads.map((p) => p.modelId),
      objNames: payloads.map((p) => p.objName ?? '(none)'),
      supportSummaries: payloads.map((p) => ({ modelId: p.modelId, ...summarizeImportSupportData(p.supportData) })),
    });

    return payloads;
  }

  console.log('[lys-import][debug] entering single-model import path', {
    reason: objectsWithGeometry.length === 1
      ? 'exactly_one_object_with_named_geometry'
      : 'no_named_geometry_matches_found',
    objectsWithGeometryCount: objectsWithGeometry.length,
  });

  // -----------------------------------------------------------------------
  // Single-model path (legacy behavior compatibility branch).
  // -----------------------------------------------------------------------
  let targetObj: LysObject | null = null;
  let targetObjId: string | null = null;

  if (objectsWithGeometry.length === 1) {
    targetObj = objectsWithGeometry[0].obj;
    targetObjId = objectsWithGeometry[0].id;
  } else {
    // No named geometry found — fall back to largest blob + first supported object
    targetObjId = 'o15';
    targetObj = objects['o15'] ?? null;
    if (!targetObj) {
      for (const key in objects) {
        if ((objects[key].supportsBase?.length ?? 0) > 0) {
          targetObj = objects[key];
          targetObjId = key;
          break;
        }
      }
    }
    if (!targetObj) {
      const firstKey = Object.keys(objects)[0];
      if (firstKey) {
        targetObj = objects[firstKey];
        targetObjId = firstKey;
        console.log(`[lys-import] Fallback to first object: ${firstKey}`);
      }
    }
  }

  let singleGeom =
    (targetObjId ? data.geometriesByName.get(targetObjId) ?? data.geometriesByName.get(targetObjId.toLowerCase()) : null)
    ?? data.geometry;

  const importedModelId = uuidv4();
  let resolvedModelZ: number | null = null;
  const transform = {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };

  let raycastMesh: THREE.Mesh | undefined;
  let ghostMaterial: THREE.Material | undefined;
  if (targetObj) {
    const center = targetObj.formerCenter ?? targetObj.center ?? { x: 0, y: 0, z: 0 };
    const position = targetObj.position ?? { x: 0, y: 0, z: 0 };
    const scale = targetObj.scale ?? { x: 1, y: 1, z: 1 };
    const rot = normalizeLysRotation(targetObj.rotation);
    const objectQuaternion = quaternionFromGlobalEulerDegrees(rot);

    const ghostGroup = new THREE.Group();
    ghostGroup.position.set(0, 0, position.z);
    ghostGroup.scale.set(scale.x, scale.y, scale.z);
    ghostGroup.quaternion.copy(objectQuaternion);

    ghostMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(singleGeom, ghostMaterial);
    mesh.position.set(-center.x, -center.y, -center.z);

    ghostGroup.add(mesh);
    ghostGroup.updateMatrixWorld(true);
    mesh.geometry.computeBoundingSphere();
    raycastMesh = mesh;
  }

  const dragonfruitData = LysConverter.convert(sceneDataForConvert, settings, raycastMesh);

  if (targetObj && dragonfruitData) {
    const position = targetObj.position ?? { x: 0, y: 0, z: 0 };
    const scale = targetObj.scale ?? { x: 1, y: 1, z: 1 };
    const rot = normalizeLysRotation(targetObj.rotation);
    const objectQuaternion = quaternionFromGlobalEulerDegrees(rot);

    singleGeom.computeBoundingBox();
    const bbox = singleGeom.boundingBox;
    if (bbox) {
      const geomCenter = bbox.getCenter(new THREE.Vector3());
      const rotationScale = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, 0),
        objectQuaternion,
        new THREE.Vector3(scale.x || 1, scale.y || 1, scale.z || 1),
      );
      const centerOffset = new THREE.Matrix4().makeTranslation(-geomCenter.x, -geomCenter.y, -geomCenter.z);
      const localTransform = rotationScale.clone().multiply(centerOffset);

      const lysLiftZ = Number.isFinite(position.z) ? position.z : 0;
      const transformedMinZ = computeLowestZ(singleGeom, localTransform);
      const finalModelZ = lysLiftZ - transformedMinZ;
      resolvedModelZ = finalModelZ;
      const supportDeltaZ = finalModelZ - lysLiftZ;

      if (Number.isFinite(supportDeltaZ) && Math.abs(supportDeltaZ) > 1e-6) {
        applySupportZOffset(dragonfruitData, supportDeltaZ);
        console.log(`[lys-import] Applied support Z offset: ${supportDeltaZ.toFixed(3)}mm`);
      }
    }
  }

  if (dragonfruitData) {
    LysConverter.reassignModelId(dragonfruitData, importedModelId);

    const objPos = targetObj?.position ?? { x: 0, y: 0, z: 0 };
    const rotZDeg = Number.isFinite(targetObj?.rotation?.z) ? (targetObj!.rotation!.z as number) : 0;
    if (Math.abs(rotZDeg) > 1e-6) {
      LysConverter.applyZRotation(dragonfruitData, objPos.x, objPos.y, rotZDeg * Math.PI / 180);
      console.log(`[lys-import] Applied Z rotation: ${rotZDeg.toFixed(3)}°`);
    }

    if (Math.abs(importCenterX) > 1e-6 || Math.abs(importCenterY) > 1e-6) {
      LysConverter.applyWorldXYPlacement(dragonfruitData, importCenterX, importCenterY);
    }
  }

  if (ghostMaterial) ghostMaterial.dispose();

  if (targetObj) {
    const finalModelZ = Number.isFinite(resolvedModelZ)
      ? (resolvedModelZ as number)
      : (targetObj.position?.z ?? 0);

    transform.position.set(
      (targetObj.position?.x ?? 0) + importCenterX,
      (targetObj.position?.y ?? 0) + importCenterY,
      finalModelZ,
    );

    if (targetObj.rotation) {
      const rXY = normalizeLysRotation(targetObj.rotation);
      const rotZDeg = Number.isFinite(targetObj.rotation.z) ? (targetObj.rotation.z as number) : 0;
      transform.rotation.copy(eulerFromGlobalEuler({
        x: rXY.x * Math.PI / 180,
        y: rXY.y * Math.PI / 180,
        z: rotZDeg * Math.PI / 180,
      }));
    }

    if (targetObj.scale) {
      transform.scale.set(targetObj.scale.x, targetObj.scale.y, targetObj.scale.z);
    }
  }

  const finalMeshModifiers = LysConverter.convertHollowing(sceneDataForConvert, singleGeom, data.geometriesByName, data.isLegacyGeometry);
  console.log('[lys-import][debug] single-model meshModifiers:', finalMeshModifiers ? `hollowing=${!!finalMeshModifiers.hollowing} holes=${finalMeshModifiers.holePunches?.length ?? 0}` : 'undefined');

  // ── Physically hollow the geometry when the Rust backend is available ──
  // Instead of leaving the model solid + a separate cavity mesh, call the
  // voxel engine right here so the model loads as physically hollowed.
  // The original solid geometry is snapshotted so "Remove Hollowing" can
  // restore it later.
  if (finalMeshModifiers?.hollowing?.enabled && singleGeom.boundingBox) {
    const bboxSize = singleGeom.boundingBox.getSize(new THREE.Vector3());
    const maxExtent = Math.max(bboxSize.x, bboxSize.y, bboxSize.z);
    const shellThickness = finalMeshModifiers.hollowing.shellThicknessMm ?? 2;

    // Simple voxel resolution: aim for ~0.5mm voxels relative to model size.
    const voxelResolution = Math.max(32, Math.min(256,
      Math.round(maxExtent / (finalMeshModifiers.hollowing.voxelSizeMm ?? 0.5))
    ));

    // Snapshot the original solid geometry for later "Remove Hollowing".
    const posAttr = singleGeom.getAttribute('position');
    if (posAttr) {
      const srcFloats = posAttr.array instanceof Float32Array
        ? posAttr.array
        : new Float32Array(posAttr.array);
      const srcBytes = new Uint8Array(srcFloats.buffer, srcFloats.byteOffset, srcFloats.byteLength);
      finalMeshModifiers.hollowing!.sourcePositionsBase64 = bytesToBase64(srcBytes);
      finalMeshModifiers.hollowing!.sourcePositionCount = posAttr.count;
    }

    const hollowOptions: HollowOptions = {
      mode: finalMeshModifiers.hollowing.mode === 'shell_open_face' ? 'cavity' : finalMeshModifiers.hollowing.mode,
      voxelResolution,
      shellThicknessMm: shellThickness,
      infillMode: finalMeshModifiers.hollowing.infillMode ?? 'lattice',
      infillCellMm: finalMeshModifiers.hollowing.infillCellMm ?? 5,
      infillBeamRadiusMm: finalMeshModifiers.hollowing.infillBeamRadiusMm ?? 0.5,
      openFace: finalMeshModifiers.hollowing.openFace,
      drainHoles: [],
      previewCavityOnly: false,
      // Re-hollow with full smoothing — the Lychee pre-computed cavity is
      // not used for the boolean merge, so we need the same Taubin + chamfer
      // passes as native DF hollowing to avoid a blocky voxel-isosurface look.
      smoothInternalSurfaces: true,
      internalChamferPasses: 2,
    };

    try {
      console.log('[lys-import] Applying voxel hollowing with shellThickness:', shellThickness);
      const hollowResult = await hollowFromGeometry(singleGeom, hollowOptions);
      if (hollowResult) {
        console.log('[lys-import] Hollowing succeeded — replacing geometry');
        const hollowedGeometry = new THREE.BufferGeometry();
        hollowedGeometry.setAttribute('position', new THREE.BufferAttribute(hollowResult.positions, 3));
        hollowedGeometry.computeVertexNormals();
        hollowedGeometry.computeBoundingBox();
        singleGeom = hollowedGeometry;

        // Store cavity positions from the Rust engine for Interior View.
        if (hollowResult.cavityPositions) {
          const bytes = new Uint8Array(
            hollowResult.cavityPositions.buffer,
            hollowResult.cavityPositions.byteOffset,
            hollowResult.cavityPositions.byteLength,
          );
          finalMeshModifiers.hollowing!.cavityPositionsBase64 = bytesToBase64(bytes);
          finalMeshModifiers.hollowing!.cavityPositionCount = hollowResult.cavityPositions.length / 3;
        }
        finalMeshModifiers.hollowing!.bakedIntoGeometry = true;
        console.log('[lys-import] Hollowing applied — new vertex count:', hollowResult.positions.length / 3);
      }
    } catch (err) {
      console.warn('[lys-import] Voxel hollowing failed (likely browser mode), using cavity-only approach:', err);
    }
  }

  console.log('[lys-import][debug] single-model payload generated', {
    targetObjId,
    importedModelId,
    supportSummary: summarizeImportSupportData(dragonfruitData),
  });

  return {
    modelId: importedModelId,
    // Single-model path needs objName too: a one-object .lys still carries the
    // object's own name, and without this the host falls back to the project
    // filename. The multi-object path gets it via convertSingleObject.
    objName: deriveModelName(convertObjects?.[targetObjId]?.name),
    geometry: singleGeom,
    transform,
    supportData: dragonfruitData,
    meshModifiers: finalMeshModifiers,
  };
}
// ---------------------------------------------------------------------------
// Plugin file-type handler (required export for fileType capability)
// ---------------------------------------------------------------------------

export const handleFileTypeImport: PluginFileTypeHandler = async (file: File) => {
  try {
    const result = await importLysFile(file);
    return { success: true, payload: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[lys-import] Import failed:', err);
    return { success: false, error: message };
  }
};
