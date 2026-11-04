import * as THREE from 'three';
import { decode } from '@msgpack/msgpack';
import type { LysData as LysSceneData } from './converter/types';

/** One entry of the manifest's `mangoFiles` map: where a blob lives in the file. */
interface LysManifestFile {
    offset?: number;
    size?: number;
}

/** The LYS manifest, of which only the file table is consumed here. */
interface LysManifest {
    mangoFiles?: Record<string, LysManifestFile>;
}

/**
 * LYS container parser.
 *
 * Pipeline:
 * 1) locate and parse JSON manifest header
 * 2) resolve binary payload spans from manifest offsets
 * 3) decode protected scene payload (`scene.bin`)
 * 4) parse geometry payload(s) into Three.js geometries
 */

const LYS_KEY_OBFUSCATION = 'DragonFruitFTW';
const LYS_DEFAULT_APP_ID_XOR: number[] = [
    0x25, 0x4a, 0x04, 0x02, 0x5e, 0x5f, 0x72, 0x44, 0x58, 0x51, 0x10, 0x76,
    0x67, 0x7a, 0x70, 0x10, 0x57, 0x5e, 0x42, 0x56, 0x27, 0x44, 0x42, 0x44,
    0x41, 0x7f, 0x64, 0x67, 0x7d, 0x13, 0x52, 0x01, 0x56, 0x0b, 0x23, 0x45,
];

function xorDeobfuscateToUtf8(input: number[], mask: string): string {
    const maskBytes = new TextEncoder().encode(mask);
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
        out[i] = input[i] ^ maskBytes[i % maskBytes.length];
    }
    return new TextDecoder('utf-8').decode(out);
}

// NOTE: This is light obfuscation for source hygiene, not cryptographic protection.
const DEFAULT_APP_ID = xorDeobfuscateToUtf8(LYS_DEFAULT_APP_ID_XOR, LYS_KEY_OBFUSCATION);

export interface LysData {
    geometry: THREE.BufferGeometry;
    /** All geometry blobs parsed from the .lys archive, keyed by filename stem (e.g. "o15" for "o15.bin"). */
    geometriesByName: Map<string, THREE.BufferGeometry>;
    /**
     * Primary (non-hollowing) geometry stems in manifest-file order (ascending by offset).
     * Used to assign geometries to scene objects when per-object field matching fails.
     */
    geometryOrder: string[];
    sceneData: LysSceneData; // Decoded MessagePack data
    /** True when the primary geometry was parsed via the legacy unindexed path (stride-48 binary). */
    isLegacyGeometry: boolean;
}

export class LysParser {
    /**
     * Parse a .lys file (Lychee Slicer Scene)
     * @param file The .lys file object
     * @returns Promise resolving to the geometry and scene data
     */
    static async parse(file: File): Promise<LysData> {
        const buffer = await file.arrayBuffer();
        const data = new Uint8Array(buffer);
        const textDecoder = new TextDecoder('utf-8');

        // -------------------------------------------------------------------
        // Stage 1: extract and parse JSON manifest header.
        // -------------------------------------------------------------------
        const { start, end } = this.findJsonHeader(data);
        const manifestStr = textDecoder.decode(data.subarray(start, end));
        let manifest: LysManifest;
        try {
            manifest = JSON.parse(manifestStr);
        } catch (e) {
            console.error('[LysParser] Manifest JSON:', manifestStr);
            throw new Error(`Failed to parse LYS manifest: ${e}`);
        }

        // Data section starts after JSON header and optional null padding.
        let dataStart = end;
        while (dataStart < data.length && data[dataStart] === 0) {
            dataStart++;
        }

        console.log('[LysParser] File Structure:', {
            fileSize: data.length,
            jsonStart: start,
            jsonEnd: end,
            dataStart,
            paddingBytes: dataStart - end
        });

        const filesInfo = manifest.mangoFiles || {};

        let sceneBlob: Uint8Array | null = null;
        // All non-scene .bin blobs keyed by their filename stem (e.g. "o15" from "o15.bin")
        const allGeomBlobs = new Map<string, Uint8Array>();

        // -------------------------------------------------------------------
        // Stage 2: resolve declared file spans (`scene.bin`, `o*.bin`, etc.).
        // -------------------------------------------------------------------
        for (const [fname, info] of Object.entries(filesInfo) as [string, LysManifestFile][]) {
            const name = fname.toLowerCase();
            const offset = Number(info.offset || 0);
            const size = Number(info.size || 0);
            const absOffset = dataStart + offset;

            console.log(`[LysParser] Found File: ${name}`, {
                manifestOffset: offset,
                manifestSize: size,
                calcAbsOffset: absOffset,
                fitsInFile: absOffset + size <= data.length
            });

            if (name === 'scene.bin') {
                if (absOffset + size > data.length) {
                    // A short slice shifts the deobfuscation into an opaque msgpack error.
                    const missing = absOffset + size - data.length;
                    throw new Error(
                        `scene.bin is truncated: the manifest declares ${size} bytes ending at ${absOffset + size}, `
                        + `but the file is ${data.length} bytes (${missing} missing). The file is incomplete.`,
                    );
                }
                sceneBlob = data.subarray(absOffset, absOffset + size);
            } else if (name.endsWith('.bin')) {
                const blob = data.subarray(absOffset, absOffset + size);
                // Stem = filename without .bin extension (case-preserved from original fname)
                const stem = fname.slice(0, fname.length - 4);
                allGeomBlobs.set(stem, blob);
            }
        }

        if (!sceneBlob) {
            console.warn("LysParser: scene.bin not found in manifest");
        }
        if (allGeomBlobs.size === 0) {
            throw new Error("LysParser: No geometry .bin file found");
        }

        // -------------------------------------------------------------------
        // Stage 3: decode protected MessagePack scene payload.
        // -------------------------------------------------------------------
        let sceneData: LysSceneData = {};
        if (sceneBlob) {
            console.log(`[LysParser] Decoding scene.bin payload (${sceneBlob.length} bytes)...`);
                // Byte previews are intentionally kept to simplify variant debugging.
            if (sceneBlob.length > 0) {
                console.log(`[LysParser] First 8 bytes (encoded payload):`, Array.from(sceneBlob.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
            }

            const decodedPayload = this.decodeProtectedBytes(sceneBlob, DEFAULT_APP_ID);

            if (decodedPayload.length > 0) {
                console.log(`[LysParser] First 8 bytes (decoded payload):`, Array.from(decodedPayload.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
            }

            try {
                sceneData = decode(decodedPayload) as LysSceneData;
                console.log('[LysParser] Scene Decoded Successfully');
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                console.error("LysParser: Failed to decode scene msgpack", e);
                console.error("LysParser: Msgpack error details:", message);

                // Tail-byte diagnostics often reveal truncated/shifted payload issues.
                const len = decodedPayload.length;
                const tail = decodedPayload.subarray(Math.max(0, len - 16), len);
                console.log(`[LysParser] Last 16 bytes (decoded payload):`, Array.from(tail).map(b => b.toString(16).padStart(2, '0')).join(' '));

                throw new Error(`Failed to decode scene data: ${message}`);
            }
        }

        // -------------------------------------------------------------------
        // Stage 4: parse geometry payloads.
        // -------------------------------------------------------------------
        // Parse all unique stem candidates, sorted by payload size (largest first).
        // The first successfully parsed payload is used as fallback `geometry`.
        const uniqueCandidates = new Map<string, { stem: string; blob: Uint8Array }>();
        for (const [stem, blob] of allGeomBlobs) {
            const normalizedStem = stem.toLowerCase();
            const existing = uniqueCandidates.get(normalizedStem);
            if (!existing || blob.byteLength > existing.blob.byteLength) {
                uniqueCandidates.set(normalizedStem, { stem, blob });
            }
        }

        const sortedCandidates = [...uniqueCandidates.entries()]
            .sort(([, a], [, b]) => {
                // Prefer non-`_hollowing` stems as primary geometry — the `_hollowing`
                // suffix is a Lychee convention for cavity-interior meshes which should
                // never serve as the support-placement surface.
                const aIsHollowing = a.stem.toLowerCase().endsWith('_hollowing');
                const bIsHollowing = b.stem.toLowerCase().endsWith('_hollowing');
                if (aIsHollowing !== bIsHollowing) return aIsHollowing ? 1 : -1;
                return b.blob.byteLength - a.blob.byteLength;
            });

        let geometry: THREE.BufferGeometry | null = null;
        const geometriesByName = new Map<string, THREE.BufferGeometry>();
        let isLegacyGeometry = false;

        for (const [normalizedStem, candidate] of sortedCandidates) {
            let parsed: THREE.BufferGeometry | null = null;
            let parsedAsLegacy = false;
            const blobBuffer = candidate.blob.slice().buffer;
            try {
                parsed = this.parseGeometry(blobBuffer);
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                console.info(`[LysParser] Standard parse failed for "${candidate.stem}": ${reason}`);
                try {
                    parsed = this.parseLegacyGeometry(blobBuffer);
                    parsedAsLegacy = true;
                    console.info(`[LysParser] Parsed "${candidate.stem}" as legacy unindexed geometry`);
                } catch (err2) {
                    const reason2 = err2 instanceof Error ? err2.message : String(err2);
                    console.info(`[LysParser] Skipping non-geometry payload "${candidate.stem}": ${reason2}`);
                }
            }
            if (parsed) {
                if (!geometry) {
                    geometry = parsed;
                    isLegacyGeometry = parsedAsLegacy;
                }
                geometriesByName.set(candidate.stem, parsed);
                geometriesByName.set(normalizedStem, parsed);
            }
        }

        if (!geometry) {
            throw new Error('LysParser: No parseable geometry .bin payloads found');
        }

        // Build geometry stems in manifest order (allGeomBlobs preserves JSON key order).
        // Filter to only successfully-parsed, non-hollowing entries so callers can use
        // position in this list to assign geometry to scene objects by their sort order.
        const geometryOrder: string[] = [];
        for (const [stem] of allGeomBlobs) {
            if (stem.toLowerCase().endsWith('_hollowing')) continue;
            if (geometriesByName.has(stem) || geometriesByName.has(stem.toLowerCase())) {
                geometryOrder.push(stem);
            }
        }

        const sceneObjectIds = Object.keys(sceneData?.objects?.present?.byId ?? {});
        console.log('[LysParser][debug] parse summary', {
            sceneObjectCount: sceneObjectIds.length,
            sceneObjectIds,
            geometryStemCount: geometriesByName.size,
            geometryStems: [...geometriesByName.keys()],
            geometryOrder,
        });

        return {
            geometry,
            geometriesByName,
            geometryOrder,
            sceneData,
            isLegacyGeometry,
        };
    }

    /**
     * Locates the first top-level JSON object that looks like an LYS manifest.
     */
    private static findJsonHeader(data: Uint8Array): { start: number, end: number } {
        // Some LYS variants no longer start with '{"version"'.
        // Robustly scan for the first valid top-level JSON object that looks like
        // a manifest (contains mangoFiles) or at least version metadata.
        const decoder = new TextDecoder('utf-8');
        const maxScan = Math.min(data.length, 2_000_000);

        const tryExtractObjectBounds = (start: number): { start: number, end: number } | null => {
            let depth = 0;
            let inString = false;
            let escaped = false;

            for (let i = start; i < maxScan; i++) {
                const c = data[i];

                if (inString) {
                    if (escaped) {
                        escaped = false;
                        continue;
                    }
                    if (c === 92) { // '\\'
                        escaped = true;
                        continue;
                    }
                    if (c === 34) { // '"'
                        inString = false;
                    }
                    continue;
                }

                if (c === 34) { // '"'
                    inString = true;
                    continue;
                }
                if (c === 123) { // '{'
                    depth++;
                    continue;
                }
                if (c === 125) { // '}'
                    depth--;
                    if (depth === 0) {
                        return { start, end: i + 1 };
                    }
                    if (depth < 0) return null;
                }
            }

            return null;
        };

        // Prefer objects near where "mangoFiles" appears.
        const marker = new TextEncoder().encode('"mangoFiles"');
        const markerStarts: number[] = [];
        for (let i = 0; i <= maxScan - marker.length; i++) {
            let ok = true;
            for (let j = 0; j < marker.length; j++) {
                if (data[i + j] !== marker[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) markerStarts.push(i);
        }

        const candidateStarts: number[] = [];

        // Backtrack from each marker to likely object start.
        for (const m of markerStarts) {
            for (let i = m; i >= Math.max(0, m - 200_000); i--) {
                if (data[i] === 123) { // '{'
                    candidateStarts.push(i);
                    break;
                }
            }
        }

        // Fallback: scan for top-level object starts from file head.
        for (let i = 0; i < maxScan; i++) {
            if (data[i] === 123) candidateStarts.push(i);
            if (candidateStarts.length > 2000) break;
        }

        const seen = new Set<number>();
        for (const start of candidateStarts) {
            if (seen.has(start)) continue;
            seen.add(start);

            const bounds = tryExtractObjectBounds(start);
            if (!bounds) continue;

            try {
                const raw = decoder.decode(data.subarray(bounds.start, bounds.end));
                const parsed = JSON.parse(raw) as Record<string, unknown> | null;
                if (parsed && typeof parsed === 'object') {
                    if (parsed.mangoFiles || parsed.version || parsed.scene) {
                        return bounds;
                    }
                }
            } catch {
                // continue scanning
            }
        }

        // Helpful diagnostic if file is ZIP-like (PK\x03\x04)
        if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) {
            throw new Error('Unsupported .lys container variant (ZIP-like). Manifest JSON header not found.');
        }

        throw new Error('LYS manifest JSON header not found');
    }

    /**
     * Applies the format-specific byte decode transform used by LYS scene payloads.
     */
    private static decodeProtectedBytes(data: Uint8Array, key: string): Uint8Array {
        const out = new Uint8Array(data.length);
        const keyBytes = new TextEncoder().encode(key);
        const klen = keyBytes.length;

        for (let i = 0; i < data.length; i++) {
            // Equivalent to Python: (b - ord(key[i % klen])) % 256
            // JavaScript's modulo behavior for negatives differs from Python,
            // so we normalize with ((n % 256) + 256) % 256.
            const k = keyBytes[i % klen];
            const val = (data[i] - k);
            out[i] = ((val % 256) + 256) % 256;
        }
        return out;
    }

    /**
     * Parses a single LYS geometry blob into a non-indexed, flat-shaded geometry.
     */
    private static parseGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
        const MIN_HEADER_BYTES = 20;
        const view = new DataView(buffer);

        // Header is 20 bytes
        // 0-3: Version
        // 4-7: Header Length
        // 8-11: Index Count
        // 12-15: Coord Count
        // 16-19: Padding / Reserved

        if (buffer.byteLength < MIN_HEADER_BYTES) {
            throw new Error("Geometry file too short");
        }

        const declaredHeaderLength = view.getUint32(4, true);
        const dataOffset = Number.isFinite(declaredHeaderLength)
            && declaredHeaderLength >= MIN_HEADER_BYTES
            && declaredHeaderLength <= buffer.byteLength
            ? declaredHeaderLength
            : MIN_HEADER_BYTES;

        const nIndices = view.getUint32(8, true); // Little Endian
        const nCoords = view.getUint32(12, true);

        if (!Number.isFinite(nIndices) || !Number.isFinite(nCoords) || nIndices === 0 || nCoords === 0) {
            throw new Error(`Geometry payload has invalid counts (indices=${nIndices}, coords=${nCoords})`);
        }
        if (nCoords % 3 !== 0) {
            throw new Error(`Geometry payload has non-vec3 coordinate count (${nCoords})`);
        }

        // Indices
        const indicesByteLen = nIndices * 4;
        const coordsByteLen = nCoords * 4;
        const requiredPayloadBytes = indicesByteLen + coordsByteLen;

        if (requiredPayloadBytes > (buffer.byteLength - dataOffset)) {
            throw new Error(
                `Geometry payload byte length mismatch (header=${dataOffset}, indicesBytes=${indicesByteLen}, coordsBytes=${coordsByteLen}, total=${buffer.byteLength})`
            );
        }

        const indicesStart = dataOffset;
        const indicesEnd = indicesStart + indicesByteLen;
        const coordsStart = indicesEnd;
        const coordsEnd = coordsStart + coordsByteLen;

        // Slice to create typed array
        const indices = new Uint32Array(buffer.slice(indicesStart, indicesEnd));

        // Coords
        const coords = new Float32Array(buffer.slice(coordsStart, coordsEnd));

        // Construct Geometry
        const geometry = new THREE.BufferGeometry();

        // Set Attributes
        geometry.setAttribute('position', new THREE.BufferAttribute(coords, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        // Preserve STL-like flat shading (sharp edges).
        // Indexed geometry with computeVertexNormals() creates smooth shading,
        // which looks bad on mechanical parts (cylinders, etc).
        // Converting to Non-Indexed splits vertices, ensuring flat face normals.
        const flatGeometry = geometry.toNonIndexed();

        const flatPositions = flatGeometry.getAttribute('position').array as Float32Array;
        const cleaned = this.dropNonFiniteTriangles(flatPositions);
        if (cleaned !== flatPositions) {
            flatGeometry.setAttribute('position', new THREE.BufferAttribute(cleaned, 3));
        }

        // Compute normals for lighting (will now be flat per face)
        flatGeometry.computeVertexNormals();

        return flatGeometry;
    }

    /**
     * Parses legacy pre-v3.1.0 LYS geometry blobs stored as unindexed triangle soup.
     *
     * Older Lychee versions used a [V0, V1, V2, Attr] per-triangle layout (stride 48):
     * three 12-byte XYZ float32 vertex records followed by a 12-byte attribute record
     * (encodes face normal XY + ancillary data). The attribute must be skipped or the
     * mesh is filled with enormous elongated triangles stretching to the Z-axis.
     *
     * Detection: the attr record always has XY magnitude ≈ 1 mm (< 2 mm), while real
     * vertex XY magnitudes are >> 5 mm. We probe the first 40 triplets to confirm the
     * every-4th-triplet pattern before committing to the stride-48 path.
     */
    private static parseLegacyGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
        const view = new DataView(buffer);

        // --- Step 0: a leading triangle count that sizes the blob exactly ---
        // Blobs written as [u32 count][V0, V1, V2, Attr] × count say where the data
        // starts. The probe below can't tell byte 4 from byte 8 there (one float late
        // still shows the stride pattern), and picking 8 scrambles every vertex.
        const LEGACY_STRIDE = 48;
        const headerTriCount = buffer.byteLength >= 4 ? view.getUint32(0, true) : 0;
        const countedBlob = headerTriCount > 0 && 4 + headerTriCount * LEGACY_STRIDE === buffer.byteLength;

        // --- Step 1: find best starting offset for vertex data ---
        // Score every plausible offset by how strongly it shows the [V,V,V,Attr]
        // stride-48 XY pattern (ratio of avgVertXY / avgAttrXY). The true data start
        // has the highest score because real attr records have XY ≈ 1 mm while vertex
        // XY is typically >> 5 mm. A wrong offset like H=8 may accidentally pass a
        // basic float check but will have a much weaker (or zero) score.
        const candidateOffsets = [0, 4, 8, 9, 10, 11, 12, 16, 20, 24, 28, 32];

        let dataOffset = -1;
        let bestStrideScore = 0;
        let firstValidOffset = -1;

        if (countedBlob) {
            dataOffset = 4;
            bestStrideScore = Infinity;
        }

        for (const H of countedBlob ? [] : candidateOffsets) {
            if (H >= buffer.byteLength) continue;
            const n = Math.floor((buffer.byteLength - H) / 12);
            if (n < 3) continue;

            let valid = true;
            let hasSignificantCoord = false;
            for (let i = 0; i < Math.min(10, n); i++) {
                const off = H + i * 12;
                const x = view.getFloat32(off, true);
                const y = view.getFloat32(off + 4, true);
                const z = view.getFloat32(off + 8, true);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
                    || Math.abs(x) > 10_000 || Math.abs(y) > 10_000 || Math.abs(z) > 10_000) {
                    valid = false;
                    break;
                }
                if (Math.abs(x) > 0.01 || Math.abs(y) > 0.01 || Math.abs(z) > 0.01) {
                    hasSignificantCoord = true;
                }
            }
            if (!valid || !hasSignificantCoord) continue;

            if (firstValidOffset < 0) firstValidOffset = H;

            const score = this.legacyAttrStrideScore(view, H, buffer.byteLength);
            if (score > bestStrideScore) {
                bestStrideScore = score;
                dataOffset = H;
            }
        }

        // If no stride signal found at any offset, fall back to first valid soup offset.
        if (dataOffset < 0) dataOffset = firstValidOffset;
        if (dataOffset < 0) {
            throw new Error('Legacy geometry: no valid XYZ float32 vertex data found at any candidate offset');
        }

        // --- Step 2: decide path based on score ---
        // A score ≥ 5 means avgVertXY is at least 5× avgAttrXY — strong enough to
        // commit to the stride-48 path.
        const STRIDE_THRESHOLD = 5.0;
        const useAttrStride = bestStrideScore >= STRIDE_THRESHOLD;

        console.info(`[LysParser] Legacy geometry: dataOffset=${dataOffset}, useAttrStride=${useAttrStride}, strideScore=${bestStrideScore.toFixed(1)}, bufferBytes=${buffer.byteLength}`);

        // --- Step 3: extract position data ---
        let positions: Float32Array;

        if (useAttrStride) {
            // Stride-48 path: read [V0, V1, V2] and skip the 12-byte Attr per triangle.
            const STRIDE = 48;
            const available = buffer.byteLength - dataOffset;
            const nWholeTris = Math.floor(available / STRIDE);
            // A partial last triangle may have [V0, V1, V2] without a trailing Attr.
            const remainder = available - nWholeTris * STRIDE;
            const extraVerts = Math.min(3, Math.floor(remainder / 12));
            // Truncate to a whole number of triangles in case extraVerts leaves a remainder.
            const rawTotalVerts = nWholeTris * 3 + extraVerts;
            const totalVerts = Math.floor(rawTotalVerts / 3) * 3;

            if (totalVerts < 3) {
                throw new Error('Legacy geometry (attr-stride): not enough vertex data');
            }

            positions = new Float32Array(totalVerts * 3);
            let idx = 0;
            const triCount = totalVerts / 3;
            for (let t = 0; t < Math.min(nWholeTris, triCount); t++) {
                const tBase = dataOffset + t * STRIDE;
                const v0 = tBase;
                const v1 = tBase + 12;
                const v2 = tBase + 24;
                // Swap raw X↔Z so geometry matches Lychee's display axes (Z-up, X=width,
                // Z=height). The permutation (det = -1) also converts CW→CCW winding.
                // v0
                positions[idx++] = view.getFloat32(v0 + 8, true);
                positions[idx++] = view.getFloat32(v0 + 4, true);
                positions[idx++] = view.getFloat32(v0,     true);
                // v1
                positions[idx++] = view.getFloat32(v1 + 8, true);
                positions[idx++] = view.getFloat32(v1 + 4, true);
                positions[idx++] = view.getFloat32(v1,     true);
                // v2
                positions[idx++] = view.getFloat32(v2 + 8, true);
                positions[idx++] = view.getFloat32(v2 + 4, true);
                positions[idx++] = view.getFloat32(v2,     true);
            }
            // Extra partial triangle verts (only when triCount > nWholeTris)
            if (triCount > nWholeTris) {
                for (let v = 0; v < extraVerts; v++) {
                    const vBase = dataOffset + nWholeTris * STRIDE + v * 12;
                    positions[idx++] = view.getFloat32(vBase + 8, true);
                    positions[idx++] = view.getFloat32(vBase + 4, true);
                    positions[idx++] = view.getFloat32(vBase,     true);
                }
            }
        } else {
            // Pure triangle soup: all triplets are vertex positions.
            const rawNVerts = Math.floor((buffer.byteLength - dataOffset) / 12);
            // Truncate to a whole number of triangles rather than throwing.
            const nVerts = Math.floor(rawNVerts / 3) * 3;
            if (nVerts < 3) {
                throw new Error('Legacy geometry (soup): not enough vertex data');
            }
            positions = new Float32Array(buffer.slice(dataOffset, dataOffset + nVerts * 12));
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.dropNonFiniteTriangles(positions), 3));
        geometry.computeVertexNormals();
        return geometry;
    }

    /**
     * Drops whole triangles carrying a non-finite coordinate; one NaN vertex makes
     * the bounding sphere NaN and the model unrenderable. Returns the input
     * untouched when every coordinate is finite.
     */
    private static dropNonFiniteTriangles(positions: Float32Array): Float32Array {
        const triCount = Math.floor(positions.length / 9);
        const keep: number[] = [];
        for (let t = 0; t < triCount; t++) {
            const base = t * 9;
            let finite = true;
            for (let i = 0; i < 9; i++) {
                if (!Number.isFinite(positions[base + i])) { finite = false; break; }
            }
            if (finite) keep.push(base);
        }
        if (keep.length === triCount) return positions;

        console.warn(`[LysParser] Dropped ${triCount - keep.length} triangle(s) with non-finite coordinates`);
        const out = new Float32Array(keep.length * 9);
        for (let k = 0; k < keep.length; k++) {
            out.set(positions.subarray(keep[k], keep[k] + 9), k * 9);
        }
        return out;
    }

    /**
     * Returns a stride-48 signal score for the given offset: the ratio avgVertXY/avgAttrXY
     * when every 4th triplet (i%4===3) has significantly smaller XY magnitude than the rest.
     * Returns 0 if the pattern is absent. The correct data-start offset scores highest.
     */
    private static legacyAttrStrideScore(view: DataView, dataOffset: number, totalBytes: number): number {
        const SAMPLE = Math.min(40, Math.floor((totalBytes - dataOffset) / 12));
        if (SAMPLE < 8) return 0;

        let attrXYSum = 0, attrCount = 0;
        let vertXYSum = 0, vertCount = 0;

        for (let i = 0; i < SAMPLE; i++) {
            const off = dataOffset + i * 12;
            if (off + 12 > totalBytes) break;
            const x = view.getFloat32(off, true);
            const y = view.getFloat32(off + 4, true);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
            const xyMag = Math.sqrt(x * x + y * y);
            if (i % 4 === 3) {
                attrXYSum += xyMag;
                attrCount++;
            } else {
                vertXYSum += xyMag;
                vertCount++;
            }
        }

        if (attrCount === 0 || vertCount === 0) return 0;
        const avgAttrXY = attrXYSum / attrCount;
        const avgVertXY = vertXYSum / vertCount;
        if (avgAttrXY < 2 && avgVertXY > 5 && avgVertXY > avgAttrXY * 5) {
            return avgVertXY / Math.max(avgAttrXY, 0.001);
        }
        return 0;
    }
}
