import * as THREE from 'three';
import {
  DragonfruitImportFormat,
  Joint,
} from '@/supports/types';
import { SupportSettings } from '@/supports/Settings';
import type {
  ModelMeshModifiers,
  ModelHollowingModifier,
  ModelHolePunchPlacement,
} from '@/features/mesh-modifiers/types';
import { convertLysData } from './converter/convertLysData';
import { LysData } from './converter/types';

/** Base64-encode a typed array for storage in meshModifiers. */
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
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  throw new Error('No base64 encoding available');
}

/**
 * High-level adapter between raw parsed LYS data and DragonFruit import payloads.
 *
 * This class intentionally keeps conversion orchestration separate from parser logic
 * and scene integration hooks.
 */

export class LysConverter {

  /** Produces compact entity counts for debug logs and diagnostics. */
  private static summarizeConvertedData(data: DragonfruitImportFormat) {
    return {
      roots: data.roots?.length ?? 0,
      trunks: data.trunks?.length ?? 0,
      branches: data.branches?.length ?? 0,
      leaves: data.leaves?.length ?? 0,
      twigs: data.twigs?.length ?? 0,
      sticks: data.sticks?.length ?? 0,
      braces: data.braces?.length ?? 0,
      knots: data.knots?.length ?? 0,
      kickstands: data.kickstands?.length ?? 0,
    };
  }

  /** Collects every model id referenced anywhere inside converted support payloads. */
  private static collectModelIds(data: DragonfruitImportFormat): string[] {
    const ids = new Set<string>();
    for (const root of data.roots || []) if (root?.modelId) ids.add(root.modelId);
    for (const trunk of data.trunks || []) if (trunk?.modelId) ids.add(trunk.modelId);
    for (const branch of data.branches || []) if (branch?.modelId) ids.add(branch.modelId);
    for (const leaf of data.leaves || []) if (leaf?.modelId) ids.add(leaf.modelId);
    for (const twig of data.twigs || []) if (twig?.modelId) ids.add(twig.modelId);
    for (const stick of data.sticks || []) if (stick?.modelId) ids.add(stick.modelId);
    for (const brace of data.braces || []) if (brace?.modelId) ids.add(brace.modelId);
    for (const kickstandBuild of data.kickstands || []) {
      if (kickstandBuild?.root?.modelId) ids.add(kickstandBuild.root.modelId);
      if (kickstandBuild?.kickstand?.modelId) ids.add(kickstandBuild.kickstand.modelId);
    }
    return [...ids];
  }

  /**
   * Rewrites all converted entities to a single target model id.
   * Used after conversion when importing into a freshly created scene model.
   */
  static reassignModelId(data: DragonfruitImportFormat, modelId: string): void {
    if (!modelId) return;

    const beforeModelIds = this.collectModelIds(data);

    for (const root of data.roots) root.modelId = modelId;
    for (const trunk of data.trunks) trunk.modelId = modelId;
    for (const branch of data.branches) branch.modelId = modelId;
    for (const leaf of data.leaves) leaf.modelId = modelId;
    for (const twig of data.twigs || []) twig.modelId = modelId;
    for (const stick of data.sticks || []) stick.modelId = modelId;
    for (const brace of data.braces) brace.modelId = modelId;
    for (const kickstandBuild of data.kickstands || []) {
      kickstandBuild.root.modelId = modelId;
      kickstandBuild.kickstand.modelId = modelId;
    }

    console.log('[LysConverter][debug] reassignModelId', {
      targetModelId: modelId,
      beforeModelIds,
      afterModelIds: this.collectModelIds(data),
      supportSummary: this.summarizeConvertedData(data),
    });
  }

  /**
   * Applies world-space XY offset to every converted support entity.
   */
  static applyWorldXYPlacement(data: DragonfruitImportFormat, offsetX: number, offsetY: number): void {
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return;
    if (Math.abs(offsetX) < 1e-8 && Math.abs(offsetY) < 1e-8) return;

    const shiftedJointIds = new Set<string>();

    const shiftPos = (pos?: { x: number; y: number }) => {
      if (!pos) return;
      pos.x += offsetX;
      pos.y += offsetY;
    };

    const shiftJoint = (joint?: Joint) => {
      if (!joint?.pos) return;
      if (shiftedJointIds.has(joint.id)) return;
      joint.pos.x += offsetX;
      joint.pos.y += offsetY;
      shiftedJointIds.add(joint.id);
    };

    for (const root of data.roots) {
      shiftPos(root.transform?.pos);
    }

    for (const trunk of data.trunks) {
      for (const seg of trunk.segments) {
        shiftJoint(seg.bottomJoint);
        shiftJoint(seg.topJoint);
        if (seg.type === 'bezier') {
          shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
          shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
        }
      }
      shiftPos(trunk.contactCone?.pos);
    }

    for (const branch of data.branches) {
      for (const seg of branch.segments) {
        shiftJoint(seg.bottomJoint);
        shiftJoint(seg.topJoint);
        if (seg.type === 'bezier') {
          shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
          shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
        }
      }
      shiftPos(branch.contactCone?.pos);
    }

    for (const leaf of data.leaves) {
      shiftPos(leaf.contactCone?.pos);
    }

    for (const twig of data.twigs || []) {
      for (const seg of twig.segments) {
        shiftJoint(seg.bottomJoint);
        shiftJoint(seg.topJoint);
        if (seg.type === 'bezier') {
          shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
          shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
        }
      }
      shiftPos(twig.contactDiskA?.pos);
      shiftPos(twig.contactDiskB?.pos);
    }

    for (const stick of data.sticks || []) {
      for (const seg of stick.segments) {
        shiftJoint(seg.bottomJoint);
        shiftJoint(seg.topJoint);
        if (seg.type === 'bezier') {
          shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
          shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
        }
      }
      shiftPos(stick.contactConeA?.pos);
      shiftPos(stick.contactConeB?.pos);
    }

    for (const knot of data.knots) {
      shiftPos(knot.pos);
    }

    for (const kickstandBuild of data.kickstands || []) {
      shiftPos(kickstandBuild.root.transform?.pos);
      shiftPos(kickstandBuild.hostKnot.pos);
      for (const seg of kickstandBuild.kickstand.segments) {
        shiftJoint(seg.bottomJoint);
        shiftJoint(seg.topJoint);
        if (seg.type === 'bezier') {
          shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
          shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
        }
      }
    }
  }

  /**
   * Converts parsed LYS scene payload into DragonFruit's import format.
   *
   * @param data Parsed LYS scene data.
   * @param settings Active support settings profile used for defaults.
   * @param mesh Optional transformed mesh used for contact/raycast alignment.
   */
  static convert(data: LysData, settings: SupportSettings, mesh?: THREE.Mesh): DragonfruitImportFormat {
    const objectIds = Object.keys((data as any)?.objects?.present?.byId ?? {});
    const supportIds = Object.keys((data as any)?.supports?.present?.byId ?? {});

    console.log('[LysConverter][debug] convert:start', {
      objectCount: objectIds.length,
      objectIds,
      supportCount: supportIds.length,
      meshVertexCount: mesh?.geometry?.getAttribute('position')?.count ?? null,
    });

    const converted = convertLysData(data, settings, mesh);

    console.log('[LysConverter][debug] convert:done', {
      outputSummary: this.summarizeConvertedData(converted),
      outputModelIds: this.collectModelIds(converted),
    });

    return converted;
  }

  /**
   * Applies a Z-axis rotation to all support coordinates in a DragonfruitImportFormat,
   * rotating around a world-space XY pivot. Z coordinates are preserved (rotation is
   * purely in the XY plane). Direction vectors (normals, tangents, axes) are also rotated.
   *
   * Call this AFTER convert() and any Z-offset adjustments but BEFORE applyWorldXYPlacement().
   * This is the post-import equivalent of what the gizmo does via transformSupportsForModel
   * when you rotate a model that already has supports.
   */
  static applyZRotation(
    data: DragonfruitImportFormat,
    pivotX: number,
    pivotY: number,
    rotZRad: number,
  ): void {
    // Guard against no-op / non-finite rotation requests.
    if (!Number.isFinite(rotZRad) || Math.abs(rotZRad) < 1e-8) return;
    const px = Number.isFinite(pivotX) ? pivotX : 0;
    const py = Number.isFinite(pivotY) ? pivotY : 0;
    const cosZ = Math.cos(rotZRad);
    const sinZ = Math.sin(rotZRad);

    // Position rotation around world-space pivot in XY plane.
    const rotPos = (pos: { x: number; y: number; z?: number }) => {
      const dx = pos.x - px;
      const dy = pos.y - py;
      pos.x = dx * cosZ - dy * sinZ + px;
      pos.y = dx * sinZ + dy * cosZ + py;
    };

    // Direction vectors are rotated about origin (no pivot translation).
    const rotDir = (dir: { x: number; y: number; z: number }) => {
      const nx = dir.x * cosZ - dir.y * sinZ;
      const ny = dir.x * sinZ + dir.y * cosZ;
      dir.x = nx;
      dir.y = ny;
    };

    // Joints can be shared across segments; rotate each joint only once.
    const rotatedJointIds = new Set<string>();
    const rotJoint = (joint?: { id?: string; pos: { x: number; y: number; z: number } }) => {
      if (!joint?.pos) return;
      const key = typeof joint.id === 'string' ? joint.id : null;
      if (key && rotatedJointIds.has(key)) return;
      rotPos(joint.pos);
      if (key) rotatedJointIds.add(key);
    };

    const rotSegments = (segments: import('@/supports/types').Segment[]) => {
      for (const seg of segments) {
        rotJoint(seg.topJoint);
        rotJoint(seg.bottomJoint);
        if (seg.type === 'bezier') {
          rotPos(seg.controlPoint1);
          rotPos(seg.controlPoint2);
          rotDir(seg.startTangent);
          rotDir(seg.endTangent);
        }
      }
    };

    for (const root of data.roots) {
      if (root.transform?.pos) rotPos(root.transform.pos);
    }

    for (const trunk of data.trunks) {
      rotSegments(trunk.segments);
      if (trunk.contactCone) {
        rotPos(trunk.contactCone.pos);
        rotDir(trunk.contactCone.normal);
        if (trunk.contactCone.surfaceNormal) rotDir(trunk.contactCone.surfaceNormal);
      }
    }

    for (const branch of data.branches) {
      rotSegments(branch.segments);
      if (branch.contactCone) {
        rotPos(branch.contactCone.pos);
        rotDir(branch.contactCone.normal);
        if (branch.contactCone.surfaceNormal) rotDir(branch.contactCone.surfaceNormal);
      }
    }

    for (const leaf of data.leaves) {
      rotPos(leaf.contactCone.pos);
      rotDir(leaf.contactCone.normal);
      if (leaf.contactCone.surfaceNormal) rotDir(leaf.contactCone.surfaceNormal);
    }

    for (const twig of data.twigs || []) {
      rotSegments(twig.segments);
      rotPos(twig.contactDiskA.pos);
      rotDir(twig.contactDiskA.surfaceNormal);
      rotDir(twig.contactDiskA.coneAxis);
      rotPos(twig.contactDiskB.pos);
      rotDir(twig.contactDiskB.surfaceNormal);
      rotDir(twig.contactDiskB.coneAxis);
    }

    for (const stick of data.sticks || []) {
      rotSegments(stick.segments);
      rotPos(stick.contactConeA.pos);
      rotDir(stick.contactConeA.normal);
      if (stick.contactConeA.surfaceNormal) rotDir(stick.contactConeA.surfaceNormal);
      rotPos(stick.contactConeB.pos);
      rotDir(stick.contactConeB.normal);
      if (stick.contactConeB.surfaceNormal) rotDir(stick.contactConeB.surfaceNormal);
    }

    for (const knot of data.knots) {
      rotPos(knot.pos);
    }

    for (const kickstandBuild of data.kickstands || []) {
      if (kickstandBuild.root.transform?.pos) rotPos(kickstandBuild.root.transform.pos);
      if (kickstandBuild.hostKnot?.pos) rotPos(kickstandBuild.hostKnot.pos);
      rotSegments(kickstandBuild.kickstand.segments);
    }
  }

  /**
   * Converts LYS hollowing settings and hole punches into DragonFruit ModelMeshModifiers.
   *
   * Extracts:
   * - Object infill/hollowing preset → `ModelHollowingModifier`
   * - Pre-computed cavity mesh (`_hollowing` geometry blob) → `cavityPositionsBase64`
   * - Drain hole placements → `ModelHolePunchPlacement[]`
   *
   * @param sceneData        Raw decoded LYS scene payload (the full scene object).
   * @param geometry         Optional geometry used to compute bounding box for hole-position normalisation.
   * @param geometriesByName All parsed geometry blobs keyed by stem name. Used to
   *                         locate `_hollowing` cavity meshes.
   * @returns ModelMeshModifiers or undefined if no hollowing/hole data is found.
   */
  static convertHollowing(
    sceneData: any,
    geometry?: THREE.BufferGeometry,
    geometriesByName?: Map<string, THREE.BufferGeometry>,
  ): ModelMeshModifiers | undefined {
    if (!sceneData) {
      console.log('[LysConverter][convertHollowing] No sceneData — skipping');
      return undefined;
    }

    const result: ModelMeshModifiers = {};

    // -----------------------------------------------------------------------
    // 1) Hollowing settings
    //
    // Lychee stores hollowing per-object (`objects.present.byId[ID].hollowing`).
    // Some variants also carry a global fallback at `settings.objectInfill.preset`.
    // We check per-object first, then fall back to the global path.
    // -----------------------------------------------------------------------

    // Scan all objects for per-object hollowing data.
    let hollowingSource: any = null;
    const objects = sceneData?.objects?.present?.byId as Record<string, any> | undefined;
    if (objects) {
      const objectIds = Object.keys(objects);
      console.log(`[LysConverter][convertHollowing] Scanning ${objectIds.length} objects for per-object hollowing: [${objectIds.join(', ')}]`);
      for (const [objId, obj] of Object.entries(objects)) {
        const objAny = obj as any;
        if (objAny?.hollowing) {
          console.log(`[LysConverter][convertHollowing] Object ${objId} has hollowing: enabled=${objAny.hollowing.enabled}, outer=${objAny.hollowing.outer}`);
          if (objAny.hollowing.enabled === true) {
            hollowingSource = objAny.hollowing;
            console.log(`[LysConverter][convertHollowing] Using per-object hollowing from ${objId}`);
            break;
          }
        } else {
          console.log(`[LysConverter][convertHollowing] Object ${objId} has no .hollowing property`);
        }
      }
    } else {
      console.log('[LysConverter][convertHollowing] No objects.present.byId found in sceneData');
    }

    // Fall back to the global `settings.objectInfill.preset` path.
    if (!hollowingSource) {
      const preset = sceneData?.settings?.objectInfill?.preset;
      console.log('[LysConverter][convertHollowing] No per-object hollowing; checking settings.objectInfill.preset:', JSON.stringify(preset));
      if (preset?.enabled === true) {
        hollowingSource = preset;
        console.log('[LysConverter][convertHollowing] Using global settings.objectInfill.preset');
      }
    }

    if (hollowingSource) {
      console.log('[LysConverter][convertHollowing] Hollowing found — outer:', hollowingSource.outer, 'infillInterval:', hollowingSource.infillInterval, 'infillEnabled:', hollowingSource.infillEnabled);
      // Lychee doesn't expose voxel size — default to 0.5mm.
      const hollowingModifier: ModelHollowingModifier = {
        enabled: true,
        mode: 'cavity',
        voxelSizeMm: 0.5,
        shellThicknessMm: hollowingSource.outer ?? 1.8,
        infillMode: hollowingSource.infillEnabled ? 'lattice' : undefined,
        infillCellMm: hollowingSource.infillInterval ?? 5,
        infillBeamRadiusMm: 0.5,
        openFace: 'z_max',
        // Mark as baked — Lychee already pre-computed the cavity mesh (stored
        // as `_hollowing` geometry). This keeps the hollowing panel from
        // offering to re-apply voxel hollowing when the cavity is already
        // available for Interior View.
        bakedIntoGeometry: true,
      };

      // Lychee pre-computes the cavity interior mesh and stores it with a
      // `_hollowing` suffix (e.g. `<hash>_hollowing`). Extract it so DragonFruit's
      // Interior View can display the pre-baked cavity without re-hollowing.
      if (geometriesByName) {
        for (const [stem, cavityGeom] of geometriesByName) {
          if (stem.toLowerCase().endsWith('_hollowing')) {
            const posAttr = cavityGeom.getAttribute('position');
            if (posAttr) {
              const positions = posAttr.array as Float32Array;
              const cavityBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
              hollowingModifier.cavityPositionsBase64 = bytesToBase64(cavityBytes);
              hollowingModifier.cavityPositionCount = positions.length / 3;
              console.log(`[LysConverter][convertHollowing] Extracted _hollowing cavity mesh from "${stem}": ${positions.length / 3} vertices`);
            }
            break;
          }
        }
      }

      result.hollowing = hollowingModifier;
      console.log('[LysConverter][convertHollowing] Hollowing modifier set:', JSON.stringify(result.hollowing));
    } else {
      console.log('[LysConverter][convertHollowing] No hollowing settings found in scene');
    }

    // -----------------------------------------------------------------------
    // 2) Hole punches (drain holes)
    // -----------------------------------------------------------------------
    const holes = sceneData?.holes?.present?.byId as Record<string, any> | undefined;
    const holeCount = holes ? Object.keys(holes).length : 0;
    console.log(`[LysConverter][convertHollowing] holes.present.byId has ${holeCount} entries`);
    if (holes && holeCount > 0) {
      // Compute bounding box once for coordinate normalisation.
      geometry?.computeBoundingBox();
      const bbox = geometry?.boundingBox ?? null;
      const size = bbox ? bbox.getSize(new THREE.Vector3()) : null;

      const placements: ModelHolePunchPlacement[] = [];

      for (const [holeId, hole] of Object.entries(holes)) {
        if (!hole) {
          console.log(`[LysConverter][convertHollowing] Skipping hole ${holeId}: null/undefined entry`);
          continue;
        }

        // LYS holes are always cylinders — check `settings.type` first, then top-level `type`.
        const lysType = (hole.settings?.type as string | undefined) ?? (hole.type as string | undefined);
        if (lysType && lysType !== 'cylinder') {
          console.log(`[LysConverter][convertHollowing] Skipping hole ${holeId}: non-cylinder type="${lysType}"`);
          continue;
        }

        // LYS holes store position at `tip` (surface contact point) and
        // direction at `tipNormal` (outward-pointing surface normal).
        // The hole punch direction must point INWARD (into the model), so
        // we negate the normal. Some variants use a 4x4 `stlMatrix` instead
        // — fall back to that, then to defaults.
        let pos = new THREE.Vector3(0, 0, 0);
        let dir = new THREE.Vector3(0, 0, -1);

        if (hole.tip && typeof hole.tip.x === 'number') {
          pos.set(hole.tip.x, hole.tip.y, hole.tip.z);
          if (hole.tipNormal && typeof hole.tipNormal.x === 'number') {
            const n = new THREE.Vector3(hole.tipNormal.x, hole.tipNormal.y, hole.tipNormal.z);
            if (n.lengthSq() > 1e-8) dir.copy(n.normalize().negate());
          }
        } else {
          const stlMatrix: number[] | undefined = hole.stlMatrix;
          if (stlMatrix && stlMatrix.length >= 16) {
            // Translation = column 3 (indices 12,13,14)
            pos.set(stlMatrix[12], stlMatrix[13], stlMatrix[14]);
            // Z-axis = column 2 (indices 8,9,10) — the cylinder axis
            const zAxis = new THREE.Vector3(stlMatrix[8], stlMatrix[9], stlMatrix[10]);
            if (zAxis.lengthSq() > 1e-8) dir.copy(zAxis.normalize());
          }
        }

        // Normalise position to 0–1 range relative to bounding box.
        let centerNorm: [number, number, number] = [0.5, 0.5, 0.5];
        if (size && bbox) {
          centerNorm = [
            size.x > 1e-9
              ? Math.max(0, Math.min(1, (pos.x - bbox.min.x) / size.x))
              : 0.5,
            size.y > 1e-9
              ? Math.max(0, Math.min(1, (pos.y - bbox.min.y) / size.y))
              : 0.5,
            size.z > 1e-9
              ? Math.max(0, Math.min(1, (pos.z - bbox.min.z) / size.z))
              : 0.5,
          ];
        }

        // Diameter/depth come from `settings`, then fall back to top-level fields.
        const settings = hole.settings;
        const diameter = (settings?.diameter ?? hole.diameter ?? 2) as number;
        const depth = (settings?.depth ?? hole.depth ?? 3) as number;
        const radiusMm = diameter / 2;
        const depthMm = depth;
        console.log(`[LysConverter][convertHollowing] Hole ${holeId}: pos=(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}), dir=(${dir.x.toFixed(3)}, ${dir.y.toFixed(3)}, ${dir.z.toFixed(3)}), radius=${radiusMm}, depth=${depthMm}`);

        placements.push({
          id: hole.id || `lys-hole-${holeId}`,
          centerNorm,
          radiusMm,
          depthMm,
          direction: [dir.x, dir.y, dir.z],
        });
      }

      if (placements.length > 0) {
        result.holePunches = placements;
        console.log(`[LysConverter][convertHollowing] Extracted ${placements.length} hole punches`);
      } else {
        console.log('[LysConverter][convertHollowing] No cylinder holes found after filtering');
      }
    }

    const hasResult = Object.keys(result).length > 0;
    console.log(`[LysConverter][convertHollowing] Returning ${hasResult ? 'meshModifiers' : 'undefined'} (hollowing=${!!result.hollowing}, holes=${result.holePunches?.length ?? 0})`);
    return hasResult ? result : undefined;
  }
}
