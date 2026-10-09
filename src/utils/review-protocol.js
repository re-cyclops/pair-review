// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

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
  for (const entry of entries) {
    const descriptor = typeof entry === 'string' ? { path: entry } : entry;
    if (!descriptor || typeof descriptor.path !== 'string' || (descriptor.sections != null && !Array.isArray(descriptor.sections))) throw new Error('Invalid instruction_files entry');
    const file = path.resolve(descriptor.path.replace(/^~(?=\/)/, os.homedir()));
    const content = await fs.readFile(file, 'utf8');
    let excerpt = content;
    if (descriptor.sections?.length) {
      const tokens = markdown.parse(content, {});
      const lines = content.split(/(?<=\n)/);
      const excerpts = descriptor.sections.map(title => {
        const start = tokens.findIndex((token, index) => token.type === 'heading_open' && tokens[index + 1]?.content === title);
        if (start < 0) throw new Error(`Instruction section not found in ${path.basename(file)}: ${title}`);
        let end = start + 1;
        while (end < tokens.length && !(tokens[end].type === 'heading_open' && tokens[end].tag <= tokens[start].tag)) end++;
        return lines.slice(tokens[start].map[0], end < tokens.length ? tokens[end].map[0] : lines.length).join('');
      });
      excerpt = excerpts.join('\n\n');
    }
    parts.push(excerpt.trim());
    sources.push({ path: file, label: `Instructions: ${path.basename(file)}`, digest: digest(content), excerptDigest: digest(excerpt), sections: descriptor.sections || null, availability: 'known' });
  }
  return { content: parts.join('\n\n'), sources };
};

const serverReceipt = async (config, sources = [], defaults = {}) => ({
  'Server defaults': {
    provider: defaults.provider || config.default_provider || config.provider || 'claude',
    model: defaults.model || config.default_model || config.model || 'provider default',
    commentFormat: config.comment_format || 'default',
    externalComments: config.external_comments !== false,
    chatProvider: config.chat_provider || 'pi',
    chatModel: config.chat_providers?.[config.chat_provider || 'pi']?.model || 'provider default'
  },
  'Instruction content loaded': { digest: config.globalInstructions ? digest(config.globalInstructions) : null,
    present: !!config.globalInstructions, precedence: 'request > repository > global; explicit provider/model > CLI > repository > server' },
  'Configuration sources': await Promise.all(sources.map(async source => {
    const current = await observeFile(source.path);
    return { source: source.label, loadedDigest: source.digest || null, onDiskDigest: current.digest,
      availability: current.availability, restartRequired: current.digest !== (source.digest || null),
      ...(source.sections ? { sections: source.sections, excerptDigest: source.excerptDigest } : {}) };
  })),
  'Enforcement': {
    reviewExecution: 'Read-only by instruction; provider bash and delegated tools are not an OS security boundary',
    publicText: 'Explicit user publication; instruction content does not enforce factual correctness or writing style',
    configuration: 'Startup-loaded. A disk change does not change an existing analysis',
    modelIdentity: 'Configured default is unresolved unless the provider explicitly reports the served model'
  }
});

const runReceipt = row => ({
  runId: row.id, provider: row.provider, model: row.model, headSha: row.head_sha, tier: row.tier,
  instructions: ['global_instructions', 'repo_instructions', 'request_instructions'].map(source => ({
    source, present: !!row[source], digest: row[source] ? digest(row[source]) : null
  })),
  levels: row.levels_config ? JSON.parse(row.levels_config) : null,
  status: row.status, startedAt: row.started_at,
  enforcement: 'Content captured when this run was created; no assertion of model obedience or OS isolation'
});

module.exports = { digest, loadInstructionSources, observeFile, runReceipt, serverReceipt };
