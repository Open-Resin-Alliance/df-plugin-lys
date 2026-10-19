import * as THREE from 'three';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';

type BVHGeometry = THREE.BufferGeometry & { boundsTree?: MeshBVH };

/**
 * Give one mesh geometry a single BVH and its bounding sphere. Both converters
 * call this for every contact; the first call builds, the rest reuse.
 */
export function ensureMeshRaycastIndex(mesh: THREE.Mesh): void {
  const geometry = mesh.geometry as BVHGeometry;
  if (!geometry.boundsTree) geometry.boundsTree = new MeshBVH(geometry);
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
}

/**
 * Raycast through the geometry's BVH. Returns the same intersections the
 * mesh's normal raycast would, sorted nearest-first.
 */
export function raycastMeshBVH(mesh: THREE.Mesh, raycaster: THREE.Raycaster): THREE.Intersection[] {
  ensureMeshRaycastIndex(mesh);
  const intersects: THREE.Intersection[] = [];
  (acceleratedRaycast as (this: THREE.Mesh, r: THREE.Raycaster, hits: THREE.Intersection[]) => void)
    .call(mesh, raycaster, intersects);
  intersects.sort((a, b) => a.distance - b.distance);
  return intersects;
}
