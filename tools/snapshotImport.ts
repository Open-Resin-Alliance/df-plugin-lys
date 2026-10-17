/**
 * Acceptance snapshot of the WHOLE import, driven through the registered entry
 * point: parse, convert per object, drop, rotate, place.
 *
 * `snapshotLys.ts` calls the emitter directly, so it sees neither the per-object
 * ghost mesh nor the transform passes that follow conversion. Every frame bug
 * found so far lives in those passes, which is what this covers.
 *
 * Usage: node --import tsx plugins/lys-import/tools/snapshotImport.ts <file.lys> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { importLysFile, type LysImportPayload } from '../fileTypeHandlers';
import { snapshotOf, type FormatLike } from './snapshotFormat';

const q = (n: number | undefined) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : null);

/** One payload, keyed by what it is rather than by the ids regenerated each run. */
function payloadSnapshot(payload: LysImportPayload, warnings: string[]) {
  const t = payload.transform;
  return {
    transform: {
      position: [q(t.position.x), q(t.position.y), q(t.position.z)],
      rotation: [q(t.rotation.x), q(t.rotation.y), q(t.rotation.z)],
      scale: [q(t.scale.x), q(t.scale.y), q(t.scale.z)],
    },
    vertexCount: payload.geometry.getAttribute('position')?.count ?? 0,
    hollowing: !!payload.meshModifiers?.hollowing,
    holePunches: payload.meshModifiers?.holePunches?.length ?? 0,
    ...snapshotOf((payload.supportData ?? {}) as unknown as FormatLike, warnings),
  };
}

async function main(): Promise<void> {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) throw new Error('usage: snapshotImport.ts <file.lys> <out.json>');

  const buf = readFileSync(inPath);
  const file = new File([new Uint8Array(buf)], basename(inPath));

  const warnings: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  let result: LysImportPayload | LysImportPayload[];
  try {
    result = await importLysFile(file);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  // Payloads are snapshotted in the order the importer returns them, which is the
  // order the scene lists its objects.
  const payloads = Array.isArray(result) ? result : [result];
  const snapshot = {
    payloadCount: payloads.length,
    payloads: payloads.map((p) => payloadSnapshot(p, warnings)),
  };

  writeFileSync(outPath, JSON.stringify(snapshot, null, 1));
  console.log(`wrote ${outPath}`);
  console.log(`payloads: ${payloads.length}`);
  for (const [i, p] of snapshot.payloads.entries()) {
    console.log(`  [${i}] counts: ${JSON.stringify(p.counts)}`);
    console.log(`      integrity: ${JSON.stringify(p.knotIntegrity)}  transform.pos: ${JSON.stringify(p.transform.position)}`);
  }
}

main();
