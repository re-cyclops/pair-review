// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const simpleGit = require('simple-git');
const { parseUnifiedDiffPatches, mergeChangedFilesWithDiff } = require('./utils/diff-file-list');
const { safeParseJson } = require('./utils/safe-parse-json');
const { reviewScope } = require('./local-scope');
const { GIT_DIFF_FLAGS_ARRAY } = require('./git/diff-flags');
const { identity } = require('./analysis-activity');

const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => hash(JSON.stringify(value));
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const sha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value);
const diffContext = (head, diff) => ({ head: head || null, digest: typeof diff === 'string' ? hash(diff) : null });
const revisionState = (head, currentHead) => ({
  state: !sha(head) || !sha(currentHead) ? 'unknown' : head === currentHead ? 'current' : 'stale',
  head: sha(head) ? head : null,
  currentHead: sha(currentHead) ? currentHead : null
});
const readState = row => safeParseJson(row?.review_progress) || { files: {}, visited: {} };

// The existing review ID owns progress. Reading/opening or finishing an AI run
// never advances the explicit human-reviewed baseline.
function recordedContext(db, reviewId) {
  const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId);
  if (!review) throw fail('Review not found', 404);
  const local = review.review_type === 'local';
  const metadata = local ? null : db.prepare('SELECT pr_data FROM pr_metadata WHERE repository = ? COLLATE NOCASE AND pr_number = ?').get(review.repository, review.pr_number);
  const pr = safeParseJson(metadata?.pr_data) || {};
  const snapshot = local ? db.prepare('SELECT diff_text, digest FROM local_diffs WHERE review_id = ?').get(reviewId) : null;
  const diff = local ? snapshot?.diff_text : pr.diff;
  const head = local ? review.local_head_sha : pr.head_sha;
  const scope = local ? { ...reviewScope(review), baseBranch: review.local_base_branch || null } : { start: 'branch', end: 'head' };
  const scopeKey = encode(scope);
  const base = local ? review.local_base_branch || null : pr.base_sha || null;
  const directory = local ? review.local_path : pr.worktree_path;
  const entries = db.prepare('SELECT file, line_start, line_end FROM context_files WHERE review_id = ? ORDER BY file, line_start, line_end').all(reviewId);
  return { review, local, diff, head, base, scope, scopeKey, directory, entries };
}

function sameRecordedContext(a, b) {
  return a.review.id === b.review.id && a.local === b.local && a.head === b.head && a.base === b.base
    && a.scopeKey === b.scopeKey && a.directory === b.directory && a.diff === b.diff
    && JSON.stringify(a.entries) === JSON.stringify(b.entries);
}

async function context(db, reviewId) {
  const recorded = db.transaction(() => recordedContext(db, reviewId))();
  const { review, local, diff, head, base, scopeKey, directory, entries } = recorded;
  const contentDigest = typeof diff === 'string' ? hash(diff) : null;
  const signatures = new Map();
  for (const [file, patch] of parseUnifiedDiffPatches(diff || '')) signatures.set(file, encode([scopeKey, patch]));
  // Pinned context is independent of a diff entry for the same file. Range and
  // actual file contents participate; moving a range cannot retain an old mark.
  const ranges = new Map();
  for (const entry of entries) {
    if (!ranges.has(entry.file)) ranges.set(entry.file, []);
    ranges.get(entry.file).push([entry.line_start, entry.line_end]);
  }
  for (const [file, spans] of ranges) {
    let content = null;
    try {
      if (!directory) continue;
      if (!local && sha(head)) content = await simpleGit(directory).raw(['show', `${head}:${file}`]);
      else if (local) {
        const root = await fs.realpath(directory);
        const resolved = await fs.realpath(path.resolve(root, file));
        if (!resolved.startsWith(root + path.sep)) continue;
        content = await fs.readFile(resolved);
      }
    } catch { /* Unavailable content never certifies a viewed mark. */ }
    if (content !== null) signatures.set(`context:${file}`, encode([scopeKey, spans, hash(content)]));
  }
  const token = encode([identity(db).dbId, review.id, head, base, scopeKey, contentDigest, [...signatures]]);
  return { ...recorded, state: readState(review), contentDigest, token, signatures };
}

function describe(db, ctx) {
  const { state, signatures } = ctx;
  const files = [...signatures.keys()].filter(file => state.files?.[file]?.signature === signatures.get(file));
  const visited = [...signatures.keys()].filter(file => state.visited?.[file] === signatures.get(file));
  const lastRun = db.prepare('SELECT head_sha FROM analysis_runs WHERE review_id = ? AND parent_run_id IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1').get(ctx.review.id);
  const comments = db.prepare(`SELECT
    SUM(CASE WHEN source = 'ai' AND status IN ('adopted', 'dismissed') THEN 1 ELSE 0 END) AS triaged,
    SUM(CASE WHEN source = 'user' AND status IN ('active', 'draft') AND deleted_at IS NULL AND included = 1 THEN 1 ELSE 0 END) AS selected,
    SUM(CASE WHEN source = 'user' AND deleted_at IS NULL AND status IN ('active', 'draft') AND commit_sha IS NOT ? THEN 1 ELSE 0 END) AS stale
    FROM comments WHERE review_id = ?`).get(ctx.head, ctx.review.id);
  const baseline = state.reviewed || null;
  return { reviewId: ctx.review.id, token: ctx.token, head: ctx.head || null, base: ctx.base, scope: ctx.scope,
    contentDigest: ctx.contentDigest, progressRevision: state.revision || 0,
    available: typeof ctx.diff === 'string' && !!ctx.head, files, visited, totalFiles: [...signatures.keys()].filter(file => !file.startsWith('context:')).length,
    reviewedFiles: files.filter(file => !file.startsWith('context:')).length,
    visitedFiles: visited.filter(file => !file.startsWith('context:')).length,
    lastOpened: state.opened || null, lastReviewed: baseline, lastAnalyzedHead: lastRun?.head_sha || null,
    newCommits: baseline && ctx.head ? baseline.head !== ctx.head : null,
    changedContent: baseline ? baseline.digest !== ctx.contentDigest || baseline.scopeKey !== ctx.scopeKey : null,
    legacyViewedCount: state.legacyFiles?.length || 0,
    triagedFindings: comments.triaged || 0, selectedComments: comments.selected || 0, staleDrafts: comments.stale || 0,
    submitted: !!db.prepare("SELECT 1 FROM submission_attempts WHERE review_id = ? AND state = 'submitted' LIMIT 1").get(ctx.review.id) };
}

async function getProgress(db, reviewId) { return describe(db, await context(db, reviewId)); }

async function updateProgress(db, reviewId, input) {
  const ctx = await context(db, reviewId);
  if (input.token !== ctx.token) throw fail('The displayed revision or scope changed. Reload the full current diff before recording progress.');
  if (typeof ctx.diff !== 'string' || !ctx.head) throw fail('The current diff is unavailable. Progress was not changed.');
  if (!['opened', 'reviewed', 'files', 'visited', 'import-history'].includes(input.action)) throw fail('Invalid progress action', 400);
  let committed = false;
  if (input.action === 'reviewed' && ctx.local) {
    try {
      const git = simpleGit(ctx.directory);
      const [head, status] = await Promise.all([git.revparse(['HEAD']), git.status()]);
      if (head.trim() !== ctx.head) throw fail('The checkout moved. Refresh the full current diff first.');
      committed = status.isClean() && ctx.scope.start === 'branch';
    } catch (error) {
      if (error.statusCode) throw error;
      throw fail('The local checkout could not be verified. Progress was not changed.');
    }
  }
  if ((await context(db, reviewId)).token !== ctx.token) throw fail('The review changed while progress was being recorded. Reload the full current diff.');
  db.transaction(() => {
    if (!sameRecordedContext(ctx, recordedContext(db, reviewId))) throw fail('The review changed while progress was being recorded. Reload the full current diff.');
    // Merge patches into the latest row, not the state read before git I/O.
    const state = readState(db.prepare('SELECT review_progress FROM reviews WHERE id = ?').get(reviewId));
    state.files ||= {};
    state.visited ||= {};
    const at = new Date().toISOString();
    if (input.action === 'opened') state.opened = { head: ctx.head, digest: ctx.contentDigest, at };
    if (input.action === 'reviewed') state.reviewed = { head: ctx.head, base: ctx.base, scopeKey: ctx.scopeKey, digest: ctx.contentDigest, at, committed: !ctx.local || committed };
    if (input.action === 'files') {
      if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) throw fail('File progress changes are required', 400);
      for (const [file, viewed] of Object.entries(input.changes)) {
        if (typeof viewed !== 'boolean') throw fail('File progress must be boolean', 400);
        if (!viewed) delete state.files[file];
        else {
          if (!ctx.signatures.has(file)) throw fail('This file or context range is no longer available. Refresh the diff.');
          Object.defineProperty(state.files, file, { value: { signature: ctx.signatures.get(file), head: ctx.head, at }, enumerable: true, configurable: true, writable: true });
          Object.defineProperty(state.visited, file, { value: ctx.signatures.get(file), enumerable: true, configurable: true, writable: true });
        }
      }
    }
    if (input.action === 'visited') {
      if (typeof input.file !== 'string') throw fail('A visited file path is required', 400);
      if (ctx.signatures.has(input.file)) Object.defineProperty(state.visited, input.file, { value: ctx.signatures.get(input.file), enumerable: true, configurable: true, writable: true });
    }
    if (input.action === 'import-history') {
      if (!Array.isArray(input.files) || input.files.some(file => typeof file !== 'string')) throw fail('Legacy history must contain file paths', 400);
      state.legacyFiles = [...new Set([...(state.legacyFiles || []), ...input.files])];
    }
    state.revision = (state.revision || 0) + 1;
    db.prepare('UPDATE reviews SET review_progress = ? WHERE id = ?').run(JSON.stringify(state), reviewId);
    ctx.state = state;
  })();
  return describe(db, ctx);
}

async function compareReviewed(db, reviewId, token) {
  const ctx = await context(db, reviewId);
  const baseline = ctx.state.reviewed;
  const fallback = reason => ({ available: false, reason, baseline: baseline || null, head: ctx.head || null, token: ctx.token, fullDiff: true });
  if (token !== ctx.token) return fallback('The displayed revision changed. Reload the full current diff.');
  if (!baseline) return fallback('No revision has been explicitly marked reviewed. The full current diff remains displayed.');
  if (baseline.scopeKey !== ctx.scopeKey) return fallback('The local scope changed since review. Use the full current diff.');
  if (!baseline.committed) return fallback('The reviewed baseline included uncommitted changes. Use the full current diff; no committed comparison can represent that snapshot.');
  if (!ctx.directory || !sha(baseline.head) || !sha(ctx.head)) return fallback('The comparison commits or checkout are unavailable. Use the full current diff.');
  try {
    const git = simpleGit(ctx.directory);
    const [head, status] = await Promise.all([git.revparse(['HEAD']), ctx.local ? git.status() : Promise.resolve(null)]);
    if (head.trim() !== ctx.head || status && !status.isClean()) return fallback('The checkout differs from the displayed committed revision. Refresh the full current diff.');
    if ((await git.raw(['merge-base', baseline.head, ctx.head])).trim() !== baseline.head) {
      return fallback('The reviewed commit is not an ancestor after a rebase or force push. Use the full current diff.');
    }
    if (baseline.head === ctx.head && baseline.digest !== ctx.contentDigest) return fallback('The comparison base or working content changed without a new head. Use the full current diff.');
    const diff = await git.diff([...GIT_DIFF_FLAGS_ARRAY, '--no-textconv', '--find-renames', `${baseline.head}..${ctx.head}`, '--']);
    if (/^(rename from |deleted file mode )/m.test(diff)) return fallback('Files were renamed or deleted since review. Use the full current diff to preserve current anchors.');
    const count = Number((await git.raw(['rev-list', '--count', `${baseline.head}..${ctx.head}`])).trim());
    // Do not deliver a comparison computed for a superseded cached revision.
    const latest = await context(db, reviewId);
    if (latest.token !== ctx.token) return fallback('The review changed while comparison loaded. Refresh the full current diff.');
    return { available: true, baseline, head: ctx.head, token: ctx.token, diff, commitCount: count,
      files: mergeChangedFilesWithDiff([], diff), fullDiff: false };
  } catch { return fallback('The reviewed commit is missing or is not an ancestor (for example after a rebase or force push). Use the full current diff.'); }
}

function baselineInstructions(baseline) {
  if (!baseline?.head) return null;
  return `Human review context: the last explicitly reviewed revision is ${baseline.head} (recorded ${baseline.at}). This is navigation context, not evidence of correctness. Review the full current review diff and repository context; do not shrink AI scope to the changes-since comparison. Local baseline committed: ${Boolean(baseline.committed)}.`;
}

module.exports = { getProgress, updateProgress, compareReviewed, baselineInstructions, diffContext, revisionState };
