import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { LysParser } from './LysParser';

/** The parser's private statics, reached deliberately: these tests cover the
 *  geometry paths directly rather than through a whole .lys container. */
type LysParserInternals = {
  legacyAttrStrideScore(view: DataView, dataOffset: number, totalBytes: number): number;
  parseLegacyGeometry(buffer: ArrayBuffer): THREE.BufferGeometry;
  parseGeometry(buffer: ArrayBuffer): THREE.BufferGeometry;
};
const parserInternals = LysParser as unknown as LysParserInternals;

function buildGeometryBlob(options?: {
  headerLength?: number;
  indices?: number[];
  coords?: number[];
}): ArrayBuffer {
  const headerLength = options?.headerLength ?? 20;
  const indices = options?.indices ?? [0, 1, 2];
  const coords = options?.coords ?? [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ];

  const totalBytes = headerLength + indices.length * 4 + coords.length * 4;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);

  // Minimal geometry header
  view.setUint32(0, 1, true); // version
  view.setUint32(4, headerLength, true);
  view.setUint32(8, indices.length, true);
  view.setUint32(12, coords.length, true);
  view.setUint32(16, 0, true);

  let offset = headerLength;
  for (const index of indices) {
    view.setUint32(offset, index, true);
    offset += 4;
  }

  for (const scalar of coords) {
    view.setFloat32(offset, scalar, true);
    offset += 4;
  }

  return buffer;
}

// Builds a stride-48 legacy binary blob: each triangle is [V0, V1, V2, Attr] × 12 bytes.
function buildLegacyStride48Blob(
  triangles: Array<{
    v0: [number, number, number];
    v1: [number, number, number];
    v2: [number, number, number];
    attr: [number, number, number];
  }>,
): ArrayBuffer {
  const STRIDE = 48;
  const buffer = new ArrayBuffer(triangles.length * STRIDE);
  const view = new DataView(buffer);
  const writeVec3 = (off: number, v: [number, number, number]) => {
    view.setFloat32(off,     v[0], true);
    view.setFloat32(off + 4, v[1], true);
    view.setFloat32(off + 8, v[2], true);
  };
  for (let t = 0; t < triangles.length; t++) {
    const { v0, v1, v2, attr } = triangles[t];
    const base = t * STRIDE;
    writeVec3(base,      v0);
    writeVec3(base + 12, v1);
    writeVec3(base + 24, v2);
    writeVec3(base + 36, attr);
  }
  return buffer;
}

// Two non-degenerate triangles: vertex XY ≈ 14–22 mm, attr XY ≈ 0.7 mm.
// After the X↔Z swap: v0 raw(10,20,30) → pos(30,20,10).
const LEGACY_TRIS: Array<{
  v0: [number, number, number];
  v1: [number, number, number];
  v2: [number, number, number];
  attr: [number, number, number];
}> = [
  { v0: [10, 20, 30], v1: [20, 10, 30], v2: [10, 10, 40], attr: [0.7, 0.5, 1.0] },
  { v0: [11, 21, 31], v1: [21, 11, 31], v2: [11, 11, 41], attr: [0.6, 0.4, 0.9] },
];

describe('LysParser.legacyAttrStrideScore', () => {
  it('returns a score ≥ 5 when every 4th triplet has small XY and the others have large XY', () => {
    const buffer = buildLegacyStride48Blob(LEGACY_TRIS);
    const view = new DataView(buffer);
    const score = parserInternals.legacyAttrStrideScore(view, 0, buffer.byteLength);
    assert.ok(score >= 5, `Expected score >= 5 for stride-48 pattern, got ${score}`);
  });

  it('returns 0 when all triplets have similar XY magnitudes (no stride pattern)', () => {
    // 8 triplets all with large XY — no attr-stride contrast.
    const buffer = new ArrayBuffer(8 * 12);
    const view = new DataView(buffer);
    for (let i = 0; i < 8; i++) {
      view.setFloat32(i * 12,     20 + i, true);
      view.setFloat32(i * 12 + 4, 15 + i, true);
      view.setFloat32(i * 12 + 8, 10 + i, true);
    }
    const score = parserInternals.legacyAttrStrideScore(view, 0, buffer.byteLength);
    assert.strictEqual(score, 0, 'Score should be 0 when no attr-stride XY contrast is present');
  });
});

describe('LysParser.parseLegacyGeometry', () => {
  it('produces the correct vertex count from a stride-48 buffer', () => {
    const buffer = buildLegacyStride48Blob(LEGACY_TRIS);
    const geom = parserInternals.parseLegacyGeometry(buffer);
    const posAttr = geom.getAttribute('position');
    assert.strictEqual(posAttr.count, 6, 'Two stride-48 triangles should yield 6 vertices');
  });

  it('swaps raw X↔Z when extracting positions from a stride-48 buffer', () => {
    const buffer = buildLegacyStride48Blob(LEGACY_TRIS);
    const geom = parserInternals.parseLegacyGeometry(buffer);
    const positions = geom.getAttribute('position').array as Float32Array;
    // v0 raw: x=10, y=20, z=30 → after X↔Z swap: posX=30, posY=20, posZ=10
    assert.ok(Math.abs(positions[0] - 30) < 1e-4, `Position X should be raw Z (30), got ${positions[0]}`);
    assert.ok(Math.abs(positions[1] - 20) < 1e-4, `Position Y should be raw Y (20), got ${positions[1]}`);
    assert.ok(Math.abs(positions[2] - 10) < 1e-4, `Position Z should be raw X (10), got ${positions[2]}`);
  });

  it('computes vertex normals on the resulting geometry', () => {
    const buffer = buildLegacyStride48Blob(LEGACY_TRIS);
    const geom = parserInternals.parseLegacyGeometry(buffer);
    const normalAttr = geom.getAttribute('normal');
    assert.ok(normalAttr, 'Parsed legacy geometry should include a normal attribute');
    assert.ok(normalAttr.count > 0, 'Normal attribute should have at least one entry');
  });

  it('throws when the buffer is too short to contain any vertex data', () => {
    assert.throws(
      () => parserInternals.parseLegacyGeometry(new ArrayBuffer(10)),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'Expected Error instance');
        return true;
      },
    );
  });
});

function buildLysFile(stems: string[]): File {
  const blobs = new Map<string, ArrayBuffer>();
  for (const stem of stems) {
    blobs.set(stem, buildGeometryBlob());
  }

  const mangoFiles: Record<string, { offset: number; size: number }> = {};
  let offset = 0;
  for (const [stem, blob] of blobs) {
    mangoFiles[`${stem}.bin`] = { offset, size: blob.byteLength };
    offset += blob.byteLength;
  }

  const manifestStr = JSON.stringify({ version: '1', mangoFiles });
  const manifestBytes = new TextEncoder().encode(manifestStr);

  const fullBuffer = new Uint8Array(manifestBytes.byteLength + 1 + offset);
  fullBuffer.set(manifestBytes, 0);
  fullBuffer[manifestBytes.byteLength] = 0; // null padding — dataStart scan skips this

  let dataOffset = manifestBytes.byteLength + 1;
  for (const [, blob] of blobs) {
    fullBuffer.set(new Uint8Array(blob), dataOffset);
    dataOffset += blob.byteLength;
  }

  return new File([fullBuffer], 'test.lys', { type: 'application/octet-stream' });
}

describe('LysParser.parseGeometry', () => {
  it('parses geometry payloads that declare header length larger than 20 bytes', () => {
    const geometry = parserInternals.parseGeometry(buildGeometryBlob({ headerLength: 24 }));

    const posAttr = geometry.getAttribute('position');
    assert.ok(posAttr, 'Expected parsed geometry to include position attribute');
    assert.ok(posAttr.count > 0, 'Expected parsed geometry to include vertices');
  });

  it('throws controlled validation errors for malformed payload lengths', () => {
    const malformed = new ArrayBuffer(31);
    const view = new DataView(malformed);

    // Looks like a geometry header, but declares impossible payload lengths.
    view.setUint32(0, 1, true);
    view.setUint32(4, 20, true);
    view.setUint32(8, 4, true);
    view.setUint32(12, 12, true);

    assert.throws(
      () => parserInternals.parseGeometry(malformed),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'Expected Error instance');
        assert.ok(!(err instanceof RangeError), 'Expected parser validation error, not typed array RangeError');
        assert.match(err.message, /Geometry payload byte length mismatch/);
        return true;
      },
    );
  });
});

describe('LysParser.parse - geometryOrder', () => {
  it('lists non-hollowing stems in manifest insertion order', async () => {
    const file = buildLysFile(['o1', 'o1_hollowing', 'o2']);
    const result = await LysParser.parse(file);
    assert.deepStrictEqual(result.geometryOrder, ['o1', 'o2'],
      'geometryOrder should exclude _hollowing stems and preserve manifest insertion order');
  });

  it('returns a single-element geometryOrder for a lone geometry stem', async () => {
    const file = buildLysFile(['o15']);
    const result = await LysParser.parse(file);
    assert.deepStrictEqual(result.geometryOrder, ['o15']);
  });

  it('preserves insertion order even when stems appear non-alphabetically in manifest', async () => {
    const file = buildLysFile(['o3', 'o1', 'o2']);
    const result = await LysParser.parse(file);
    assert.deepStrictEqual(result.geometryOrder, ['o3', 'o1', 'o2'],
      'geometryOrder must follow manifest order, not sort stems by name or ID');
  });

  it('excludes all _hollowing variants when only hollowing stems are present', async () => {
    const file = buildLysFile(['o1_hollowing']);
    const result = await LysParser.parse(file);
    // The hollowing blob is still used as geometry fallback, but must not appear in geometryOrder
    assert.deepStrictEqual(result.geometryOrder, []);
  });

  it('excludes stems whose binary payload fails to parse', async () => {
    // Build manifest manually so one blob is truncated (will throw in parseGeometry)
    const goodBlob = buildGeometryBlob();
    const badBlob = new ArrayBuffer(8); // below minimum 20-byte header — will be rejected

    const mangoFiles = {
      'good.bin': { offset: 0, size: goodBlob.byteLength },
      'bad.bin': { offset: goodBlob.byteLength, size: badBlob.byteLength },
    };
    const manifestStr = JSON.stringify({ version: '1', mangoFiles });
    const manifestBytes = new TextEncoder().encode(manifestStr);

    const totalDataSize = goodBlob.byteLength + badBlob.byteLength;
    const fullBuffer = new Uint8Array(manifestBytes.byteLength + 1 + totalDataSize);
    fullBuffer.set(manifestBytes, 0);
    fullBuffer[manifestBytes.byteLength] = 0;
    fullBuffer.set(new Uint8Array(goodBlob), manifestBytes.byteLength + 1);
    fullBuffer.set(new Uint8Array(badBlob), manifestBytes.byteLength + 1 + goodBlob.byteLength);

    const result = await LysParser.parse(new File([fullBuffer], 'test.lys'));
    assert.deepStrictEqual(result.geometryOrder, ['good'],
      'Stems whose binary payload cannot be parsed should not appear in geometryOrder');
  });
});

describe('LysParser.parseLegacyGeometry with a triangle-count header', () => {
  // The first triangles of a real legacy blob ([u32 count][V0, V1, V2, normal] × count).
  // Without the count, the offset probe scores byte 8 above byte 4 and reads every
  // vertex one float late, scrambling the whole mesh.
  const RAW = [
    [-0.905, 0.206, -11.061, -0.945, 0.852, -10.939, -0.937, 0.73, -10.987, 0.9981, 0.0584, 0.018],
    [-1.107, 1.652, -10.859, -1.111, 1.682, -10.867, -1.105, 1.662, -10.871, 0.9208, 0.2105, 0.3284],
    [-0.937, 0.73, -10.987, -0.919, 0.458, -11.047, -0.905, 0.206, -11.061, 0.9966, 0.0518, 0.0641],
    [-1.105, 1.662, -10.871, -1.085, 1.578, -10.883, -1.055, 1.466, -10.887, 0.9307, 0.2585, -0.2586],
  ];

  function buildCountedBlob(): ArrayBuffer {
    const buffer = new ArrayBuffer(4 + RAW.length * 48);
    const view = new DataView(buffer);
    view.setUint32(0, RAW.length, true);
    RAW.flat().forEach((f, i) => view.setFloat32(4 + i * 4, f, true));
    return buffer;
  }

  it('reads vertices from just after the count', () => {
    const positions = parserInternals.parseLegacyGeometry(buildCountedBlob())
      .getAttribute('position').array as Float32Array;
    assert.strictEqual(positions.length, RAW.length * 9);
    for (let t = 0; t < RAW.length; t++) {
      for (let v = 0; v < 3; v++) {
        const [x, y, z] = RAW[t].slice(v * 3, v * 3 + 3);
        const got = Array.from(positions.subarray(t * 9 + v * 3, t * 9 + v * 3 + 3));
        // X↔Z swap, as for every legacy blob.
        [z, y, x].forEach((want, a) =>
          assert.ok(Math.abs(got[a] - want) < 1e-4, `tri ${t} vert ${v}: expected ${[z, y, x]}, got ${got}`));
      }
    }
  });
});
