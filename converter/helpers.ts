import * as THREE from 'three';
import type { TipProfile } from '@/supports/Settings/types';
import type { LysSupport, LysSupportSettings } from './types';

/**
 * Shared reads of an LYS payload: settings selection, and field normalisation.
 *
 * An LYS payload offers several settings blocks for the same endpoint and the
 * block that applies is a priority choice, so it lives here rather than being
 * spelled out at each call.
 */

/**
 * Disk standoff defaults for a contact built from an LYS payload, used when the
 * settings profile leaves the field unset. Adjust if needed.
 */
const DISK_THICKNESS_MM = 0.1;
const MAX_STANDOFF_MM = 0.25;
const STANDOFF_ANGLE_THRESHOLD = Math.PI / 4;

/** The disk standoff fields of a contact profile, from settings or the defaults above. */
export function pickDiskStandoff(tipDefaults: TipProfile): {
  diskThicknessMm: number;
  maxStandoffMm: number;
  standoffAngleThreshold: number;
} {
  return {
    diskThicknessMm: tipDefaults.diskThicknessMm ?? DISK_THICKNESS_MM,
    maxStandoffMm: tipDefaults.maxStandoffMm ?? MAX_STANDOFF_MM,
    standoffAngleThreshold: tipDefaults.standoffAngleThreshold ?? STANDOFF_ANGLE_THRESHOLD,
  };
}

/** Normalizes an LYS objectId field (string or number) to a string, or null. */
export function normLysObjectId(val: unknown): string | null {
  if (typeof val === 'string' && val.trim()) return val.trim();
  if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  return null;
}

/**
 * The column height a grid/platform girder is drawn to, or null for an ordinary
 * support, whose `joinLength` is just the joint-collar default.
 */
export function gridColumnHeightMm(s: LysSupport): number | null {
  const node = s.gridNodeIndex;
  if (node === null || node === undefined) return null;
  const joinLength = s.settings?.base?.joinLength;
  if (!Number.isFinite(joinLength as number) || (joinLength as number) <= 5) return null;
  return joinLength as number;
}

/**
 * The settings block describing the end named, for a support that carries both:
 * the end's own block, then the other as a fallback.
 */
export function pickEndpointTipSettings(
  s: LysSupport,
  endpoint: 'base' | 'tip',
): LysSupportSettings['tip'] | LysSupportSettings['baseTip'] | undefined {
  return endpoint === 'base'
    ? s.settings?.baseTip ?? s.settings?.tip
    : s.settings?.tip ?? s.settings?.baseTip;
}

/** The contact end's settings block: the tip end's selection. */
export function pickContactTipSettings(s: LysSupport): LysSupportSettings['tip'] | LysSupportSettings['baseTip'] | undefined {
  return pickEndpointTipSettings(s, 'tip');
}

/** The cone length this support authors, from whichever end block carries one. */
export function coneLengthMm(s: LysSupport, defaultTipLengthMm: number): number {
  return s.settings?.tip?.length || s.settings?.baseTip?.length || defaultTipLengthMm;
}

/**
 * Chooses which endpoint should be treated as the contact tip based on proximity.
 */
export function inferLeafTipEndpoint(
  tipPoint: THREE.Vector3,
  basePoint: THREE.Vector3,
  sourceTipPoint: THREE.Vector3,
): 'base' | 'tip' {
  const distToBaseSq = tipPoint.distanceToSquared(basePoint);
  const distToTipSq = tipPoint.distanceToSquared(sourceTipPoint);
  return distToTipSq <= distToBaseSq ? 'tip' : 'base';
}

/**
 * Determines endpoint diameter with priority ordering from endpoint/body/base settings.
 */
export function pickLeafEndpointDiameter(
  s: LysSupport,
  endpoint: 'base' | 'tip',
  fallback: number,
): number {
  const endpointSettings = endpoint === 'tip' ? s.settings?.tip : s.settings?.baseTip;
  const pointDiameter = endpointSettings?.pointDiameter;
  if (Number.isFinite(pointDiameter as number) && (pointDiameter as number) > 0) {
    return pointDiameter as number;
  }

  const bodyDiameter = endpointSettings?.diameter;
  if (Number.isFinite(bodyDiameter as number) && (bodyDiameter as number) > 0) {
    return bodyDiameter as number;
  }

  if (endpoint === 'base') {
    const joinDiameter = s.settings?.base?.joinDiameter;
    if (Number.isFinite(joinDiameter as number) && (joinDiameter as number) > 0) {
      return joinDiameter as number;
    }
  }

  return fallback;
}
