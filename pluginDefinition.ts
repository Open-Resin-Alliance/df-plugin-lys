import type { ComplexPluginDefinition } from '@/features/plugins/complexPluginContracts';

/**
 * Built-in plugin descriptor for DragonFruit's LYS scene-file import capability.
 *
 * Notes:
 * - This plugin is file-type focused (no runtime protocol / encoder / network surface).
 * - The warning text intentionally sets compatibility expectations before import.
 */

const PLUGIN_DEFINITION: ComplexPluginDefinition = {
  id: 'lys-import',
  manifest: {
    id: 'lys-import-builtin',
    name: 'LYS File Support',
    version: '0.1.0',
    description: 'Imports .lys scene files into DragonFruit',
    author: 'Open Resin Alliance',
    homepage: 'https://github.com/Open-Resin-Alliance/df-plugin-lys',
  },
  capabilities: {
    networkOperations: false,
    uploadWithProgress: false,
    slicerEncoder: false,
    tauriRuntimePlugin: false,
    fileType: true,
  },
  fileTypes: [
    {
      fileExtension: '.lys',
      mimeType: 'application/octet-stream',
      displayName: 'LYS Scene',
      isSceneFile: true,
      importWarning: {
        title: 'LYS Import',
        body: 'LYS import converts Lychee Slicer scene data into DragonFruit VOXL format. Support placement may differ from the original scene.',
        storageKey: 'dragonfruit.lysImportWarningDismissed',
      },
    },
  ],
};

export default PLUGIN_DEFINITION;
