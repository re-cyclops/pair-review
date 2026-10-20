// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

// Templates are never persisted or merged into user-owned saved councils.
const reviewers = [
  'zai/glm-5.3-flash:high',
  'google-antigravity/gemini-3.8-flash:high',
  'muse-code/muse-wonder-full-1.0:high',
  'openai-codex/gpt-6.1-sol:high'
];

function getCouncilTemplates() {
  return [false, true].map(full => ({
    id: full ? 'four-model-full' : 'four-model-focused',
    name: full ? 'Four-model full review' : 'Four-model focused review',
    description: full
      ? 'Changes + file + codebase (levels 1–3). Broader coverage; more time and model usage.'
      : 'Changes + file context (levels 1–2). Lower cost and faster than full review.',
    type: 'council',
    config: {
      voices: reviewers.map(model => ({ provider: 'omp', model, tier: 'thorough' })),
      levels: { '1': true, '2': true, '3': full },
      consolidation: { provider: 'omp', model: 'muse-code/muse-wonder-full-1.0:high', tier: 'thorough' }
    }
  }));
}

module.exports = { getCouncilTemplates };
