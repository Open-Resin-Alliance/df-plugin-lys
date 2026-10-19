import * as THREE from 'three';
import { DragonfruitImportFormat } from '@/supports/types';
import { SupportSettings } from '@/supports/Settings';
import type {
  ModelMeshModifiers,
  ModelHollowingModifier,
  ModelHolePunchPlacement,
} from '@/features/mesh-modifiers/types';
import { MeshBVH } from 'three-mesh-bvh';
import { quaternionFromGlobalEulerDegrees } from '@/utils/rotation';
import { emitSupportGraph } from './converter/graphEmit';
import { LysData, LysHollowing } from './converter/types';
import { normLysObjectId } from './converter/helpers';
import { visitSupportGeometry } from './converter/supportTraversal';

/**
 * Resolve the inward drill direction for a tilted hole whose cylinder axis lies
 * along `axis` (the tipRotation frame's Z). Lychee stores the axis line but no
 * reliable inward sign, so we read it from the mesh: cast a ray each way from
 * the tip.
 *
 * Supporters place most holes on the OUTER surface, but some drain/vent holes are
 * anchored to the INTERIOR (cavity) wall and drill outward through the shell. The
 * cavity mesh distinguishes the two:
 *  - Anchored to the cavity wall (tip nearer the cavity mesh than the outer
 *    surface): drill OUT through the near shell → toward the nearer outer hit.
 *  - Anchored to the outer surface: a side that escapes to open air is OUTWARD,
 *    so drill the other way; if both sides hit a wall the tip is embedded, so
 *    drill toward the farther wall (more material).
 *
 * Returns null if the geometry gives no usable hit.
 */
function resolveDrillInward(
  bvh: MeshBVH,
  cavityBvh: MeshBVH | null,
  tip: THREE.Vector3,
  axis: THREE.Vector3,
): THREE.Vector3 | null {
  const firstHitDistance = (d: THREE.Vector3): number => {
    const ray = new THREE.Ray(tip.clone().addScaledVector(d, 1e-3), d.clone());
    let nearest = Infinity;
    for (const hit of bvh.raycast(ray, THREE.DoubleSide)) {
      if (hit.distance < nearest) nearest = hit.distance;
    }
    return nearest;
  };
  const forward = firstHitDistance(axis);
  const backward = firstHitDistance(axis.clone().negate());

  // Interior-anchored drain hole: tip sits nearer the cavity mesh than the outer
  // surface. Drill toward the nearer outer-surface hit — the short way out through
  // the shell. (closestPointToPoint returns squared distance; comparison only.)
  if (cavityBvh) {
    const dOuter = bvh.closestPointToPoint(tip)?.distance ?? Infinity;
    const dCavity = cavityBvh.closestPointToPoint(tip)?.distance ?? Infinity;
    if (dCavity < dOuter) {
      return axis.clone().multiplyScalar(forward < backward ? 1 : -1);
    }
  }

  const forwardEscapes = !Number.isFinite(forward);
  const backwardEscapes = !Number.isFinite(backward);
  if (forwardEscapes && backwardEscapes) return null;
  let sign: number;
  if (forwardEscapes) sign = -1;
  else if (backwardEscapes) sign = 1;
  else sign = forward > backward ? 1 : -1;
  return axis.clone().multiplyScalar(sign);
}

/** Normalize an LYS objectId field (may be string or number) to a string, or null. */
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

    visitSupportGeometry(data, {
      position: (pos) => { pos.x += offsetX; pos.y += offsetY; },
    });
  }

  /**
   * Converts parsed LYS scene payload into DragonFruit's import format.
   *
   * @param data Parsed LYS scene data.
   * @param settings Active support settings profile used for defaults.
   * @param mesh Optional transformed mesh used for contact/raycast alignment.
   */
  static convert(data: LysData, settings: SupportSettings, mesh?: THREE.Mesh): DragonfruitImportFormat {
    const objectIds = Object.keys(data?.objects?.present?.byId ?? {});
    const supportIds = Object.keys(data?.supports?.present?.byId ?? {});

    console.log('[LysConverter][debug] convert:start', {
      objectCount: objectIds.length,
      objectIds,
      supportCount: supportIds.length,
      meshVertexCount: mesh?.geometry?.getAttribute('position')?.count ?? null,
    });

    const converted = emitSupportGraph(data, settings, mesh).format;

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

    visitSupportGeometry(data, {
      // Positions turn about the pivot; Z is untouched.
      position: (pos) => {
        const dx = pos.x - px;
        const dy = pos.y - py;
        pos.x = dx * cosZ - dy * sinZ + px;
        pos.y = dx * sinZ + dy * cosZ + py;
      },
      // Directions turn about the origin, with no pivot translation.
      direction: (dir) => {
        const nx = dir.x * cosZ - dir.y * sinZ;
        const ny = dir.x * sinZ + dir.y * cosZ;
        dir.x = nx;
        dir.y = ny;
      },
    });
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
   * @param options          Per-object scoping for multi-part scenes:
   *                         - `objectId`: keep only holes whose `objectId` matches. Omit
   *                           to process the whole scene as one model (legacy behavior).
   *                         - `cavityGeometry`: this object's own `_hollowing` cavity
   *                           mesh, used only to resolve a tilted hole's drill sign. The
   *                           caller resolves it (it already knows the object→geometry
   *                           mapping), just like the outer `geometry` argument.
   * @returns ModelMeshModifiers or undefined if no hollowing/hole data is found.
   */
  static convertHollowing(
    sceneData: LysData | null | undefined,
    geometry?: THREE.BufferGeometry,
    geometriesByName?: Map<string, THREE.BufferGeometry>,
    isLegacyGeometry?: boolean,
    options?: { objectId?: string; cavityGeometry?: THREE.BufferGeometry },
  ): ModelMeshModifiers | undefined {
    if (!sceneData) {
      console.log('[LysConverter][convertHollowing] No sceneData — skipping');
      return undefined;
    }

    const result: ModelMeshModifiers = {};

    // Multi-part scenes call this once per object; scope the hole punches to that
    // object so holes don't leak across models. Omitted for the whole-scene
    // (single-model) path, which keeps the legacy behavior. (Hollowing/cavity
    // extraction for Interior View is unchanged — see section 1.)
    const targetObjectId = normLysObjectId(options?.objectId);

    // -----------------------------------------------------------------------
    // 1) Hollowing settings
    //
    // Lychee stores hollowing per-object (`objects.present.byId[ID].hollowing`).
    // Some variants also carry a global fallback at `settings.objectInfill.preset`.
    // We check per-object first, then fall back to the global path.
    // -----------------------------------------------------------------------

    // Scan all objects for per-object hollowing data.
    let hollowingSource: LysHollowing | null = null;
    const objects = sceneData?.objects?.present?.byId;
    if (objects) {
      const objectIds = Object.keys(objects);
      console.log(`[LysConverter][convertHollowing] Scanning ${objectIds.length} objects for per-object hollowing: [${objectIds.join(', ')}]`);
      for (const [objId, obj] of Object.entries(objects)) {
        if (obj?.hollowing) {
          console.log(`[LysConverter][convertHollowing] Object ${objId} has hollowing: enabled=${obj.hollowing.enabled}, outer=${obj.hollowing.outer}`);
          if (obj.hollowing.enabled === true
              || (isLegacyGeometry && typeof obj.hollowing.outer === 'number' && obj.hollowing.outer > 0)) {
            hollowingSource = obj.hollowing;
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
        // Not baked here: the cavity travels beside the shell and the host
        // decides whether to join them, so it sets this to match that choice.
        bakedIntoGeometry: false,
      };

      // Lychee pre-computes the cavity interior mesh and stores it with a
      // `_hollowing` suffix (e.g. `<hash>_hollowing`). Extract it so DragonFruit's
      // Interior View can display the pre-baked cavity without re-hollowing.
      //
      // Scoped the same way the hole pass below scopes its cavity: a multi-part
      // caller passes this object's own mesh, and an object without one is not
      // hollowed, so it gets no cavity rather than the first one in the file.
      // Unscoped, the single-model path keeps taking the only `_hollowing` mesh.
      let modifierCavity: THREE.BufferGeometry | null = null;
      if (targetObjectId) {
        modifierCavity = options?.cavityGeometry ?? null;
      } else if (geometriesByName) {
        for (const [stem, g] of geometriesByName) {
          if (stem.toLowerCase().endsWith('_hollowing') && g.getAttribute('position')) {
            modifierCavity = g;
            break;
          }
        }
      }

      const cavityPosAttr = modifierCavity?.getAttribute('position');
      if (cavityPosAttr) {
        const positions = cavityPosAttr.array as Float32Array;
        const cavityBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
        hollowingModifier.cavityPositionsBase64 = bytesToBase64(cavityBytes);
        hollowingModifier.cavityPositionCount = positions.length / 3;
        console.log(`[LysConverter][convertHollowing] Cavity mesh: ${positions.length / 3} vertices`);
      } else if (targetObjectId) {
        console.log(`[LysConverter][convertHollowing] Object ${targetObjectId} has no cavity mesh of its own`);
      }

      result.hollowing = hollowingModifier;
      console.log('[LysConverter][convertHollowing] Hollowing modifier set:', JSON.stringify(result.hollowing));
    } else {
      console.log('[LysConverter][convertHollowing] No hollowing settings found in scene');
    }

    // -----------------------------------------------------------------------
    // 2) Hole punches (drain holes)
    // -----------------------------------------------------------------------
    const allHoles = sceneData?.holes?.present?.byId;
    // In a multi-part scene every hole carries an `objectId`; keep only the ones
    // belonging to the object we're converting. Without this, each imported model
    // would receive every hole in the file. Unscoped, keep all holes.
    const holeEntries = allHoles
      ? Object.entries(allHoles).filter(([, hole]) => {
          if (!targetObjectId) return true;
          return normLysObjectId(hole?.objectId) === targetObjectId;
        })
      : [];
    console.log(`[LysConverter][convertHollowing] holes.present.byId has ${allHoles ? Object.keys(allHoles).length : 0} entries; ${holeEntries.length} match${targetObjectId ? ` object ${targetObjectId}` : ' (unscoped)'}`);
    if (holeEntries.length > 0) {
      // Compute bounding box once for coordinate normalisation.
      geometry?.computeBoundingBox();
      const bbox = geometry?.boundingBox ?? null;
      const size = bbox ? bbox.getSize(new THREE.Vector3()) : null;

      const placements: ModelHolePunchPlacement[] = [];

      // A tilted hole's drill sign is resolved against the mesh geometry; build
      // an acceleration structure once, only when a tilted hole is present.
      const hasTiltedHole = holeEntries.some(([, h]) => h && h.tipRotation);
      const holeBvh = hasTiltedHole && geometry?.getAttribute('position')
        ? new MeshBVH(geometry)
        : null;
      // The pre-baked cavity mesh lets us tell interior-anchored drain holes from
      // outer-surface ones when resolving the drill sign. Scoped: multi-part
      // callers pass this object's own cavity; unscoped, use the first `_hollowing`
      // mesh in the map (single-model file — there's only one).
      let cavityGeom: THREE.BufferGeometry | null = null;
      if (targetObjectId) {
        cavityGeom = options?.cavityGeometry ?? null;
      } else if (geometriesByName) {
        for (const [stem, g] of geometriesByName) {
          if (stem.toLowerCase().endsWith('_hollowing') && g.getAttribute('position')) {
            cavityGeom = g;
            break;
          }
        }
      }
      const cavityBvh = hasTiltedHole && cavityGeom?.getAttribute('position')
        ? new MeshBVH(cavityGeom)
        : null;

      for (const [holeId, hole] of holeEntries) {
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

        // LYS holes store their surface contact point at `tip`. The drill
        // direction depends on whether the user tilted the hole:
        //  - un-rotated (`tipRotation == null`): `tipNormal` is the OUTWARD
        //    surface normal, so we negate it to drill inward.
        //  - tilted (`tipRotation` set): the cylinder axis is the rotation
        //    frame's Z (`tipNormal` is that frame's −Y and points sideways).
        //    The frame doesn't encode which way along the axis is inward, so we
        //    resolve the sign against the mesh (and cavity mesh for interior-
        //    anchored drain holes — see resolveDrillInward). Verified across
        //    5 files / 20 holes.
        // Some variants use a 4x4 `stlMatrix` instead — fall back to that.
        const pos = new THREE.Vector3(0, 0, 0);
        const dir = new THREE.Vector3(0, 0, -1);

        if (hole.tip && typeof hole.tip.x === 'number') {
          pos.set(hole.tip.x, hole.tip.y, hole.tip.z);
          if (hole.tipRotation) {
            const q = quaternionFromGlobalEulerDegrees(hole.tipRotation);
            const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
            const inward = holeBvh ? resolveDrillInward(holeBvh, cavityBvh, pos, axis) : null;
            dir.copy(inward ?? axis);
          } else if (hole.tipNormal && typeof hole.tipNormal.x === 'number') {
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
