import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildSupportGraph } from './supportGraph';
import { classCounts, classifySupportGraph } from './graphClassify';
import type { LysData, LysSupport } from './types';

const OPTIONS = { stickVsTwigCutoffMm: 5, defaultTipLengthMm: 2.5 };

/** A support with sane endpoints; override whatever the case is about. */
const support = (over: Partial<LysSupport>): LysSupport => ({
  id: 'x',
  base: { x: 0, y: 0, z: 0 },
  tip: { x: 0, y: 0, z: 1 },
  ...over,
});

const sceneOf = (byId: Record<string, LysSupport>): LysData => ({ supports: { present: { byId } } });

/** Classify one node of a scene, with the required host supports present. */
const classify = (byId: Record<string, LysSupport>, id: string) => {
  const graph = buildSupportGraph(sceneOf(byId));
  const found = classifySupportGraph(graph, OPTIONS).find((c) => c.node.id === id);
  assert.ok(found, `no classification for ${id}`);
  return found;
};

const floating = (over: Partial<LysSupport>): LysSupport => support({
  baseNormal: { x: 0, y: 0, z: 1 },
  tipNormal: { x: 0, y: 0, z: -1 },
  base: { x: 0, y: 0, z: 10 },
  ...over,
});

describe('graphClassify — 0 hosts', () => {
  it('plate-grounded base is a trunk even with both normals', () => {
    const c = classify({ s: floating({ id: 's', base: { x: 0, y: 0, z: 0.1 }, tip: { x: 0, y: 0, z: 11 } }) }, 's');
    assert.equal(c.kind, 'trunk');
    assert.equal(c.grounded, true);
  });

  it('floating span above the cutoff is a stick', () => {
    const c = classify({ s: floating({ id: 's', tip: { x: 0, y: 0, z: 16 } }) }, 's');
    assert.equal(c.kind, 'stick');
    assert.equal(c.spanMm, 6);
  });

  it('floating span at or below the cutoff is a twig', () => {
    const c = classify({ s: floating({ id: 's', tip: { x: 0, y: 0, z: 14 } }) }, 's');
    assert.equal(c.kind, 'twig');
  });

  it('a mini is a twig at any length, including a plate-grounded base', () => {
    const c = classify({ s: floating({ id: 's', mini: true, base: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 40 } }) }, 's');
    assert.equal(c.kind, 'twig');
    assert.equal(c.grounded, true);
  });

  it('an unusable normal falls back to a trunk rather than guessing twig or stick', () => {
    const c = classify({ s: floating({ id: 's', tipNormal: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 16 } }) }, 's');
    assert.equal(c.kind, 'trunk');
  });

  it('a non-positive cutoff disables the twig side', () => {
    const graph = buildSupportGraph(sceneOf({ s: floating({ id: 's', tip: { x: 0, y: 0, z: 11 } }) }));
    const c = classifySupportGraph(graph, { ...OPTIONS, stickVsTwigCutoffMm: 0 })[0];
    assert.equal(c.kind, 'stick');
  });
});

describe('graphClassify — 1 host', () => {
  const hosted = (over: Partial<LysSupport>): Record<string, LysSupport> => ({
    host: support({ id: 'host', base: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 30 } }),
    child: support({ id: 'child', parentBaseId: 'host', base: { x: 0, y: 0, z: 10 }, tip: { x: 0, y: 0, z: 20 }, settings: { tip: { length: 2 } }, ...over }),
  });

  it('a plate-grounded hosted support is a kickstand', () => {
    const c = classify(hosted({ base: { x: 0, y: 0, z: 0.1 } }), 'child');
    assert.equal(c.kind, 'kickstand');
    assert.equal(c.attachEnd, 'base');
    assert.equal(c.contactEnd, 'tip');
  });

  it('isBaseTip blocks the kickstand reading, leaving a branch', () => {
    const c = classify(hosted({ base: { x: 0, y: 0, z: 0.1 }, isBaseTip: true }), 'child');
    assert.equal(c.kind, 'branch');
  });

  it('a hosted support with no shaft is a leaf', () => {
    // span 2mm, cone 2mm: the whole support is cone.
    const c = classify(hosted({ base: { x: 0, y: 0, z: 10 }, tip: { x: 0, y: 0, z: 12 } }), 'child');
    assert.equal(c.kind, 'leaf');
    assert.equal(c.shaftMm, 0);
  });

  it('a leaf-shaped support with children stays a branch, so the children keep a host', () => {
    const byId = hosted({ base: { x: 0, y: 0, z: 10 }, tip: { x: 0, y: 0, z: 12 } });
    byId.grandchild = support({ id: 'grandchild', parentBaseId: 'child', base: { x: 0, y: 0, z: 11 }, tip: { x: 0, y: 0, z: 20 } });
    const c = classify(byId, 'child');
    assert.equal(c.kind, 'branch');
    assert.equal(c.hasChildren, true);
  });

  it('a mini is a leaf without a length test', () => {
    const c = classify(hosted({ mini: true, base: { x: 0, y: 0, z: 10 }, tip: { x: 0, y: 0, z: 20 } }), 'child');
    assert.equal(c.kind, 'leaf');
  });

  it('hosted at the tip end, the base is the contact', () => {
    const byId = hosted({ parentBaseId: null, parentTipId: 'host', base: { x: 0, y: 0, z: 40 }, tip: { x: 0, y: 0, z: 20 } });
    const c = classify(byId, 'child');
    assert.equal(c.attachEnd, 'tip');
    assert.equal(c.contactEnd, 'base');
  });
});

describe('graphClassify — host count and bucket', () => {
  it('two distinct hosts is a brace', () => {
    const byId = {
      a: support({ id: 'a', base: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 20 } }),
      b: support({ id: 'b', base: { x: 10, y: 0, z: 0 }, tip: { x: 10, y: 0, z: 20 } }),
      span: support({ id: 'span', parentBaseId: 'a', parentTipId: 'b', base: { x: 0, y: 0, z: 5 }, tip: { x: 10, y: 0, z: 5 } }),
    };
    const c = classify(byId, 'span');
    assert.equal(c.kind, 'brace');
    assert.equal(c.hostCount, 2);
  });

  it('both refs naming one host is a branch, not a brace', () => {
    const byId = {
      host: support({ id: 'host', base: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 30 } }),
      child: support({ id: 'child', parentBaseId: 'host', parentTipId: 'host', base: { x: 0, y: 0, z: 10 }, tip: { x: 0, y: 0, z: 20 } }),
    };
    const c = classify(byId, 'child');
    assert.equal(c.hostCount, 1);
    assert.equal(c.attachEnd, 'base');
    assert.equal(c.kind, 'branch');
  });
});

describe('graphClassify — class counts', () => {
  it('reports a root per trunk, as the import format requires', () => {
    const graph = buildSupportGraph(sceneOf({
      trunk: support({ id: 'trunk', base: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 30 } }),
      floating: floating({ id: 'floating', tip: { x: 0, y: 0, z: 12 } }),
    }));

    const counts = classCounts(classifySupportGraph(graph, OPTIONS));

    assert.equal(counts.trunks, 1);
    assert.equal(counts.roots, 1);
    assert.equal(counts.twigs, 1);
    assert.equal(counts.braces, 0);
  });
});
