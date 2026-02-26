'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parseRisum, buildRisum } = require('./rpack');
const { risuArrayToCCV3, ccv3ArrayToRisu } = require('./lorebook-convert');

/**
 * Open and parse a .charx file
 * @param {string} filePath - path to .charx file
 * @returns {object} parsed data structure
 */
function openCharx(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  // Parse card.json
  const cardEntry = zip.getEntry('card.json');
  if (!cardEntry) throw new Error('card.json not found in .charx');
  const card = JSON.parse(cardEntry.getData().toString('utf-8'));

  // Parse module.risum
  let moduleData = null;
  let risumAssets = [];
  const risumEntry = zip.getEntry('module.risum');
  if (risumEntry) {
    const parsed = parseRisum(risumEntry.getData());
    moduleData = parsed.module;
    risumAssets = parsed.assets;
  }

  // Collect image assets
  const assets = [];
  const xMeta = {};
  for (const entry of entries) {
    if (entry.entryName.startsWith('assets/') && !entry.isDirectory) {
      assets.push({
        path: entry.entryName,
        data: entry.getData()
      });
    }
    if (entry.entryName.startsWith('x_meta/') && entry.entryName.endsWith('.json')) {
      const metaName = path.basename(entry.entryName, '.json');
      xMeta[metaName] = JSON.parse(entry.getData().toString('utf-8'));
    }
  }

  // Extract editable components
  const data = card.data || {};
  const risuExt = data.extensions?.risuai || {};
  const mod = moduleData?.module || {};

  return {
    // Metadata
    spec: card.spec || 'chara_card_v3',
    specVersion: card.spec_version || '3.0',

    // Character info
    name: data.name || '',
    description: data.description || '',
    personality: data.personality || '',
    scenario: data.scenario || '',
    creatorcomment: data.creatorcomment || '',
    tags: data.tags || [],

    // Editable content
    firstMessage: data.first_mes || '',
    globalNote: data.post_history_instructions || '',
    css: risuExt.backgroundHTML || '',
    defaultVariables: risuExt.defaultVariables || '',
    lua: mod.trigger?.[0]?.effect?.[0]?.code || '',

    // Lorebook (use module.risum version as source of truth)
    lorebook: mod.lorebook || [],

    // Regex scripts
    regex: mod.regex || [],

    // Module metadata
    moduleId: mod.id || '',
    moduleName: mod.name || '',
    moduleDescription: mod.description || '',

    // Assets
    assets,
    xMeta,
    risumAssets,

    // card.json asset references
    cardAssets: data.assets || [],

    // Preserve full risuai extensions for save
    _risuExt: risuExt,
    // Preserve full card for fields we don't edit
    _card: card,
    // Preserve full module for fields we don't edit
    _moduleData: moduleData
  };
}

/**
 * Save data back to .charx file
 * @param {string} filePath - output path
 * @param {object} data - data structure from openCharx (possibly modified)
 */
function saveCharx(filePath, data) {
  const zip = new AdmZip();

  // Build card.json
  const card = JSON.parse(JSON.stringify(data._card || {}));
  if (!card.spec) card.spec = 'chara_card_v3';
  if (!card.spec_version) card.spec_version = '3.0';
  if (!card.data) card.data = {};

  card.data.name = data.name;
  card.data.description = data.description;
  card.data.personality = data.personality || '';
  card.data.scenario = data.scenario || '';
  card.data.creatorcomment = data.creatorcomment || '';
  card.data.tags = data.tags || [];
  card.data.first_mes = data.firstMessage;
  card.data.post_history_instructions = data.globalNote;

  // risuai extensions
  if (!card.data.extensions) card.data.extensions = {};
  if (!card.data.extensions.risuai) card.data.extensions.risuai = {};
  const risuExt = card.data.extensions.risuai;
  risuExt.backgroundHTML = data.css;
  risuExt.defaultVariables = data.defaultVariables;

  // Remove trigger/script from card (they go in module.risum)
  delete risuExt.customScripts;
  delete risuExt.triggerscript;

  // Lorebook → card.json (CCV3 format)
  if (!card.data.character_book) card.data.character_book = {};
  card.data.character_book.entries = risuArrayToCCV3(data.lorebook);

  // Preserve card assets
  card.data.assets = data.cardAssets || [];

  zip.addFile('card.json', Buffer.from(JSON.stringify(card, null, 2), 'utf-8'));

  // Build module.risum
  const moduleJson = data._moduleData ? JSON.parse(JSON.stringify(data._moduleData)) : {
    type: 'risuModule',
    module: {
      name: data.moduleName || `${data.name} Module`,
      description: data.moduleDescription || `Module for ${data.name}`,
      id: data.moduleId || generateUUID(),
      trigger: [],
      regex: [],
      lorebook: [],
      assets: []
    }
  };

  const mod = moduleJson.module;

  // Lua → trigger
  if (data.lua) {
    mod.trigger = [{
      comment: '',
      type: 'start',
      conditions: [],
      effect: [{ type: 'triggerlua', code: data.lua }],
      lowLevelAccess: false
    }];
  } else {
    mod.trigger = mod.trigger || [];
  }

  // Regex
  mod.regex = data.regex || [];

  // Lorebook (risu format)
  mod.lorebook = data.lorebook || [];

  const risumBuf = buildRisum(moduleJson, data.risumAssets || []);
  zip.addFile('module.risum', risumBuf);

  // Add image assets
  for (const asset of (data.assets || [])) {
    zip.addFile(asset.path, asset.data);
  }

  // Add x_meta
  for (const [name, meta] of Object.entries(data.xMeta || {})) {
    zip.addFile(`x_meta/${name}.json`, Buffer.from(JSON.stringify(meta), 'utf-8'));
  }

  // Write ZIP
  zip.writeZip(filePath);
}

/**
 * Open and parse a standalone .risum file
 * @param {string} filePath - path to .risum file
 * @returns {object} parsed data structure (same shape as openCharx)
 */
function openRisum(filePath) {
  const buf = fs.readFileSync(filePath);
  const parsed = parseRisum(buf);
  const mod = parsed.module?.module || parsed.module || {};

  return {
    _fileType: 'risum',

    // Module metadata
    name: mod.name || path.basename(filePath, '.risum'),
    description: mod.description || '',
    moduleId: mod.id || '',
    moduleName: mod.name || '',
    moduleDescription: mod.description || '',

    // Editable content
    lua: mod.trigger?.[0]?.effect?.[0]?.code || '',
    lorebook: mod.lorebook || [],
    regex: mod.regex || [],

    // charx-only fields (empty for risum)
    firstMessage: '',
    globalNote: '',
    css: '',
    defaultVariables: '',
    personality: '',
    scenario: '',
    creatorcomment: '',
    tags: [],

    // Assets
    assets: [],
    xMeta: {},
    risumAssets: parsed.assets || [],
    cardAssets: [],

    // Preserve original data for save
    _moduleData: parsed.module,
    _risuExt: {},
    _card: { spec: 'chara_card_v3', spec_version: '3.0', data: { extensions: { risuai: {} } } }
  };
}

/**
 * Save data back to a standalone .risum file
 * @param {string} filePath - output path
 * @param {object} data - data structure from openRisum (possibly modified)
 */
function saveRisum(filePath, data) {
  const moduleJson = data._moduleData ? JSON.parse(JSON.stringify(data._moduleData)) : {
    type: 'risuModule',
    module: {
      name: data.moduleName || data.name || 'Module',
      description: data.moduleDescription || '',
      id: data.moduleId || generateUUID(),
      trigger: [],
      regex: [],
      lorebook: [],
      assets: []
    }
  };

  const mod = moduleJson.module || moduleJson;

  // Update module name/description
  mod.name = data.moduleName || data.name || mod.name;
  mod.description = data.moduleDescription || data.description || mod.description;

  // Lua → trigger
  if (data.lua) {
    mod.trigger = [{
      comment: '',
      type: 'start',
      conditions: [],
      effect: [{ type: 'triggerlua', code: data.lua }],
      lowLevelAccess: false
    }];
  } else {
    mod.trigger = mod.trigger || [];
  }

  // Regex & Lorebook
  mod.regex = data.regex || [];
  mod.lorebook = data.lorebook || [];

  const risumBuf = buildRisum(moduleJson, data.risumAssets || []);
  fs.writeFileSync(filePath, risumBuf);
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = { openCharx, saveCharx, openRisum, saveRisum };
