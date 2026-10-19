import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupportGraph,
  degreeHistogram,
  degreeOf,
  emissionOrder,
  readLysNodes,
  relateHosts,
} from './supportGraph';
import type { LysData, LysSupport } from './types';

/** A support with sane endpoints; override whatever the case is about. */
const support = (over: Partial<LysSupport>): LysSupport => ({
  id: 'x',
  base: { x: 0, y: 0, z: 0 },
  tip: { x: 0, y: 0, z: 1 },
  ...over,
});

const sceneOf = (byId: Record<string, LysSupport>): LysData => ({
  supports: { present: { byId } },
});

describe('supportGraph.readLysNodes', () => {
  it('reads nodes in scene order and keeps the authored refs per end', () => {
    const data = sceneOf({
      s1: support({ id: 's1' }),
      s2: support({ id: 's2', parentBaseId: 's1', parentTipId: 's3' }),
      s3: support({ id: 's3', parentBaseId: 's1', parentTipId: null }),
    });

    const { nodes, malformed } = readLysNodes(data);

    assert.deepEqual(nodes.map((n) => n.id), ['s1', 's2', 's3']);
    assert.deepEqual(malformed, []);
    assert.equal(nodes[0].hostBaseId, null);
    assert.equal(nodes[0].hostTipId, null);
    assert.equal(nodes[1].hostBaseId, 's1');
    assert.equal(nodes[1].hostTipId, 's3');
  });

  it('carries the flags and settings the classifier keys on', () => {
    const data = sceneOf({
      s1: support({
        id: 's1',
        objectIdTip: 'o1',
        mini: true,
        isBaseTip: true,
        gridNodeIndex: 385,
        baseNormal: { x: 0, y: 1, z: 0 },
        settings: { tip: { length: 3 }, base: { joinLength: 80.25 } },
      }),
    });

    const [node] = readLysNodes(data).nodes;

    assert.equal(node.mini, true);
    assert.equal(node.isBaseTip, true);
    assert.equal(node.gridNodeIndex, 385);
    assert.deepEqual(node.baseNormal, { x: 0, y: 1, z: 0 });
    assert.equal(node.tipNormal, undefined);
    assert.equal(node.objectIdTip, 'o1');
    assert.equal(node.objectIdBase, null);
    assert.equal(node.settings?.base?.joinLength, 80.25);
  });

  it('drops a record with no usable endpoint instead of inventing one', () => {
    const data = sceneOf({
      good: support({ id: 'good' }),
      noBase: support({ id: 'noBase', base: undefined }),
      nanTip: support({ id: 'nanTip', tip: { x: Number.NaN, y: 0, z: 0 } }),
    });

    const { nodes, malformed } = readLysNodes(data);

    assert.deepEqual(nodes.map((n) => n.id), ['good']);
    assert.deepEqual(malformed.sort(), ['nanTip', 'noBase']);
  });

  it('treats a blank or absent ref as a free end, and accepts a numeric id', () => {
    const data = sceneOf({
      s1: support({ id: 's1', parentBaseId: '   ', parentTipId: 5 as unknown as string }),
    });

    const [node] = readLysNodes(data).nodes;

    assert.equal(node.hostBaseId, null);
    assert.equal(node.hostTipId, '5');
  });
});

describe('supportGraph.relateHosts', () => {
  it('records which end attaches, and indexes children under their host', () => {
    const { nodes } = readLysNodes(sceneOf({
      trunk: support({ id: 'trunk' }),
      childBase: support({ id: 'childBase', parentBaseId: 'trunk' }),
      childTip: support({ id: 'childTip', parentTipId: 'trunk' }),
    }));

    const { hostEdges, childrenByHost, diagnostics } = relateHosts(nodes);

    assert.deepEqual(hostEdges, [
      { childId: 'childBase', end: 'base', hostId: 'trunk' },
      { childId: 'childTip', end: 'tip', hostId: 'trunk' },
    ]);
    assert.deepEqual(childrenByHost.get('trunk'), hostEdges);
    assert.deepEqual(diagnostics.dangling, []);
    assert.deepEqual(diagnostics.cycles, []);
  });

  it('counts a two-host node once per end', () => {
    const { nodes } = readLysNodes(sceneOf({
      a: support({ id: 'a' }),
      b: support({ id: 'b' }),
      span: support({ id: 'span', parentBaseId: 'a', parentTipId: 'b' }),
    }));

    const graph = { ...relateHosts(nodes), nodes, diagnostics: { malformed: [], dangling: [], malformedHosts: [], selfRefs: [], cycles: [] } };

    assert.equal(degreeOf(graph.byId.get('span')!), 2);
    assert.deepEqual(degreeHistogram(graph), { '0': 2, '1': 0, '2': 1 });
  });

  it('separates a dangling ref from a self ref', () => {
    const { nodes } = readLysNodes(sceneOf({
      a: support({ id: 'a', parentBaseId: 'ghost', parentTipId: 'a' }),
    }));

    const { hostEdges, diagnostics } = relateHosts(nodes);

    assert.deepEqual(hostEdges, []);
    assert.deepEqual(diagnostics.dangling, [{ childId: 'a', end: 'base', hostId: 'ghost' }]);
    assert.deepEqual(diagnostics.selfRefs, [{ childId: 'a', end: 'tip', hostId: 'a' }]);
  });

  it('reports a host cycle rather than looping', () => {
    const { nodes } = readLysNodes(sceneOf({
      a: support({ id: 'a', parentBaseId: 'b' }),
      b: support({ id: 'b', parentBaseId: 'a' }),
    }));

    const { diagnostics } = relateHosts(nodes);

    assert.equal(diagnostics.cycles.length, 1);
    assert.deepEqual([...diagnostics.cycles[0]].sort(), ['a', 'b']);
  });
});

describe('supportGraph.buildSupportGraph', () => {
  it('throws on a dangling ref, naming it', () => {
    const data = sceneOf({ a: support({ id: 'a', parentBaseId: 'ghost' }) });

    assert.throws(() => buildSupportGraph(data), /dangling host ref.*a\.base -> ghost/);
  });

  it('throws on a cycle', () => {
    const data = sceneOf({
      a: support({ id: 'a', parentBaseId: 'b' }),
      b: support({ id: 'b', parentTipId: 'a' }),
    });

    assert.throws(() => buildSupportGraph(data), /host cycle/);
  });

  it('collects rather than throws when a slice legitimately misses a host', () => {
    const data = sceneOf({ child: support({ id: 'child', parentBaseId: 'other-object-host' }) });

    const graph = buildSupportGraph(data, { strict: false });

    assert.deepEqual(graph.diagnostics.dangling, [{ childId: 'child', end: 'base', hostId: 'other-object-host' }]);
    assert.equal(graph.hostEdges.length, 0);
  });

  it('reports malformed records alongside the edges', () => {
    const data = sceneOf({
      good: support({ id: 'good' }),
      bad: support({ id: 'bad', base: undefined }),
    });

    const graph = buildSupportGraph(data, { strict: false });

    assert.deepEqual(graph.diagnostics.malformed, ['bad']);
    assert.deepEqual(graph.nodes.map((n) => n.id), ['good']);
  });

  it('treats a ref to a dropped record as broken source, not a broken graph', () => {
    // The corpus has this shape: a record whose base is {x:null,y:null,z:null}
    // while another support names it as a host.
    const data = sceneOf({
      broken: support({ id: 'broken', base: { x: Number.NaN, y: 0, z: 0 } }),
      child: support({ id: 'child', parentBaseId: 'broken' }),
    });

    const graph = buildSupportGraph(data);

    assert.deepEqual(graph.diagnostics.malformed, ['broken']);
    assert.deepEqual(graph.diagnostics.malformedHosts, [{ childId: 'child', end: 'base', hostId: 'broken' }]);
    assert.deepEqual(graph.diagnostics.dangling, []);
    assert.deepEqual(graph.hostEdges, []);
  });
});

describe('supportGraph.emissionOrder', () => {
  it('places a host before every node that attaches to it', () => {
    const graph = buildSupportGraph(sceneOf({
      child: support({ id: 'child', parentBaseId: 'mid' }),
      mid: support({ id: 'mid', parentBaseId: 'root' }),
      root: support({ id: 'root' }),
      free: support({ id: 'free' }),
    }));

    const order = emissionOrder(graph).map((n) => n.id);

    assert.ok(order.indexOf('root') < order.indexOf('mid'));
    assert.ok(order.indexOf('mid') < order.indexOf('child'));
    assert.equal(order.length, 4);
  });

  it('terminates on a cycle and still emits every node', () => {
    const graph = buildSupportGraph(sceneOf({
      a: support({ id: 'a', parentBaseId: 'b' }),
      b: support({ id: 'b', parentBaseId: 'a' }),
    }), { strict: false });

    const order = emissionOrder(graph).map((n) => n.id);

    assert.equal(order.length, 2);
  });

  it('keeps a node whose host is outside the slice', () => {
    const graph = buildSupportGraph(sceneOf({
      child: support({ id: 'child', parentBaseId: 'elsewhere' }),
    }), { strict: false });

    assert.deepEqual(emissionOrder(graph).map((n) => n.id), ['child']);
  });
});
