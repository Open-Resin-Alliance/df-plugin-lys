import {
  Roots,
  Trunk,
  Branch,
  Knot,
} from '@/supports/types';
import type { Kickstand } from '@/supports/SupportTypes/Kickstand/types';

export interface LysVector {
  x: number;
  y: number;
  z: number;
}

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

export interface LysObject {
  id: string;
  center?: LysVector;
  formerCenter?: LysVector;
  position?: LysVector;
  rotation?: LysVector;
  scale?: LysVector;
  supportsBase?: string[];
}

export interface LysData {
  objects?: { present?: { byId?: Record<string, LysObject> } };
  supports?: { present?: { byId?: Record<string, LysSupport> } };
}

export type HostEntry =
  | { kind: 'trunk'; shaftId: string; trunk: Trunk; root: Roots }
  | { kind: 'branch'; shaftId: string; branch: Branch; parentKnot: Knot }
  | { kind: 'kickstand'; shaftId: string; kickstand: Kickstand; root: Roots; hostKnot: Knot };
