// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { createHash } = require('node:crypto');
const MarkdownIt = require('markdown-it');

const rules = Object.freeze({
  'long-dashes': 'Review long dashes in prose; leave technical literals unchanged.',
  emojis: 'Review emoji in prose.',
  'bold-prose': 'Review bold prose labels or emphasis.',
  'bracket-prefix': 'Use only [nit] as a bracketed prose prefix.',
  'terminal-period': 'Review the final prose period; preserve questions and technical punctuation.'
});
const hash = value => createHash('sha256').update(value).digest('hex');
let markdown;

function prosePolicy(config = {}) {
  const policy = config.review_prose;
  if (policy != null && (typeof policy !== 'object' || Array.isArray(policy))) throw new Error('review_prose must be an object');
  if (policy?.profile != null && typeof policy.profile !== 'string') throw new Error('review_prose.profile must be a string');
  const configured = policy?.rules || {};
  if (typeof configured !== 'object' || Array.isArray(configured)) throw new Error('review_prose.rules must be an object');
  const enabled = Object.keys(configured).sort().map(rule => {
    if (!Object.hasOwn(rules, rule) || !['advisory', 'blocking'].includes(configured[rule])) throw new Error(`Unsupported review_prose rule or severity: ${JSON.stringify(rule)}`);
    const source = `review_prose.rules.${rule}`;
    return { rule, severity: configured[rule], source, layer: config._protocol?.fieldSources?.[source] || 'not_recorded' };
  });
  const result = { version: 1, profile: policy?.profile || null, rules: enabled,
    profileSource: config._protocol?.fieldSources?.['review_prose.profile'] || 'not_recorded',
    instructionDigest: config.globalInstructions ? hash(config.globalInstructions) : null };
  return { ...result, digest: hash(JSON.stringify(result)), state: enabled.length ? 'configured' : 'not_configured',
    enforcement: 'Configured structural checks only. Tone, grammar, uncertainty and factual correctness require human judgment; no text is rewritten.' };
}

// Parse structure first so code, suggestion blocks and literal links are not prose
function inspectProse(body) {
  markdown ||= new MarkdownIt({ html: true, linkify: true });
  const paragraphs = [];
  let quoteDepth = 0;
  let bold = false;
  for (const block of markdown.parse(body, {})) {
    if (block.type === 'blockquote_open') quoteDepth++;
    else if (block.type === 'blockquote_close') quoteDepth--;
    if (quoteDepth || block.type !== 'inline') continue;
    let text = '';
    let boldDepth = 0;
    let literalDepth = 0;
    let link = null;
    for (const token of block.children || []) {
      if (token.type === 'strong_open') boldDepth++;
      else if (token.type === 'strong_close') boldDepth--;
      else if (token.type === 'link_open') link = { href: token.attrGet('href'), literal: token.info === 'auto' };
      else if (token.type === 'link_close') link = null;
      else if (token.type === 'html_inline') {
        if (/^<(?:code|pre|kbd|samp)(?:\s|>)/i.test(token.content)) literalDepth++;
        else if (/^<\/(?:code|pre|kbd|samp)\s*>/i.test(token.content)) literalDepth = Math.max(0, literalDepth - 1);
      } else if (token.type === 'text' && !literalDepth && !link?.literal && token.content !== link?.href &&
        !(link && /^(?:[a-z][a-z\d+.-]*:\S+|www\.\S+)$/iu.test(token.content))) {
        text += token.content;
        if (boldDepth && token.content.trim()) bold = true;
      } else if (['softbreak', 'hardbreak'].includes(token.type)) text += '\n';
    }
    if (text.trim()) paragraphs.push(text.trim());
  }
  const prose = paragraphs.join('\n');
  const prefix = paragraphs[0]?.match(/^\[([^\]\n]+)\](?:\s|$)/u);
  return {
    'long-dashes': /[\u2013\u2014]/u.test(prose),
    emojis: /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[0-9#*]\uFE0F?\u20E3/u.test(prose),
    'bold-prose': bold,
    'bracket-prefix': Boolean(prefix && prefix[1] !== 'nit'),
    'terminal-period': paragraphs.at(-1)?.endsWith('.') || false
  };
}

function checkReviewProse(config, entries) {
  const policy = prosePolicy(config);
  const diagnostics = [];
  if (policy.rules.length) for (const entry of entries) {
    if (typeof entry.body !== 'string') continue;
    const findings = inspectProse(entry.body);
    for (const rule of policy.rules) if (findings[rule.rule]) {
      diagnostics.push({ ...rule, key: entry.key, message: rules[rule.rule] });
    }
  }
  return { ...policy, checkedTextDigest: hash(JSON.stringify(entries)), diagnostics };
}

module.exports = { prosePolicy, checkReviewProse };
