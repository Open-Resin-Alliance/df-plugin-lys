import { describe, it } from 'node:test';
import assert from 'node:assert';
import { decideKnot, type HostSkeleton } from './knotPolicy';

/** A trunk's skeleton: collar at 2.05 up to the socket at 30, in two segments. */
const trunkHost: HostSkeleton = {
  kind: 'trunk',
  segments: [
    { id: 'seg0', start: { x: 0, y: 0, z: 2.05 }, end: { x: 0, y: 0, z: 20 } },
    { id: 'seg1', start: { x: 0, y: 0, z: 20 }, end: { x: 0, y: 0, z: 30 } },
  ],
};

const knot = (over: Partial<Parameters<typeof decideKnot>[0]> = {}) => decideKnot({
  attachPoint: { x: 0.2, y: 0, z: 10 },
  sourceTipMinusBaseZ: 10,
  contactPoint: { x: 0, y: 0, z: 20 },
  host: trunkHost,
  usedExplicitParentHint: true,
  isLikelyLeafLike: false,
  ...over,
});

describe('knotPolicy — position', () => {
  it('keeps the authored point when it sits on the host', () => {
    const decision = knot();

    assert.ok(decision);
    assert.equal(decision.chose, 'authored');
    assert.deepEqual(decision.pos, { x: 0.2, y: 0, z: 10 });
    // Measured from the segment's own start (the collar), not from the plate.
    assert.ok(Math.abs(decision.t - (10 - 2.05) / 17.95) < 1e-9);
    assert.equal(decision.outOfSegment, false);
  });

  it('keeps the authored point when the source gave no end hint, even far off the host', () => {
    const decision = knot({ attachPoint: { x: 5, y: 0, z: 10 }, usedExplicitParentHint: false });

    assert.ok(decision);
    assert.equal(decision.chose, 'projected');
    assert.deepEqual(decision.pos, { x: 0, y: 0, z: 10 });
  });

  it('projects onto the skeleton when the authored point is far off it mid-span', () => {
    const decision = knot({ attachPoint: { x: 5, y: 0, z: 10 } });

    assert.ok(decision);
    assert.equal(decision.chose, 'projected');
    assert.deepEqual(decision.pos, { x: 0, y: 0, z: 10 });
    assert.ok(Math.abs(decision.deltaMm - 5) < 1e-9);
  });

  it('keeps an authored point clamped past the host tip, and says the t is out of segment', () => {
    const decision = knot({ attachPoint: { x: 5, y: 0, z: 31 } });

    assert.ok(decision);
    assert.equal(decision.chose, 'authored');
    assert.deepEqual(decision.pos, { x: 5, y: 0, z: 31 });
    assert.equal(decision.parentShaftId, 'seg1');
    // The old code would have reported 1 here: the parameter of the projection.
    assert.ok(decision.t > 1);
    assert.equal(decision.outOfSegment, true);
  });

  it('keeps a leaf-like base resting on the root pad rather than clamping it up', () => {
    const decision = knot({ attachPoint: { x: 0.3, y: 0, z: 1 }, isLikelyLeafLike: true });

    assert.ok(decision);
    assert.equal(decision.chose, 'authored');
    assert.deepEqual(decision.pos, { x: 0.3, y: 0, z: 1 });
    assert.ok(decision.t < 0);
    assert.equal(decision.outOfSegment, true);
  });

  it('clamps a leaf-like base that is below the plate, since nothing holds it there', () => {
    const decision = knot({ attachPoint: { x: 0.3, y: 0, z: -1 }, isLikelyLeafLike: true });

    assert.ok(decision);
    assert.equal(decision.chose, 'projected');
    assert.deepEqual(decision.pos, { x: 0, y: 0, z: 2.05 });
  });

  it('keeps a non-leaf-like base clamp even with a large z drift', () => {
    const decision = knot({ attachPoint: { x: 0.3, y: 0, z: 1 } });

    assert.ok(decision);
    assert.equal(decision.chose, 'authored');
  });

  it('flips to the authored point when the projection lands past the tip of the child', () => {
    const decision = knot({
      attachPoint: { x: 5, y: 0, z: 25 },
      sourceTipMinusBaseZ: 19,
      contactPoint: { x: 0, y: 0, z: 20 },
    });

    assert.ok(decision);
    assert.equal(decision.chose, 'authored');
    assert.deepEqual(decision.pos, { x: 5, y: 0, z: 25 });
  });

  it('reprojects strictly onto a twig host, whatever the authored point says', () => {
    const twigHost: HostSkeleton = {
      kind: 'twig',
      segments: [{ id: 'seg-twig', start: { x: 0, y: 0, z: 10 }, end: { x: 0, y: 0, z: 20 } }],
    };
    const decision = knot({ attachPoint: { x: 0.3, y: 0, z: 15 }, host: twigHost });

    assert.ok(decision);
    assert.equal(decision.chose, 'projected');
    assert.deepEqual(decision.pos, { x: 0, y: 0, z: 15 });
    assert.equal(decision.parentShaftId, 'seg-twig');
  });

  it('reports the segment a multi-segment host clamped to', () => {
    const decision = knot({ attachPoint: { x: 0, y: 0, z: 25 } });

    assert.ok(decision);
    assert.equal(decision.parentShaftId, 'seg1');
    assert.ok(Math.abs(decision.t - 0.5) < 1e-9);
  });

  it('returns null when the host publishes no skeleton', () => {
    assert.equal(knot({ host: { kind: 'trunk', segments: [] } }), null);
  });
});
