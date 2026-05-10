import { describe, it } from 'node:test';
import assert from 'node:assert';
import { LysParser } from './LysParser';

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

describe('LysParser.parseGeometry', () => {
  it('parses geometry payloads that declare header length larger than 20 bytes', () => {
    const geometry = (LysParser as any).parseGeometry(buildGeometryBlob({ headerLength: 24 }));

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
      () => (LysParser as any).parseGeometry(malformed),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'Expected Error instance');
        assert.ok(!(err instanceof RangeError), 'Expected parser validation error, not typed array RangeError');
        assert.match(err.message, /Geometry payload byte length mismatch/);
        return true;
      },
    );
  });
});
