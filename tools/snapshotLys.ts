/**
 * Dumps a stable, id-independent summary of a converted .lys file so a
 * conversion change can be diffed before/after. Ids are excluded because they
 * are regenerated every run; geometry and topology are what must match.
 *
 * Two modes, and they cover different code:
 *
 *  - default: convert with no mesh. This is the historical harness, and the mode
 *    the checked-in baselines were captured in.
 *  - `--mesh`: reproduce the file-type path instead — the object rotation with Z
 *    stripped, plus the same ghost mesh that path builds. The contact-normal
 *    raycast and the plate drop exist ONLY in this mode, so a regression there is
 *    invisible without it.
 *
 * Usage: node --import tsx plugins/lys-import/tools/snapshotLys.ts <file.lys> <out.json> [--mesh]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { LysParser } from '../LysParser';
import { emitSupportGraph } from '../converter/graphEmit';
import { createDefaultSettings } from '@/supports/Settings';
import { quaternionFromGlobalEulerDegrees } from '@/utils/rotation';
import { snapshotOf, type FormatLike } from './snapshotFormat';
import type { LysData } from '../converter/types';

interface Vec3Like { x: number; y: number; z: number }
interface ObjectLike {
  id?: string;
  formerCenter?: Vec3Like;
  center?: Vec3Like;
  position?: Vec3Like;
  rotation?: Vec3Like;
  scale?: Vec3Like;
}
type SceneLike = LysData & {
  objects?: { present?: { byId?: Record<string, ObjectLike> } };
};
interface ParsedScene {
  sceneData: SceneLike;
  geometry: THREE.BufferGeometry;
  geometriesByName: Map<string, THREE.BufferGeometry>;
}

/**
 * The object rotation the file-type path converts with: Z is applied to the
 * whole model afterwards instead of to each support, so the clone it hands the
 * converter has Z zeroed.
 */
function withZStrippedRotation(scene: SceneLike): SceneLike {
  const clone = JSON.parse(JSON.stringify(scene)) as SceneLike;
  for (const obj of Object.values(clone.objects?.present?.byId ?? {})) {
    const r = obj.rotation;
    if (r) obj.rotation = { x: r.x, y: r.y, z: 0 };
  }
  return clone;
}

/**
 * The ghost mesh the file-type path builds for an object: a group at the object's
 * lift holding the geometry offset by `-pivot`. That offset is why a raycast has
 * to be given points in this frame rather than in the payload's.
 */
function buildGhostMesh(parsed: ParsedScene, scene: SceneLike, objId: string): THREE.Mesh | undefined {
  const obj = scene.objects?.present?.byId?.[objId];
  if (!obj) return undefined;
  const geometry = parsed.geometriesByName.get(objId) ?? parsed.geometry;
  const center = obj.formerCenter ?? obj.center ?? { x: 0, y: 0, z: 0 };
  const position = obj.position ?? { x: 0, y: 0, z: 0 };
  const scale = obj.scale ?? { x: 1, y: 1, z: 1 };
  const rotation = obj.rotation ?? { x: 0, y: 0, z: 0 };

  const group = new THREE.Group();
  group.position.set(0, 0, position.z);
  group.scale.set(scale.x, scale.y, scale.z);
  group.quaternion.copy(quaternionFromGlobalEulerDegrees(rotation));

  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.position.set(-center.x, -center.y, -center.z);
  group.add(mesh);
  group.updateMatrixWorld(true);
  geometry.computeBoundingSphere();
  return mesh;
}

async function main(): Promise<void> {
  const [, , inPath, outPath, ...flags] = process.argv;
  if (!inPath || !outPath) throw new Error('usage: snapshotLys.ts <file.lys> <out.json> [--mesh]');
  const withMesh = flags.includes('--mesh');

  const buf = readFileSync(inPath);
  // The parser's runtime payload is the scene object plus the geometry it decoded,
  // which is what this tool reads; the plugin's own type describes a narrower view.
  const parsed = (await LysParser.parse(new File([new Uint8Array(buf)], 'input.lys'))) as unknown as ParsedScene;

  const warnings: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  let out: FormatLike;
  try {
    if (withMesh) {
      const scene = withZStrippedRotation(parsed.sceneData);
      const firstObjId = Object.keys(scene.objects?.present?.byId ?? {})[0] ?? '';
      // One mesh, for the object the payload leads with: the file-type path builds
      // one per object and converts per object, which this single-shot harness
      // does not model. Multi-object files want a per-object run.
      out = emitSupportGraph(scene, createDefaultSettings(), buildGhostMesh(parsed, scene, firstObjId)).format as unknown as FormatLike;
    } else {
      out = emitSupportGraph(parsed.sceneData, createDefaultSettings()).format as unknown as FormatLike;
    }
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  const snapshot = snapshotOf(out, warnings);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 1));
  console.log(`wrote ${outPath}${withMesh ? ' (mesh mode)' : ''}`);
  console.log('counts:', JSON.stringify(snapshot.counts));
  console.log('knot integrity:', JSON.stringify(snapshot.knotIntegrity));
}

main();
