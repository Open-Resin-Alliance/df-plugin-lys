import * as THREE from 'three';
import {
  DragonfruitImportFormat,
  Joint,
} from '@/supports/types';
import { SupportSettings } from '@/supports/Settings';
import { convertLysData } from './converter/convertLysData';
import { LysData } from './converter/types';

export class LysConverter {

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
    if (!Number.isFinite(rotZRad) || Math.abs(rotZRad) < 1e-8) return;
    const px = Number.isFinite(pivotX) ? pivotX : 0;
    const py = Number.isFinite(pivotY) ? pivotY : 0;
    const cosZ = Math.cos(rotZRad);
    const sinZ = Math.sin(rotZRad);

    const rotPos = (pos: { x: number; y: number; z?: number }) => {
      const dx = pos.x - px;
      const dy = pos.y - py;
      pos.x = dx * cosZ - dy * sinZ + px;
      pos.y = dx * sinZ + dy * cosZ + py;
    };

    const rotDir = (dir: { x: number; y: number; z: number }) => {
      const nx = dir.x * cosZ - dir.y * sinZ;
      const ny = dir.x * sinZ + dir.y * cosZ;
      dir.x = nx;
      dir.y = ny;
    };

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
}
