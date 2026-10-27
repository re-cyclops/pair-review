// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import express from 'express';
import { createTestDatabase } from '../utils/schema.js';
const routes = require('../../src/routes/reviews');
const { CommentManager } = require('../../public/js/modules/comment-manager.js');
const draftModule = require.resolve('../../public/js/modules/draft-store.js');
delete require.cache[draftModule];
require(draftModule);
const drafts = window.reviewDrafts;
const realFetch = globalThis.fetch;
let db, server, base, manager, targetRow, offline;

beforeEach(async () => {
  sessionStorage.clear();
  drafts.entries.clear();
  drafts.connect({ dbId: 'suggestion-editor-db', instanceId: 'suggestion-editor-instance' });
  db = createTestDatabase();
  db.prepare("INSERT INTO reviews (id, repository, pr_number) VALUES (1, 'owner/repo', 1)").run();
  db.prepare("INSERT INTO comments (id, review_id, file, line_start, line_end, side, body, source) VALUES (1, 1, 'a.js', 42, 44, 'LEFT', 'Original AI finding', 'ai')").run();
  db.prepare("INSERT INTO comments (id, review_id, file, line_start, line_end, side, body, source) VALUES (2, 1, 'a.js', 42, 44, 'LEFT', 'Original AI finding', 'ai')").run();
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('config', { comment_format: 'plain' });
  app.use(routes);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  offline = false;
  vi.stubGlobal('fetch', (url, options) => {
    if (offline) return Promise.reject(new TypeError('Connection unavailable'));
    return realFetch(new URL(url, base), options);
  });
  window.prManager = {
    currentPR: { id: 1, head_sha: 'a'.repeat(40) }, loadUserComments() {},
    escapeHtml(text) { const node = document.createElement('span'); node.textContent = text; return node.innerHTML; }
  };
  document.body.innerHTML = '<table><tbody><tr id="target"></tr></tbody></table>';
  document.body.append(drafts.button);
  targetRow = document.getElementById('target');
  manager = Object.create(CommentManager.prototype);
  manager.prManager = window.prManager;
  manager.currentCommentForm = null;
});

afterEach(async () => {
  for (const entry of drafts.entries.values()) clearTimeout(entry.timer);
  await Promise.allSettled([...drafts.entries.values()].map(entry => entry.saving));
  clearTimeout(drafts.refreshTimer);
  const stopped = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await stopped;
  db.close();
  drafts.entries.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

async function openEditor(onSave = async () => {}, id = 1) {
  const row = manager.displaySuggestionEditForm({ id, file: 'a.js', lineNumber: 42, lineEnd: 44,
    side: 'LEFT', body: 'Original AI finding', type: 'issue', title: 'Preserve this invariant' }, targetRow, onSave, () => {});
  const textarea = row.querySelector('textarea');
  await textarea.draftReady;
  return { row, textarea };
}

function edit(textarea, body) {
  textarea.value = body;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Edited suggestion draft preservation', () => {
  it('saves edited text excluded from publication without adopting the AI finding', async () => {
    const { row, textarea } = await openEditor();
    const body = '    preserveWhitespace();\n\nKeep `technical_value`.\n';
    edit(textarea, body);
    await drafts.flush(textarea.draftEntry);
    expect(db.prepare("SELECT body, included, parent_id, side, line_start, line_end FROM comments WHERE source = 'user'").get())
      .toEqual({ body, included: 0, parent_id: 1, side: 'LEFT', line_start: 42, line_end: 44 });
    expect(db.prepare('SELECT body, status FROM comments WHERE id = 1').get())
      .toEqual({ body: 'Original AI finding', status: 'active' });
    row.querySelector('.cancel-edit-btn').click();
    expect(row.isConnected).toBe(false);
    expect(db.prepare("SELECT body FROM comments WHERE source = 'user'").get().body).toBe(body);
  });

  it('includes the same acknowledged draft on explicit adoption instead of creating a duplicate or rewriting its text', async () => {
    const { row, textarea } = await openEditor(async (editedText, draft) => {
      const response = await fetch('/api/reviews/1/suggestions/1/edit', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'adopt_edited', editedText, draft }) });
      if (!response.ok) throw new Error((await response.json()).error);
    });
    const body = 'Exact edited finding.\n\n    doNotRewrite();\n';
    edit(textarea, body);
    const saved = await drafts.flush(textarea.draftEntry);
    row.querySelector('.save-edit-btn').click();
    await vi.waitFor(() => expect(row.isConnected).toBe(false));
    expect(db.prepare("SELECT id, body, included, parent_id FROM comments WHERE source = 'user'").all())
      .toEqual([{ id: saved.id, body, included: 1, parent_id: 1 }]);
    expect(db.prepare('SELECT body, status FROM comments WHERE id = 1').get())
      .toEqual({ body: 'Original AI finding', status: 'adopted' });
  });

  it('retains offline text and the editor when explicit saving fails', async () => {
    const { row, textarea } = await openEditor();
    offline = true;
    edit(textarea, 'Unacknowledged text\n');
    const button = row.querySelector('.save-edit-btn');
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(row.isConnected).toBe(true);
    expect(textarea.value).toBe('Unacknowledged text\n');
    expect(db.prepare("SELECT id FROM comments WHERE source = 'user'").all()).toEqual([]);
    const recovered = JSON.parse(sessionStorage.getItem(`${drafts.prefix}1:${textarea.draftEntry.key}`));
    expect(recovered.body).toBe('Unacknowledged text\n');
    expect(recovered.included).toBe(false);
  });

  it('retains the first offline edit when another suggestion replaces its form', async () => {
    const first = await openEditor();
    offline = true;
    edit(first.textarea, 'Keep the first unsaved draft\n');
    const second = await openEditor(async () => {}, 2);
    expect(first.row.isConnected).toBe(false);
    expect(second.row.isConnected).toBe(true);
    expect(drafts.entries.get(first.textarea.draftEntry.key).body).toBe('Keep the first unsaved draft\n');
    expect(JSON.parse(sessionStorage.getItem(`${drafts.prefix}1:${first.textarea.draftEntry.key}`)).body)
      .toBe('Keep the first unsaved draft\n');
    expect(db.prepare("SELECT id FROM comments WHERE source = 'user'").all()).toEqual([]);
  });
});
