import {
  Roots,
  Trunk,
  Branch,
  Knot,
  Twig,
  Stick,
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
  /** LYS support kind. Numeric in the files seen so far; compared against 0/1. */
  type?: number | string;
  base: LysVector;
  tip: LysVector;
  isBaseTip?: boolean;
  baseNormal?: LysVector;
  tipNormal?: LysVector;
  mini?: boolean;
  settings?: LysSupportSettings;
  objectIdTip?: string | number | null;
  objectIdBase?: string | number | null;
  /** Parent-like fields vary by LYS variant. Only the per-end refs are read. */
  parentId?: string | string[] | number | null;
  parentIds?: string | string[] | number | null;
  parent?: string | string[] | number | null;
  parents?: string | string[] | number | null;
  hostId?: string | string[] | number | null;
  hostIds?: string | string[] | number | null;
  parentBaseId?: string | null;
  parentTipId?: string | null;
  /** Marks a grid/platform girder, whose `joinLength` names its column height. */
  gridNodeIndex?: number | null;
}

/** The tip or baseTip settings block, whichever a support carries. */
export type LysTipSettings = LysSupportSettings['tip'] | LysSupportSettings['baseTip'];

/**
 * Minimal object record used for transform and ownership resolution.
 */
export interface LysObject {
  /** LYS variants carry extra per-object metadata keys (mesh/hash references
   *  among them) that the geometry matcher scans generically. */
  [key: string]: unknown;
  /** Optional: the byId map key is the authoritative id; not every variant
   *  repeats it inside the record. */
  id?: string;
  /** Geometry lookup hint; present in newer variants only. */
  properties?: { hash?: unknown };
  hollowing?: LysHollowing;
  center?: LysVector;
  formerCenter?: LysVector;
  position?: LysVector;
  rotation?: LysVector;
  scale?: LysVector;
  supportsBase?: string[];
}

/** Per-object (or global preset) hollowing block as Lychee stores it. */
export interface LysHollowing {
  enabled?: boolean;
  outer?: number;
  infillEnabled?: boolean;
  infillInterval?: number;
}

/**
 * Minimal hole record: the converter only needs to know which object a hole
 * belongs to and whether it is tilted.
 */
export interface LysHole {
  id?: string;
  objectId?: string | number | null;
  /** Hole shape. Only cylinders are imported; the field sits at either level. */
  type?: string;
  settings?: { type?: string; diameter?: number; depth?: number };
  tip?: LysVector;
  tipNormal?: LysVector;
  /** Euler degrees, global order. */
  tipRotation?: LysVector;
  /** Legacy variants place the hole through a 4x4 matrix instead of tip/normal. */
  stlMatrix?: number[];
  diameter?: number;
  depth?: number;
}

/**
 * Minimal scene payload shape consumed by the converter's read pass.
 */
export interface LysData {
  objects?: { present?: { byId?: Record<string, LysObject> } };
  supports?: { present?: { byId?: Record<string, LysSupport> } };
  holes?: { present?: { byId?: Record<string, LysHole> } };
  /** Global fallback for hollowing when no object carries its own block. */
  settings?: { objectInfill?: { preset?: LysHollowing } };
}

/**
 * Runtime host lookup entry used to attach children (branches/braces/leaves/etc.)
 * to already-created parent shafts.
 */
export type HostEntry =
  | { kind: 'trunk'; shaftId: string; trunk: Trunk; root: Roots }
  | { kind: 'branch'; shaftId: string; branch: Branch; parentKnot: Knot }
  | { kind: 'kickstand'; shaftId: string; kickstand: Kickstand; root: Roots; hostKnot: Knot }
  | { kind: 'twig'; shaftId: string; twig: Twig }
  | { kind: 'stick'; shaftId: string; stick: Stick };
