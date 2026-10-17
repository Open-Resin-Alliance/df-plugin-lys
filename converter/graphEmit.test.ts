import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createDefaultSettings } from '@/supports/Settings/types';
import { emitSupportGraph, makeObjectFrame } from './graphEmit';
import type { LysData, LysSupport } from './types';

const settings = createDefaultSettings();

const support = (over: Partial<LysSupport>): LysSupport => ({
  id: 'x',
  base: { x: 0, y: 0, z: 0 },
  tip: { x: 0, y: 0, z: 1 },
  ...over,
});

/** A floating two-contact support well above the plate. */
const floating = (over: Partial<LysSupport>): LysSupport => support({
  baseNormal: { x: 0, y: 0, z: 1 },
  tipNormal: { x: 0, y: 0, z: -1 },
  base: { x: 0, y: 0, z: 10 },
  tip: { x: 0, y: 0, z: 16 },
  ...over,
});

const sceneOf = (byId: Record<string, LysSupport>): LysData => ({
  supports: { present: { byId } },
  objects: { present: { byId: { o1: { id: 'o1', position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 } } } } },
});

describe('graphEmit — stick', () => {
  it('builds one stick with both contacts, and reports nothing unbuilt', () => {
    const { format, diagnostics } = emitSupportGraph(
      sceneOf({ s: floating({ id: 's', objectIdTip: 'o1' }) }),
      settings as never,
    );

    assert.equal(format.sticks.length, 1);
    assert.equal(format.sticks[0].contactConeA.pos.z, 10);
    assert.equal(format.sticks[0].contactConeB.pos.z, 16);
    assert.equal(format.sticks[0].modelId, 'o1');
    assert.deepEqual(diagnostics.notYetWired, []);
    assert.deepEqual(diagnostics.skipped, []);

    const segment = format.sticks[0].segments[0];
    assert.ok(segment.bottomJoint && segment.topJoint);
    assert.ok(segment.diameter > 0);
    assert.ok(segment.bottomJoint.diameter > segment.diameter * 0.9);
  });

  it('reads a shaft diameter from the authored join diameter first', () => {
    const { format } = emitSupportGraph(
      sceneOf({ s: floating({ id: 's', objectIdTip: 'o1', settings: { base: { joinDiameter: 3 } } }) }),
      settings as never,
    );

    assert.equal(format.sticks[0].segments[0].diameter, 3);
  });

  it('applies the object transform to both endpoints', () => {
    const data = sceneOf({ s: floating({ id: 's', objectIdTip: 'o1' }) });
    data.objects = { present: { byId: { o1: { id: 'o1', position: { x: 5, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 } } } } };

    const { format } = emitSupportGraph(data, settings as never);

    assert.equal(format.sticks[0].contactConeA.pos.x, 5);
    assert.equal(format.sticks[0].contactConeA.pos.z, 20);
  });

  it('drops a stick whose normal the transform collapses, naming it', () => {
    // The authored normal is usable (so this classifies as a stick), but the
    // object's zero Y scale collapses it during the transform — the guard's
    // real job, since a zero authored normal classifies as a trunk instead.
    const data = sceneOf({
      s: floating({ id: 's', objectIdTip: 'o1', tipNormal: { x: 0, y: 1, z: 0 } }),
    });
    data.objects = { present: { byId: { o1: { id: 'o1', position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 } } } } };

    const { format, diagnostics } = emitSupportGraph(data, settings as never);

    assert.equal(format.sticks.length, 0);
    assert.match(diagnostics.skipped.join(' '), /s: stick without a usable normal at the tip end/);
  });
});

describe('graphEmit — twig', () => {
  it('builds a twig whose joints sit off the disk centres along the surface normal', () => {
    // Floating with a 1mm span: a twig. No mesh in this path, so each disk keeps
    // its authored normal (the raycast fallback).
    const { format, diagnostics } = emitSupportGraph(
      sceneOf({ s: floating({ id: 's', objectIdTip: 'o1', tip: { x: 0, y: 0, z: 11 } }) }),
      settings as never,
    );

    assert.equal(format.twigs.length, 1);
    assert.deepEqual(diagnostics.notYetWired, []);
    const twig = format.twigs[0];
    assert.equal(twig.contactDiskA.pos.z, 10);
    assert.equal(twig.contactDiskB.pos.z, 11);

    const segment = twig.segments[0];
    // Each joint is the disk centre pushed along that disk's surface normal.
    assert.ok(segment.bottomJoint);
    assert.ok(segment.topJoint);
    assert.notEqual(segment.bottomJoint.pos.z, twig.contactDiskA.pos.z);
    assert.equal(segment.bottomJoint.pos.x, twig.contactDiskA.pos.x);
    assert.ok(segment.bottomJoint.diameter > 0);
  });

  it('sizes a twig joint by the multiplicative taper rule, not the additive one', () => {
    const { format } = emitSupportGraph(
      sceneOf({
        s: floating({ id: 's', objectIdTip: 'o1', tip: { x: 0, y: 0, z: 11 }, settings: { tip: { pointDiameter: 2 }, baseTip: { pointDiameter: 2 } } }),
      }),
      settings as never,
    );

    const segment = format.twigs[0].segments[0];
    assert.ok(Math.abs((segment.bottomJoint?.diameter ?? 0) - 2 * 1.1) < 1e-9);
    assert.ok(Math.abs((segment.topJoint?.diameter ?? 0) - 2 * 1.1) < 1e-9);
    assert.equal(segment.diameter, 2);
  });

  it('clears the joint radius when it offsets a joint off its disk', () => {
    const { format } = emitSupportGraph(
      sceneOf({ s: floating({ id: 's', objectIdTip: 'o1', tip: { x: 0, y: 0, z: 11 } }) }),
      settings as never,
    );

    const twig = format.twigs[0];
    const jointRadius = (twig.segments[0].bottomJoint?.diameter ?? 0) / 2;
    assert.ok((twig.contactDiskA.diskLengthOverride ?? 0) >= jointRadius + 0.05 - 1e-9);
  });
});

describe('graphEmit — trunk', () => {
  const grounded = (over: Partial<LysSupport>): LysSupport => support({
    base: { x: 2, y: 3, z: 0.1 },
    tip: { x: 0, y: 0, z: 30 },
    ...over,
  });

  it('builds a root and a trunk whose collar clears the root geometry', () => {
    const { format, diagnostics } = emitSupportGraph(
      sceneOf({ s: grounded({ id: 's', objectIdTip: 'o1' }) }),
      settings as never,
    );

    assert.equal(format.trunks.length, 1);
    assert.equal(format.roots.length, 1);
    assert.deepEqual(diagnostics.notYetWired, []);

    const trunk = format.trunks[0];
    assert.equal(trunk.rootId, format.roots[0].id);
    assert.equal(trunk.segments.length, 2);
    // The first segment runs from the root collar, so it has no bottom joint.
    assert.equal(trunk.segments[0].bottomJoint, undefined);
    const collar = trunk.segments[0].topJoint;
    assert.ok(collar);
    assert.equal(collar.pos.z, settings.roots.diskHeightMm + settings.roots.coneHeightMm + 0.05);
    assert.equal(trunk.segments[1].bottomJoint?.id, collar.id);
    assert.ok(trunk.segments[1].topJoint);
  });

  it('carries the object position into the root, which is not put through the object transform', () => {
    const data = sceneOf({ s: grounded({ id: 's', objectIdTip: 'o1' }) });
    data.objects = { present: { byId: { o1: { id: 'o1', position: { x: 10, y: 20, z: 5 }, scale: { x: 2, y: 2, z: 2 }, rotation: { x: 0, y: 0, z: 90 }, center: { x: 0, y: 0, z: 0 } } } } };

    const { format } = emitSupportGraph(data, settings as never);

    // Scale and rotation must NOT touch the root: only the object's own XY moves it.
    assert.deepEqual(format.roots[0].transform.pos, { x: 12, y: 23, z: 0 });
  });

  it('takes the collar height from the authored join length when it exceeds the minima', () => {
    const { format } = emitSupportGraph(
      sceneOf({ s: grounded({ id: 's', objectIdTip: 'o1', settings: { base: { joinLength: 50 } } }) }),
      settings as never,
    );

    assert.equal(format.trunks[0].segments[0].topJoint?.pos.z, 50);
  });

  it('sizes the collar joint from the pillar, and the pillar from the join diameter', () => {
    const { format } = emitSupportGraph(
      sceneOf({ s: grounded({ id: 's', objectIdTip: 'o1', settings: { base: { joinDiameter: 2 } } }) }),
      settings as never,
    );

    const trunk = format.trunks[0];
    assert.equal(trunk.segments[0].diameter, 2);
    assert.equal(trunk.segments[0].topJoint?.diameter, 2.1);
    assert.equal(trunk.contactCone?.profile.bodyDiameterMm, 2);
  });
});

describe('graphEmit — brace and kickstand', () => {
  const twoTrunks = {
    hostA: support({ id: 'hostA', objectIdTip: 'o1', base: { x: 0, y: 0, z: 0.1 }, tip: { x: 0, y: 0, z: 30 } }),
    hostB: support({ id: 'hostB', objectIdTip: 'o1', base: { x: 10, y: 0, z: 0.1 }, tip: { x: 10, y: 0, z: 30 } }),
  };

  it('spans two hosts and shares one knot where two braces meet', () => {
    const { format, diagnostics } = emitSupportGraph(
      sceneOf({
        ...twoTrunks,
        // Both braces start at the same point on hostA.
        span1: support({ id: 'span1', objectIdTip: 'o1', parentBaseId: 'hostA', parentTipId: 'hostB', base: { x: 0, y: 0, z: 10 }, tip: { x: 10, y: 0, z: 10 } }),
        span2: support({ id: 'span2', objectIdTip: 'o1', parentBaseId: 'hostA', parentTipId: 'hostB', base: { x: 0, y: 0, z: 10 }, tip: { x: 10, y: 0, z: 20 } }),
      }),
      settings as never,
    );

    assert.deepEqual(diagnostics.notYetWired, []);
    assert.equal(format.braces.length, 2);
    // Four endpoints, but the two base ends are one site: three knots.
    assert.equal(format.knots.length, 3);
    assert.equal(format.braces[0].startKnotId, format.braces[1].startKnotId);
    assert.notEqual(format.braces[0].endKnotId, format.braces[1].endKnotId);
    // The knots sit at the authored endpoints, not at a projection.
    assert.deepEqual(format.knots.find((k) => k.id === format.braces[0].startKnotId)?.pos, { x: 0, y: 0, z: 10 });
    assert.equal(format.knots.find((k) => k.id === format.braces[0].startKnotId)?._importHint, 'braceImported');
  });

  it('roots a kickstand at the end that does not attach, and publishes it as a host', () => {
    const { format, diagnostics } = emitSupportGraph(
      sceneOf({
        host: support({ id: 'host', objectIdTip: 'o1', base: { x: 0, y: 0, z: 0.1 }, tip: { x: 0, y: 0, z: 30 } }),
        // Base on the plate, tip attaching to the host shaft: a grounded column.
        column: support({ id: 'column', objectIdTip: 'o1', parentTipId: 'host', base: { x: 0, y: 0, z: 0.1 }, tip: { x: 0, y: 0, z: 20 } }),
        // A brace onto the kickstand: girder members attach that way.
        span: support({ id: 'span', objectIdTip: 'o1', parentBaseId: 'column', parentTipId: 'host', base: { x: 0, y: 0, z: 22 }, tip: { x: 0, y: 0, z: 15 } }),
      }),
      settings as never,
    );

    assert.deepEqual(diagnostics.notYetWired, []);
    assert.equal(format.kickstands.length, 1);
    // The root is the base end, which is the grounded one.
    assert.equal(format.kickstands[0].root.transform.pos.z, 0);
    assert.equal(format.kickstands[0].root.transform.pos.y, 0);
    assert.equal(format.braces.length, 1);
  });

  it('roots a kickstand on a twig host, which carries a shaft to ride', () => {
    const { format, diagnostics } = emitSupportGraph(
      sceneOf({
        twigHost: floating({ id: 'twigHost', objectIdTip: 'o1', tip: { x: 0, y: 0, z: 14 } }),
        column: support({ id: 'column', objectIdTip: 'o1', parentTipId: 'twigHost', base: { x: 0, y: 0, z: 0.1 }, tip: { x: 0, y: 0, z: 13 } }),
      }),
      settings as never,
    );

    assert.deepEqual(diagnostics.skipped, []);
    assert.equal(format.kickstands.length, 1);
    // Grounded on the plate, reaching up to the twig floating in the print.
    assert.equal(format.kickstands[0].root.transform.pos.z, 0);
  });
});

describe('graphEmit — object frame', () => {
  const object = {
    id: 'o1',
    position: { x: 10, y: -20, z: 5 },
    scale: { x: 1, y: 1, z: 1 },
    rotation: { x: 0, y: 0, z: 0 },
    center: { x: 0, y: 0, z: 0 },
  };

  it('carries the object XY in the payload frame but not in the mesh frame', () => {
    const frame = makeObjectFrame(object as never);

    assert.deepEqual(frame.transformPoint({ x: 1, y: 2, z: 3 }), { x: 11, y: -18, z: 8 });
    // The ghost mesh's group sits at (0, 0, lift): a raycast aimed with the XY in
    // it is aimed a whole object-position away from the surface it should hit.
    assert.deepEqual(frame.meshFramePoint({ x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 8 });
  });

  it('keeps the two frames identical for an object at the origin', () => {
    const frame = makeObjectFrame({ ...object, position: { x: 0, y: 0, z: 5 } } as never);

    assert.deepEqual(frame.transformPoint({ x: 1, y: 2, z: 3 }), frame.meshFramePoint({ x: 1, y: 2, z: 3 }));
  });
});

describe('graphEmit — completeness', () => {
  it('builds every class the graph can hold, with nothing left pending', () => {
    const { format, diagnostics } = emitSupportGraph(
      sceneOf({
        // trunk -------------------------
        trunkA: support({ id: 'trunkA', objectIdTip: 'o1', base: { x: 0, y: 0, z: 0.1 }, tip: { x: 0, y: 0, z: 30 } }),
        trunkB: support({ id: 'trunkB', objectIdTip: 'o1', base: { x: 10, y: 0, z: 0.1 }, tip: { x: 10, y: 0, z: 30 } }),
        // branch, leaf, kickstand, brace --------
        branch: support({ id: 'branch', objectIdTip: 'o1', parentBaseId: 'trunkA', base: { x: 0, y: 0, z: 10 }, tip: { x: 0, y: 0, z: 20 }, settings: { tip: { length: 2 } } }),
        leaf: support({ id: 'leaf', objectIdTip: 'o1', parentBaseId: 'trunkA', base: { x: 0, y: 0, z: 12 }, tip: { x: 0, y: 0, z: 14 }, settings: { tip: { length: 2 } } }),
        column: support({ id: 'column', objectIdTip: 'o1', parentTipId: 'trunkA', base: { x: 0, y: 0, z: 0.1 }, tip: { x: 0, y: 0, z: 18 } }),
        span: support({ id: 'span', objectIdTip: 'o1', parentBaseId: 'trunkA', parentTipId: 'trunkB', base: { x: 0, y: 0, z: 20 }, tip: { x: 10, y: 0, z: 20 } }),
        // twig, stick ---------------------------
        twig: floating({ id: 'twig', objectIdTip: 'o1', tip: { x: 0, y: 0, z: 14 } }),
        stick: floating({ id: 'stick', objectIdTip: 'o1', tip: { x: 0, y: 0, z: 40 } }),
      }),
      settings as never,
    );

    assert.deepEqual(diagnostics.notYetWired, []);
    assert.deepEqual(diagnostics.skipped, []);
    assert.equal(format.trunks.length, 2);
    assert.equal(format.roots.length, 2);
    assert.equal(format.branches.length, 1);
    assert.equal(format.leaves.length, 1);
    assert.equal(format.braces.length, 1);
    assert.equal(format.kickstands.length, 1);
    assert.equal(format.twigs.length, 1);
    assert.equal(format.sticks.length, 1);
  });

  it('reports a scene with no objects rather than inventing an owner', () => {
    const { diagnostics } = emitSupportGraph({ supports: { present: { byId: { s: floating({ id: 's' }) } } } }, settings as never);

    assert.match(diagnostics.skipped.join(' '), /scene has no objects/);
  });
});
