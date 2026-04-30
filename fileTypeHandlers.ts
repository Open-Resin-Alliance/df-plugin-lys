import * as THREE from 'three';
import type { PluginFileTypeHandler } from '@/features/plugins/pluginFileTypeBridge';
import type { PluginFileTypeDefinition } from '@/features/plugins/complexPluginContracts';
import { LysParser } from './LysParser';
import { LysConverter } from './LysConverter';
import { createDefaultSettings } from '@/supports/Settings/types';
import { computeLowestZ } from '@/utils/geometry';
import { eulerFromGlobalEuler, quaternionFromGlobalEulerDegrees } from '@/utils/rotation';
import { generateUuid } from '@/utils/uuid';

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
};

// ---------------------------------------------------------------------------
// Internal helpers (extracted from the React hook)
// ---------------------------------------------------------------------------

function normalizeLysRotation(
  rotation: { x?: number; y?: number; z?: number } | null | undefined,
) {
  const x = Number.isFinite(rotation?.x) ? (rotation!.x as number) : 0;
  const y = Number.isFinite(rotation?.y) ? (rotation!.y as number) : 0;
  return { x, y, z: 0 };
}

function applySupportZOffset(importData: any, deltaZ: number) {
  if (!importData || !Number.isFinite(deltaZ) || Math.abs(deltaZ) < 1e-6) return;

  const shiftedJointIds = new Set<string>();
  const shiftJoint = (joint: any) => {
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

// ---------------------------------------------------------------------------
// Core import function (plain async — no React state)
// ---------------------------------------------------------------------------

export type LysImportOptions = {
  importCenterXY?: { x: number; y: number } | null;
};

export async function importLysFile(
  file: File,
  options?: LysImportOptions,
): Promise<LysImportPayload> {
  const importCenterX = Number.isFinite(options?.importCenterXY?.x)
    ? Number(options!.importCenterXY!.x)
    : 0;
  const importCenterY = Number.isFinite(options?.importCenterXY?.y)
    ? Number(options!.importCenterXY!.y)
    : 0;

  console.log('[lys-import] Starting LYS import...');
  const data = await LysParser.parse(file);

  console.log('[lys-import] Geometry parsed. Vertices:', data.geometry.getAttribute('position').count);
  console.log('[lys-import] Converting scene data...');

  const settings = createDefaultSettings();
  let dragonfruitData = null;
  const importedModelId = generateUuid();
  let resolvedModelZ: number | null = null;
  let transform = {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };

  if (data.sceneData?.objects && data.sceneData?.supports) {
    const sceneDataForConvert = JSON.parse(JSON.stringify(data.sceneData));
    const convertObjects = sceneDataForConvert?.objects?.present?.byId ?? {};
    for (const key of Object.keys(convertObjects)) {
      convertObjects[key].rotation = normalizeLysRotation(convertObjects[key].rotation);
    }

    const objects = data.sceneData.objects.present.byId;

    let targetObj = objects['o15'];
    if (!targetObj) {
      for (const key in objects) {
        if (objects[key].supportsBase?.length > 0) {
          targetObj = objects[key];
          break;
        }
      }
    }
    if (!targetObj) {
      const firstKey = Object.keys(objects)[0];
      if (firstKey) {
        targetObj = objects[firstKey];
        console.log(`[lys-import] Fallback to first object: ${firstKey}`);
      }
    }

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
      const mesh = new THREE.Mesh(data.geometry, ghostMaterial);
      mesh.position.set(-center.x, -center.y, -center.z);

      ghostGroup.add(mesh);
      ghostGroup.updateMatrixWorld(true);
      mesh.geometry.computeBoundingSphere();
      raycastMesh = mesh;
    }

    dragonfruitData = LysConverter.convert(sceneDataForConvert, settings, raycastMesh);

    if (targetObj && dragonfruitData) {
      const position = targetObj.position ?? { x: 0, y: 0, z: 0 };
      const scale = targetObj.scale ?? { x: 1, y: 1, z: 1 };
      const rot = normalizeLysRotation(targetObj.rotation);
      const objectQuaternion = quaternionFromGlobalEulerDegrees(rot);

      data.geometry.computeBoundingBox();
      const bbox = data.geometry.boundingBox;
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
        const transformedMinZ = computeLowestZ(data.geometry, localTransform);
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
        const r = normalizeLysRotation(targetObj.rotation);
        transform.rotation.copy(eulerFromGlobalEuler({
          x: r.x * Math.PI / 180,
          y: r.y * Math.PI / 180,
          z: r.z * Math.PI / 180,
        }));
      }

      if (targetObj.scale) {
        transform.scale.set(targetObj.scale.x, targetObj.scale.y, targetObj.scale.z);
      }
    }
  } else {
    console.warn('[lys-import] No scene data found or invalid format');
  }

  return {
    modelId: importedModelId,
    geometry: data.geometry,
    transform,
    supportData: dragonfruitData,
  };
}

// ---------------------------------------------------------------------------
// Plugin file-type handler (required export for fileType capability)
// ---------------------------------------------------------------------------

export const handleFileTypeImport: PluginFileTypeHandler = async (
  file: File,
  _fileTypeDefinition: PluginFileTypeDefinition,
) => {
  try {
    const result = await importLysFile(file);
    return { success: true, payload: result satisfies LysImportPayload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[lys-import] Import failed:', err);
    return { success: false, error: message };
  }
};
