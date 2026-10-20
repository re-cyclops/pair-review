// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { AsyncLocalStorage } = require('node:async_hooks');
const logger = require('../utils/logger');

const execution = new AsyncLocalStorage();

function mergeModels(...groups) {
  const result = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (typeof entry?.provider !== 'string' || !entry.provider.trim()
        || typeof entry?.model !== 'string' || !entry.model.trim()) continue;
      const pair = { provider: entry.provider.trim(), model: entry.model.trim() };
      if (!result.some(item => item.provider === pair.provider && item.model === pair.model)) result.push(pair);
    }
  }
  return result;
}

// Only completed assistant messages are evidence. Session/model-selection events
// describe intent, and failed or aborted messages may name an unserved fallback.
function modelsFromEvent(event) {
  const messages = event?.type === 'agent_end' ? event.messages
    : ['message_end', 'turn_end'].includes(event?.type) ? [event.message] : [];
  return mergeModels((messages || []).filter(message => message?.role === 'assistant'
    && !['error', 'aborted'].includes(message.stopReason) && !message.errorMessage));
}

function recordModels(models) {
  if (!models.length) return;
  for (let scope = execution.getStore(); scope; scope = scope.parent) {
    if (!scope.active) continue;
    const combined = mergeModels(scope.models, models);
    if (combined.length === scope.models.length) continue;
    scope.models = combined;
    try {
      scope.db.prepare(`UPDATE analysis_runs SET activity_state = json_set(
        COALESCE(activity_state, '{}'), '$.actualModels', json(?)) WHERE id = ?`)
        .run(JSON.stringify(combined), scope.runId);
    } catch (error) {
      logger.warn(`Could not persist serving model evidence for ${scope.runId}: ${error.message}`);
    }
  }
}

async function withModelEvidence(db, runId, callback) {
  const scope = { db, runId, parent: execution.getStore(), models: [], active: true };
  return execution.run(scope, async () => {
    try { return await callback(); } finally { scope.active = false; }
  });
}

function actualModelsForRun(run) {
  let state = run?.activity_state;
  if (typeof state === 'string') {
    try { state = JSON.parse(state); } catch { state = null; }
  }
  return mergeModels(state?.actualModels);
}

module.exports = { actualModelsForRun, mergeModels, modelsFromEvent, recordModels, withModelEvidence };
