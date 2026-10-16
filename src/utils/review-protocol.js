// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { getPath, hasPath } = require('../settings/registry');
const { prosePolicy } = require('./review-prose');
const { PRESETS, resolveFormat } = require('./comment-formatter');

const digest = value => createHash('sha256').update(value).digest('hex');
const observeFile = async file => {
  try { return { digest: digest(await fs.readFile(file)), availability: 'known' }; }
  catch (error) { return { digest: null, availability: error.code === 'ENOENT' ? 'absent' : 'unavailable' }; }
};

// Configured files are trusted configuration, never PR-supplied paths or instructions.
const loadInstructionSources = async entries => {
  if (entries == null) return { content: '', sources: [] };
  if (!Array.isArray(entries)) throw new Error('instruction_files must be an array');
  const MarkdownIt = require('markdown-it');
  const markdown = new MarkdownIt();
  const parts = [];
  const sources = [];
  const seen = new Set();
  for (const entry of entries) {
    const descriptor = typeof entry === 'string' ? { path: entry } : entry;
    if (!descriptor || typeof descriptor.path !== 'string' || (descriptor.sections != null && !Array.isArray(descriptor.sections))
      || (descriptor.preamble != null && typeof descriptor.preamble !== 'boolean')) throw new Error('Invalid instruction_files entry');
    const file = path.resolve(descriptor.path.replace(/^~(?=\/)/, os.homedir()));
    if (seen.has(file)) throw new Error(`Instruction file configured more than once: ${path.basename(file)}`);
    seen.add(file);
    const content = await fs.readFile(file, 'utf8');
    let excerpt = content;
    if (descriptor.sections?.length || descriptor.preamble) {
      const tokens = markdown.parse(content, {});
      const lines = content.split(/(?<=\n)/);
      const ranges = (descriptor.sections || []).map(title => {
        const start = tokens.findIndex((token, index) => token.type === 'heading_open' && tokens[index + 1]?.content === title);
        if (start < 0) throw new Error(`Instruction section not found in ${path.basename(file)}: ${title}`);
        let end = start + 1;
        while (end < tokens.length && !(tokens[end].type === 'heading_open' && tokens[end].tag <= tokens[start].tag)) end++;
        return [tokens[start].map[0], end < tokens.length ? tokens[end].map[0] : lines.length];
      });
      if (descriptor.preamble) {
        const title = tokens.findIndex(token => token.type === 'heading_open');
        const boundary = tokens.find((token, index) => token.type === 'heading_open' && !(index === title && token.tag === 'h1'));
        ranges.push([0, boundary ? boundary.map[0] : lines.length]);
      }
      const selected = [];
      for (const range of ranges.sort((a, b) => a[0] - b[0])) {
        const previous = selected.at(-1);
        if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
        else selected.push(range);
      }
      excerpt = selected.map(([start, end]) => lines.slice(start, end).join('')).join('\n\n');
    }
    parts.push(excerpt.trim());
    sources.push({ path: file, label: `Instructions: ${path.basename(file)}`, digest: digest(content), excerptDigest: digest(excerpt), sections: descriptor.sections || null, preamble: !!descriptor.preamble, availability: 'known' });
  }
  return { content: parts.join('\n\n'), sources };
};

const settingKeys = ['default_provider', 'default_model', 'default_council_id', 'comment_format', 'external_comments', 'chat_provider'];

function loadedProtocol(config, layers, sources) {
  const keys = [...settingKeys, 'review_prose.profile',
    ...Object.keys(config.review_prose?.rules || {}).map(rule => `review_prose.rules.${rule}`),
    ...Object.keys(config.chat_providers || {}).map(provider => `chat_providers.${provider}.model`)];
  return {
    fieldSources: Object.fromEntries(keys.map(key => [key, layers.findLast(layer => hasPath(layer.data, key))?.name || 'unset'])),
    sources: sources.map(source => ({ source: source.label, loadedDigest: source.digest || null,
      ...(source.excerptDigest ? { excerptDigest: source.excerptDigest } : {}),
      ...(source.sections ? { sections: [...source.sections] } : {}),
      ...(source.preamble ? { preamble: true } : {}) }))
  };
}

function settingReceipt(config, key) {
  return { value: getPath(config, key) ?? null,
    source: Object.hasOwn(config._globalOverrides || {}, key) ? 'app' : config._protocol?.fieldSources?.[key] || 'not_recorded' };
}

const executionKeys = new Set(['type', 'provider', 'model', 'tier', 'enabled', 'timeout', 'maxTurns', 'load_skills',
  'levels', 'reviewers', 'voices', 'members', 'consolidation', 'config', 'council', 'providerOverrides']);
function executionReceipt(value) {
  if (Array.isArray(value)) return value.map(executionReceipt);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/instructions?$|prompt|command|^args$|^extra_args$|^env$/i.test(key)) {
      result[`${key}Digest`] = entry == null ? null : digest(JSON.stringify(entry));
    } else if (key === 'providerOverridesMap') {
      result[key] = entry == null ? null : Object.fromEntries(Object.entries(entry).map(([provider, overrides]) => [provider, executionReceipt(overrides)]));
    } else if (executionKeys.has(key) || /^[123]$/.test(key)) result[key] = executionReceipt(entry);
  }
  return result;
}

function captureRunProtocol(config, execution = null) {
  return {
    version: 1,
    serverInputs: Object.fromEntries(settingKeys.map(key => [key, settingReceipt(config, key)])),
    instructionDigest: config.globalInstructions ? digest(config.globalInstructions) : null,
    sources: structuredClone(config._protocol?.sources || []),
    prosePolicy: prosePolicy(config),
    execution: execution ? { digest: digest(JSON.stringify(execution)), selection: executionReceipt(execution) } : null
  };
}

const serverReceipt = async (config, sources = [], defaults = {}) => ({
  'Server defaults': {
    provider: defaults.provider || config.default_provider || config.provider || 'claude',
    model: defaults.model || config.default_model || config.model || 'provider default',
    councilId: config.default_council_id || null,
    commentFormat: typeof config.comment_format === 'object' && config.comment_format ? 'custom format'
      : Object.hasOwn(PRESETS, config.comment_format) ? config.comment_format : 'legacy',
    commentFormatDigest: digest(JSON.stringify(resolveFormat(config.comment_format))),
    externalComments: config.external_comments === true,
    chatProvider: config.chat_provider || 'pi',
    chatModel: config.chat_providers?.[config.chat_provider || 'pi']?.model || 'provider default'
  },
  'Server setting sources': Object.fromEntries(settingKeys.map(key => [key, settingReceipt(config, key)])),
  'Configured outgoing prose policy': prosePolicy(config),
  'Instruction content loaded': { digest: config.globalInstructions ? digest(config.globalInstructions) : null,
    present: !!config.globalInstructions, precedence: 'request > repository > global; explicit provider/model > CLI > repository > server' },
  'Configuration sources': await Promise.all(sources.map(async source => {
    const current = await observeFile(source.path);
    return { source: source.label, loadedDigest: source.digest || null, onDiskDigest: current.digest,
      availability: current.availability, restartRequired: current.availability === 'unavailable' ? null : current.digest !== (source.digest || null),
      ...(source.sections ? { sections: source.sections, excerptDigest: source.excerptDigest } : {}),
      ...(source.preamble ? { preamble: true } : {}) };
  })),
  'Enforcement': {
    reviewExecution: 'Read-only by instruction; provider bash and delegated tools are not an OS security boundary',
    publicText: 'Explicit user publication; instruction content does not enforce factual correctness or writing style',
    configuration: 'Files and instructions load at startup. Supported in-app overrides can affect future runs immediately; existing runs keep their captured configuration',
    modelIdentity: 'Configured default is unresolved unless the provider explicitly reports the served model'
  }
});

const runReceipt = row => ({
  runId: row.id, provider: row.provider, model: row.model, headSha: row.head_sha, tier: row.tier,
  reviewedBaseline: row.review_baseline ? JSON.parse(row.review_baseline) : null,
  protocol: row.protocol_snapshot ? JSON.parse(row.protocol_snapshot) : null,
  instructions: ['global_instructions', 'repo_instructions', 'request_instructions'].map(source => ({
    source, present: !!row[source], digest: row[source] ? digest(row[source]) : null
  })),
  levels: row.levels_config ? executionReceipt(JSON.parse(row.levels_config)) : null,
  status: row.status, startedAt: row.started_at,
  enforcement: 'Content captured when this run was created; no assertion of model obedience or OS isolation'
});

module.exports = { digest, loadInstructionSources, loadedProtocol, captureRunProtocol, observeFile, runReceipt, serverReceipt };
