# LYS Import Plugin (`lys-import`)

Built-in DragonFruit plugin for importing `.lys` scene files and converting their support data into DragonFruit's internal format.

## What this plugin does

- Parses LYS containers and manifest metadata.
- Reads one or more geometry blobs from the container.
- Decodes protected `scene.bin` payload data used by the source format.
- Converts supports into DragonFruit's import format (`DragonfruitImportFormat`).
- Applies object transform alignment so models and supports land correctly in scene space.

## Scope and expectations

- This plugin is designed for **practical scene import compatibility**.
- Imported support topology may differ slightly from the authoring app after conversion.
- Missing or malformed payload fields are handled with best-effort fallbacks where possible.

## Key files

- `pluginDefinition.ts` — plugin manifest + file type registration.
- `fileTypeHandlers.ts` — scene-file import bridge used by host file importer.
- `LysParser.ts` — container parsing, manifest extraction, scene payload decode, geometry decode.
- `LysConverter.ts` — conversion into DragonFruit support primitives.
- `useLysImport.ts` / `useLysSceneImport.ts` — React hook paths for import flows.

## Protected payload decode note

LYS scene payload decoding uses a format-specific byte transformation required for compatibility with existing `.lys` scene data.

- The parser keeps a default app identifier constant in **obfuscated** form in source.
- At runtime, it is reconstructed in memory and used for payload decode.
- This is source-hygiene obfuscation only and should not be treated as strong cryptographic security.

## Legal notice (interoperability)

This plugin includes format-compatibility work for `.lys` scene files to enable interoperability between software ecosystems.

The project is developed in good faith for compatibility use cases, with attention to applicable legal frameworks such as:

- EU Directive 2009/24/EC (interoperability-related reverse engineering allowances)
- DMCA Section 1201(f) (United States interoperability exemption)
- Fair Use / Fair Dealing doctrines where applicable

The implementation follows clean-room style engineering practices for independent behavior verification and format compatibility.

Users are responsible for ensuring their use complies with applicable law in their jurisdiction.

**Disclaimer:** This section is general information only and does not constitute legal advice. For jurisdiction-specific guidance, consult qualified legal counsel.

## Geometry handling

- Parses all `.bin` geometry blobs and indexes them by filename stem.
- Selects the largest geometry blob as backward-compatible fallback mesh.
- Uses flat-shaded non-indexed geometry for STL-like visual consistency.

## Logging and diagnostics

The plugin intentionally emits detailed import diagnostics (`[LysParser]`, `[lys-import]`, `[LysConverter]`) for troubleshooting unsupported variants.

If import fails, capture logs around:

- manifest detection
- `scene.bin` payload decode
- geometry stem mapping and object/geometry association

## Maintenance notes

- Keep terminology neutral and compatibility-focused (`decode protected payload`, `import compatibility`) rather than reverse-engineering language.
- Keep parser and converter changes paired with focused tests when behavior changes.
