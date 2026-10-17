/**
 * The acceptance snapshot: its shape, and the one place it is computed.
 *
 * Kept apart from `snapshotLys.ts` so that (a) a reader can import it without
 * executing a conversion, and (b) every producer of the artefact — the harness,
 * and any generator that captures baselines from another converter revision —
 * agrees on the encoding. Ids are excluded because they are regenerated per run:
 * geometry and topology are what must match.
 */

interface SegmentLike {
  id: string;
  bottomJoint?: { pos?: Vec3Like };
  topJoint?: { pos?: Vec3Like };
}
interface Vec3Like { x: number; y: number; z: number }
interface EntityLike { segments?: SegmentLike[] }

export interface FormatLike {
  roots?: unknown[];
  trunks?: EntityLike[];
  branches?: Array<EntityLike & { parentKnotId?: string }>;
  leaves?: Array<{ parentKnotId?: string }>;
  twigs?: EntityLike[];
  sticks?: EntityLike[];
  braces?: Array<{ startKnotId?: string; endKnotId?: string; profile?: { diameter?: number } }>;
  kickstands?: Array<{
    hostKnot?: { id?: string; pos?: Vec3Like };
    root?: { transform?: { pos?: Vec3Like } };
    kickstand?: EntityLike;
  }>;
  knots?: Array<{ id: string; parentShaftId: string; t: number; pos?: Vec3Like; diameter?: number }>;
}

export interface SupportSnapshot {
  counts: {
    roots: number; trunks: number; branches: number; leaves: number; twigs: number;
    sticks: number; braces: number; kickstands: number; knots: number;
  };
  knotIntegrity: {
    distinctSites: number;
    duplicateKnots: number;
    danglingReferences: number;
    orphanKnots: number;
  };
  /** Root, column top and host knot of each kickstand, in world space. */
  kickstands: string[];
  warnings: string[];
  braces: string[];
}

const q = (n: number | undefined) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : null);
const qp = (p: Vec3Like | undefined) => (p ? `${q(p.x)},${q(p.y)},${q(p.z)}` : null);

export function snapshotOf(format: FormatLike, warnings: string[]): SupportSnapshot {
  // A kickstand carries its host knot on the build rather than in `knots`, so the
  // index spans both or every one of them reads as a dangling reference.
  const knotById = new Map((format.knots ?? []).map((k) => [k.id, k] as const));
  for (const kb of format.kickstands ?? []) {
    if (kb.hostKnot?.id && !knotById.has(kb.hostKnot.id)) knotById.set(kb.hostKnot.id, kb.hostKnot as never);
  }

  // Shaft ids are generated per run, so name a segment by its own geometry.
  const shaftSig = new Map<string, string>();
  const addShafts = (entities: EntityLike[] | undefined, kind: string) => {
    for (const e of entities ?? []) {
      for (const seg of e.segments ?? []) {
        shaftSig.set(seg.id, `${kind}[${qp(seg.bottomJoint?.pos)}->${qp(seg.topJoint?.pos)}]`);
      }
    }
  };
  addShafts(format.trunks, 'trunk');
  addShafts(format.branches, 'branch');
  addShafts(format.twigs, 'twig');
  addShafts(format.sticks, 'stick');
  for (const kb of format.kickstands ?? []) addShafts([kb.kickstand ?? {}], 'kickstand');

  // Describe a knot by what it IS, not by its id.
  const knotSig = (id: string | undefined) => {
    if (!id) return null;
    const k = knotById.get(id);
    if (!k) return `DANGLING`;
    const shaft = shaftSig.get(k.parentShaftId) ?? `UNRESOLVED-SHAFT`;
    return `${shaft}@${q(k.t)}|${qp(k.pos)}|d=${q(k.diameter)}`;
  };

  const braces = (format.braces ?? [])
    .map((b) => `${knotSig(b.startKnotId)} <-> ${knotSig(b.endKnotId)} | d=${q(b.profile?.diameter)}`)
    .sort();

  const knotSites = new Map<string, number>();
  for (const k of format.knots ?? []) {
    const key = `${shaftSig.get(k.parentShaftId) ?? 'UNRESOLVED'}|${qp(k.pos)}|d=${q(k.diameter)}`;
    knotSites.set(key, (knotSites.get(key) ?? 0) + 1);
  }

  const kickstands = (format.kickstands ?? [])
    .map((kb) => {
      const root = kb.root?.transform?.pos;
      const host = kb.hostKnot?.pos;
      const colTop = (kb.kickstand?.segments ?? [])[0]?.topJoint?.pos;
      return `root=${qp(root)} colTop=${qp(colTop)} hostKnot=${qp(host)}`;
    })
    .sort();

  const referenced = new Set<string>();
  for (const b of format.braces ?? []) { if (b.startKnotId) referenced.add(b.startKnotId); if (b.endKnotId) referenced.add(b.endKnotId); }
  for (const b of format.branches ?? []) if (b.parentKnotId) referenced.add(b.parentKnotId);
  for (const l of format.leaves ?? []) if (l.parentKnotId) referenced.add(l.parentKnotId);
  for (const k of format.kickstands ?? []) if (k.hostKnot?.id) referenced.add(k.hostKnot.id);

  return {
    counts: {
      roots: format.roots?.length ?? 0,
      trunks: format.trunks?.length ?? 0,
      branches: format.branches?.length ?? 0,
      leaves: format.leaves?.length ?? 0,
      twigs: format.twigs?.length ?? 0,
      sticks: format.sticks?.length ?? 0,
      braces: format.braces?.length ?? 0,
      kickstands: format.kickstands?.length ?? 0,
      knots: format.knots?.length ?? 0,
    },
    knotIntegrity: {
      distinctSites: knotSites.size,
      duplicateKnots: [...knotSites.values()].reduce((a, b) => a + b - 1, 0),
      danglingReferences: [...referenced].filter((id) => !knotById.has(id)).length,
      orphanKnots: (format.knots ?? []).filter((k) => !referenced.has(k.id)).length,
    },
    // Where each kickstand stands and where it meets its host, in world space.
    // The brace signatures below name a knot by its shaft and parameter, so a host
    // knot that moves without changing either is invisible to them.
    kickstands,
    warnings: warnings.map((w) => w.replace(/[0-9a-f-]{36}/g, '<id>')).sort(),
    braces,
  };
}
