import * as THREE from 'three';
import { decode } from '@msgpack/msgpack';

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
    sceneData: any; // Decoded MessagePack data
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
        let manifest: any;
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
        for (const [fname, info] of Object.entries(filesInfo) as [string, any][]) {
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
                    console.error(`[LysParser] scene.bin bounds [${absOffset}, ${absOffset + size}] exceed file size ${data.length}`);
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
        let sceneData: any = {};
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
                sceneData = decode(decodedPayload);
                console.log('[LysParser] Scene Decoded Successfully');
            } catch (e: any) {
                console.error("LysParser: Failed to decode scene msgpack", e);
                console.error("LysParser: Msgpack error details:", e?.message);

                // Tail-byte diagnostics often reveal truncated/shifted payload issues.
                const len = decodedPayload.length;
                const tail = decodedPayload.subarray(Math.max(0, len - 16), len);
                console.log(`[LysParser] Last 16 bytes (decoded payload):`, Array.from(tail).map(b => b.toString(16).padStart(2, '0')).join(' '));

                throw new Error(`Failed to decode scene data: ${e.message}`);
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
            .sort(([, a], [, b]) => b.blob.byteLength - a.blob.byteLength);

        let geometry: THREE.BufferGeometry | null = null;
        const geometriesByName = new Map<string, THREE.BufferGeometry>();

        for (const [normalizedStem, candidate] of sortedCandidates) {
            try {
                const parsed = this.parseGeometry(candidate.blob.slice().buffer);
                if (!geometry) {
                    geometry = parsed;
                }

                geometriesByName.set(candidate.stem, parsed);
                geometriesByName.set(normalizedStem, parsed);
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                console.info(`[LysParser] Skipping non-geometry payload "${candidate.stem}": ${reason}`);
            }
        }

        if (!geometry) {
            throw new Error('LysParser: No parseable geometry .bin payloads found');
        }

        const sceneObjectIds = Object.keys(sceneData?.objects?.present?.byId ?? {});
        console.log('[LysParser][debug] parse summary', {
            sceneObjectCount: sceneObjectIds.length,
            sceneObjectIds,
            geometryStemCount: geometriesByName.size,
            geometryStems: [...geometriesByName.keys()],
        });

        return {
            geometry,
            geometriesByName,
            sceneData
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
                const parsed = JSON.parse(raw) as any;
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

        // Compute normals for lighting (will now be flat per face)
        flatGeometry.computeVertexNormals();

        return flatGeometry;
    }
}
