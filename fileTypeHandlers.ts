import * as THREE from 'three';
import type { PluginFileTypeHandler } from '@/features/plugins/pluginFileTypeBridge';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import type { DragonfruitImportFormat } from '@/supports/types';
import { LysParser } from './LysParser';
import type { LysData, LysObject, LysSupport } from './converter/types';
import { LysConverter } from './LysConverter';
import { normLysObjectId } from './converter/helpers';
import { visitSupportGeometry } from './converter/supportTraversal';
import { createDefaultSettings } from '@/supports/Settings/types';
import { computeLowestZ } from '@/utils/geometry';
import { eulerFromGlobalEuler, quaternionFromGlobalEulerDegrees } from '@/utils/rotation';
import { v4 as uuidv4 } from 'uuid';

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
 */
export type LysImportPayload = {
  modelId: string;
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
  /** The geometry is model-only; supports arrive separately in supportData. */
  skipClassification: true;
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
  visitSupportGeometry(importData, { position: (pos) => { pos.z += deltaZ; } });
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
  isLegacyGeometry?: boolean,
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
    sceneDataForConvert, objGeometry, lysGeometriesByName, isLegacyGeometry,
    { objectId: objId, cavityGeometry },
  );
  console.log('[lys-import][debug] convertSingleObject meshModifiers:', meshModifiers ? `hollowing=${!!meshModifiers.hollowing} holes=${meshModifiers.holePunches?.length ?? 0}` : 'undefined');

  return {
    modelId: importedModelId,
    geometry: objGeometry,
    transform,
    supportData: dragonfruitData,
    meshModifiers,
    skipClassification: true,
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
      skipClassification: true,
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

  // Copy only what the converter mutates: the object records whose Z rotation
  // is stripped for conversion (Z is applied to the whole model afterwards).
  // A deep clone here copied every support and hole record in the file.
  const sourceObjects = data.sceneData.objects?.present?.byId ?? {};
  const convertObjects: Record<string, LysObject> = {};
  for (const [key, object] of Object.entries(sourceObjects)) {
    convertObjects[key] = {
      ...object,
      rotation: normalizeLysRotation(object.rotation),
    };
  }
  const sceneDataForConvert: LysData = {
    ...data.sceneData,
    objects: {
      ...data.sceneData.objects,
      present: {
        ...data.sceneData.objects?.present,
        byId: convertObjects,
      },
    },
  };

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
  // One payload per object, whatever the count. A scene whose geometry never
  // matched by name still converts: the whole blob becomes one object, chosen
  // below, so there is a single conversion path to keep correct.
  // -----------------------------------------------------------------------
  const targets = objectsWithGeometry.length > 0
    ? objectsWithGeometry
    : (() => {
      // Nothing matched by name. The first object carrying supports is the model,
      // falling back to the first object at all, and it takes the whole blob.
      const fallbackId = Object.keys(objects).find((key) => (objects[key].supportsBase?.length ?? 0) > 0)
        ?? Object.keys(objects)[0];
      if (!fallbackId) return [];
      console.log(`[lys-import] No named geometry matched; converting ${fallbackId} against the whole blob`);
      return [{
        id: fallbackId,
        obj: objects[fallbackId],
        geometry: data.geometry,
        matchKey: undefined as string | undefined,
        matchSource: 'unmatched-whole-blob' as const,
      }];
    })();

  if (targets.length === 0) {
    throw new Error('LYS import: no object to convert');
  }

  console.log('[lys-import][debug] converting', {
    modelCount: targets.length,
    modelIds: targets.map((o) => o.id),
  });

  const objectIds = new Set(targets.map((o) => o.id));
  const supportsByOwner = buildSupportsByOwner(supports, objectIds, targets[0].id);

  const payloads: LysImportPayload[] = [];
  for (const { id: objId, obj, geometry: objGeom, matchKey } of targets) {
    const supportsForObj = supportsByOwner.get(objId) ?? {};
    console.log(`[lys-import] Object ${objId}: ${Object.keys(supportsForObj).length} supports`);
    // This object's own cavity mesh (Lychee names it `<geometry-stem>_hollowing`).
    // Passed through so tilted-hole drill signs resolve against the right cavity.
    const cavityGeometry = matchKey
      ? data.geometriesByName.get(`${matchKey}_hollowing`)
        ?? data.geometriesByName.get(`${matchKey.toLowerCase()}_hollowing`)
      : undefined;
    payloads.push(convertSingleObject(
      objId, obj, objGeom, supportsForObj,
      sceneDataForConvert, settings,
      // A multi-object scene lays its models out by their own positions, so only
      // a lone model takes the caller's centre.
      targets.length === 1 ? importCenterX : 0,
      targets.length === 1 ? importCenterY : 0,
      data.geometriesByName, cavityGeometry, data.isLegacyGeometry,
    ));
  }

  console.log('[lys-import][debug] payloads generated', {
    payloadCount: payloads.length,
    modelIds: payloads.map((p) => p.modelId),
    supportSummaries: payloads.map((p) => ({ modelId: p.modelId, ...summarizeImportSupportData(p.supportData) })),
  });

  return payloads.length === 1 ? payloads[0] : payloads;
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
