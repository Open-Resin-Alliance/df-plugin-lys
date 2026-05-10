import {
  Roots,
  Trunk,
  Branch,
  Knot,
} from '@/supports/types';
import type { Kickstand } from '@/supports/SupportTypes/Kickstand/types';

/**
 * Shared structural types for LYS conversion.
 *
 * These interfaces intentionally represent only the fields used by the converter,
 * not a complete schema for every possible LYS variant.
 */

export interface LysVector {
  x: number;
  y: number;
  z: number;
}

/**
 * Support-specific settings found in LYS payloads.
 *
 * Many fields are optional because source files can be sparse or variant-specific.
 */
export interface LysSupportSettings {
  tip?: {
    length?: number;
    angle?: number;
    diameter?: number;
    pointDiameter?: number;
  };
  base?: {
    length?: number;
    diameter?: number;
    joinDiameter?: number;
    joinLength?: number;
    newJoinLength?: number;
    joinCone?: number;
  };
  baseTip?: {
    length?: number;
    diameter?: number;
    pointDiameter?: number;
    isStraight?: boolean;
  };
  isStraight?: boolean;
}

/**
 * Minimal LYS support record required for conversion into DragonFruit supports.
 */
export interface LysSupport {
  id: string;
  base: LysVector;
  tip: LysVector;
  isBaseTip?: boolean;
  baseNormal?: LysVector;
  tipNormal?: LysVector;
  mini?: boolean;
  settings?: LysSupportSettings;
  objectIdTip?: string | number | null;
  objectIdBase?: string | number | null;
  parentId?: string[];
  parentBaseId?: string | null;
  parentTipId?: string | null;
}

/**
 * Minimal object record used for transform and ownership resolution.
 */
export interface LysObject {
  id: string;
  center?: LysVector;
  formerCenter?: LysVector;
  position?: LysVector;
  rotation?: LysVector;
  scale?: LysVector;
  supportsBase?: string[];
}

/**
 * Minimal scene payload shape consumed by `convertLysData`.
 */
export interface LysData {
  objects?: { present?: { byId?: Record<string, LysObject> } };
  supports?: { present?: { byId?: Record<string, LysSupport> } };
}

/**
 * Runtime host lookup entry used to attach children (branches/braces/leaves/etc.)
 * to already-created parent shafts.
 */
export type HostEntry =
  | { kind: 'trunk'; shaftId: string; trunk: Trunk; root: Roots }
  | { kind: 'branch'; shaftId: string; branch: Branch; parentKnot: Knot }
  | { kind: 'kickstand'; shaftId: string; kickstand: Kickstand; root: Roots; hostKnot: Knot };
