// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// Real application, database, git diffs, provider lifecycle and HTTP/WebSocket routes.
// Only the GitHub transport and provider executable cross into deterministic fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-workspace-'));
const port = Number(process.env.WORKSPACE_TEST_PORT || 7399);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(home);
process.env.GITHUB_TOKEN = 'synthetic-no-network-token';
process.env.GH_TOKEN = 'synthetic-no-network-token';
process.env.PAIR_REVIEW_NO_OPEN = '1';
process.env.PORT = String(port);
process.env.WORKSPACE_PROVIDER_GATE = path.join(home, 'provider-result.json');
process.env.PAIR_REVIEW_OMP_CMD = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, 'workspace-provider.js'))}`;
const nativeFetch = global.fetch;
global.fetch = (url, options) => {
  const host = new URL(typeof url === 'string' ? url : url.url || url).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error('Fixture forbids external network requests');
  return nativeFetch(url, options);
};
const { initializeDatabase, ReviewRepository, WorktreeRepository, CommentRepository, AnalysisRunRepository } = require('../../src/database');
const { GitHubClient } = require('../../src/github/client');
const state = { prs: new Map(), reviews: new Map(), calls: [], viewer: 'reviewer', readError: null, partialAfter: null, failAfterSubmit: false };
const key = args => `${args.owner}/${args.repo}#${args.pull_number || args.prNumber || args.number}`;
const copy = value => JSON.parse(JSON.stringify(value));
const response = data => ({ data: copy(data), headers: {} });
let id = 1000;
const read = operation => async args => {
  if (state.readError) throw Object.assign(new Error('Synthetic host read failure'), { status: state.readError });
  return response(operation(args));
};
const graphReview = review => ({ ...review, viewerDidAuthor: review.user.login === state.viewer,
  createdAt: review.created_at, submittedAt: review.submitted_at, comments: { totalCount: review.comments.length, nodes: review.comments } });
const octokit = {
  rest: {
    users: { getAuthenticated: read(() => ({ login: state.viewer })) },
    teams: { listForAuthenticatedUser: read(() => [{ id: 7, slug: 'maintainers' }]) },
    pulls: {
      get: read(args => state.prs.get(key(args))),
      listReviews: read(args => [...state.reviews.values()].filter(review => review.key === key(args))),
      listRequestedReviewers: read(args => state.prs.get(key(args)).requests),
      listCommentsForReview: read(args => [...state.reviews.values()].find(review => review.databaseId === Number(args.review_id))?.comments || []),
      listReviewComments: read(args => [...state.reviews.values()].filter(review => review.key === key(args)).flatMap(review => review.comments)),
      listFiles: read(() => [{ filename: 'sample.js', status: 'modified', additions: 2, deletions: 2 }])
    },
    issues: { listComments: read(() => []) },
    repos: {
      getBranchProtection: read(() => ({ required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true }, required_status_checks: { contexts: ['build', 'lint'] } })),
      getRulesForBranch: read(() => []),
      listCommitStatusesForRef: read(() => [])
    },
    checks: { listForRef: read(args => ({ check_runs: [
      { id: 10, name: 'build', app: { id: 1 }, status: 'completed', conclusion: 'failure', started_at: '2026-01-01', details_url: 'https://example.invalid/checks/build' },
      { id: 11, name: 'lint', app: { id: 1 }, status: 'in_progress', conclusion: null, started_at: '2026-01-02', details_url: 'https://example.invalid/checks/lint' }
    ].map(check => ({ ...check, head_sha: args.ref })) })) }
  },
  paginate: async (method, args) => (await method(args)).data,
  graphql: async (source, args = {}) => {
    if (state.readError && !source.includes('mutation ')) throw Object.assign(new Error('Synthetic GraphQL read failure'), { status: state.readError });
    if (source.includes('addPullRequestReview(input:')) {
      const pr = [...state.prs.values()].find(pr => pr.node_id === args.prId);
      const databaseId = ++id;
      const review = { id: `REVIEW_${databaseId}`, databaseId, key: `${pr.repository}#${pr.number}`, user: { login: state.viewer },
        state: 'PENDING', body: args.body || '', commit_id: pr.head.sha, comments: [], created_at: new Date().toISOString(), url: `${pr.html_url}#review-${databaseId}`, html_url: `${pr.html_url}#review-${databaseId}` };
      state.reviews.set(review.id, review);
      state.calls.push({ operation: 'create', reviewId: review.id });
      return { addPullRequestReview: { pullRequestReview: graphReview(review) } };
    }
    if (source.includes('addPullRequestReviewThread(input:')) {
      const review = state.reviews.get(args.reviewId);
      const literals = [];
      const masked = source.replace(/"(?:\\.|[^"\\])*"/g, value => { literals.push(JSON.parse(value)); return `LITERAL_${literals.length - 1}`; });
      const data = {};
      for (const match of masked.matchAll(/(comment\d+):\s*addPullRequestReviewThread\(input:\s*\{([\s\S]*?)\}\)/g)) {
        const fields = match[2];
        const text = name => literals[Number(fields.match(new RegExp(`\\b${name}:\\s*LITERAL_(\\d+)`))?.[1])];
        const numeric = name => Number(fields.match(new RegExp(`\\b${name}:\\s*(\\d+)`))?.[1]) || null;
        const comment = { id: ++id, pull_request_review_id: review.databaseId, path: text('path'), body: text('body'),
          line: numeric('line'), start_line: numeric('startLine'), side: fields.match(/\bside:\s*(LEFT|RIGHT)/)?.[1] || null,
          subject_type: fields.includes('subjectType: FILE') ? 'file' : 'line', commit_id: review.commit_id, html_url: `${review.url}-comment-${id}` };
        review.comments.push(comment);
        state.calls.push({ operation: 'comment', reviewId: review.id, comment: copy(comment) });
        data[match[1]] = { thread: { id: `THREAD_${id}` } };
        if (state.partialAfter != null && --state.partialAfter === 0) {
          state.partialAfter = null;
          throw Object.assign(new Error('Synthetic partial GraphQL mutation'), { data, errors: [{ message: 'Later aliases failed', path: ['comment1'] }] });
        }
      }
      return data;
    }
    if (source.includes('submitPullRequestReview(input:')) {
      const review = state.reviews.get(args.reviewId);
      review.state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[args.event];
      review.body = args.body || '';
      review.submitted_at = new Date().toISOString();
      state.calls.push({ operation: 'submit', reviewId: review.id, event: args.event, body: review.body });
      if (state.failAfterSubmit) { state.failAfterSubmit = false; throw new Error('Synthetic response lost after publication'); }
      return { submitPullRequestReview: { pullRequestReview: graphReview(review) } };
    }
    if (source.includes('deletePullRequestReview(input:')) {
      state.calls.push({ operation: 'delete', reviewId: args.reviewId });
      state.reviews.delete(args.reviewId);
      return { deletePullRequestReview: { pullRequestReview: { id: args.reviewId } } };
    }
    if (args.nodeId) return { node: state.reviews.has(args.nodeId) ? graphReview(state.reviews.get(args.nodeId)) : null };
    const pr = state.prs.get(key(args));
    if (source.includes('reviewThreads(')) return { repository: { pullRequest: {
      reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', reviewThreads: { nodes: [
        { id: 'discussion-1', isResolved: false, isOutdated: false, comments: { nodes: [{ url: `${pr.html_url}#discussion-1`, author: { login: 'maintainer' } }] } }
      ], pageInfo: { hasNextPage: false } }
    } } };
    if (source.includes('reviews(states: PENDING')) return { repository: { pullRequest: { reviews: {
      nodes: [...state.reviews.values()].filter(review => review.key === key(args) && review.state === 'PENDING').map(graphReview)
    } } } };
    if (source.includes('viewer')) return { viewer: { login: state.viewer } };
    throw new Error('Unimplemented fixture GitHub query');
  }
};
GitHubClient.prototype._buildOctokit = () => octokit;
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function main() {
  fs.mkdirSync(path.join(home, '.pair-review'), { recursive: true });
  const repoPath = path.join(home, 'repository');
  const worktreePath = path.join(home, 'worktree');
  fs.mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', '--initial-branch=main', repoPath], { env: gitEnv });
  git(repoPath, ['config', 'user.email', 'fixture@example.invalid']);
  git(repoPath, ['config', 'user.name', 'Review Fixture']);
  git(repoPath, ['config', 'core.hooksPath', '/dev/null']);
  const lines = Array.from({ length: 40 }, (_, index) => `const value${index + 1} = ${index};`);
  fs.writeFileSync(path.join(repoPath, 'sample.js'), lines.join('\n') + '\n');
  git(repoPath, ['add', 'sample.js']); git(repoPath, ['commit', '-qm', 'Fixture base']);
  const baseSha = git(repoPath, ['rev-parse', 'HEAD']);
  git(repoPath, ['checkout', '-qb', 'review-head']);
  lines[1] = 'const value2 = 100;'; lines[12] = 'const value13 = 200;';
  fs.writeFileSync(path.join(repoPath, 'sample.js'), lines.join('\n') + '\n');
  git(repoPath, ['add', 'sample.js']); git(repoPath, ['commit', '-qm', 'Fixture head']);
  const headSha = git(repoPath, ['rev-parse', 'HEAD']);
  git(repoPath, ['checkout', '-q', 'main']);
  git(repoPath, ['worktree', 'add', '--quiet', '--detach', worktreePath, headSha]);
  const policy = path.join(home, 'review-policy.md');
  fs.writeFileSync(policy, '# Fixture policy\n\n## Review comments\nDescribe the specific defect and evidence. Do not post or modify files.\n');
  fs.writeFileSync(path.join(home, '.pair-review', 'config.json'), JSON.stringify({ port, single_port: true, dev_mode: true,
    default_provider: 'omp', default_model: 'default', comment_format: 'plain', external_comments: true, enable_chat: false,
    instruction_files: [{ path: policy, sections: ['Review comments'] }],
    repos: { 'example/alpha': { path: repoPath }, 'example/beta': { path: repoPath } }
  }));
  const db = await initializeDatabase('workspace.db');
  const repo = new ReviewRepository(db);
  const comments = new CommentRepository(db);
  const total = Number(process.env.WORKSPACE_TEST_REVIEW_COUNT || 4);
  for (let index = 0; index < total; index++) {
    const repository = index === 1 ? 'example/beta' : 'example/alpha';
    const number = index < 2 ? 42 : 41 + index;
    const now = new Date(Date.now() - index * 1000).toISOString();
    const pr = { repository, number, node_id: `PR_${index}`, title: `Preserve request state ${index + 1}`, body: 'Synthetic fixture only.',
      user: { login: index === 1 ? 'reviewer' : 'contributor' }, state: 'open', merged: false, draft: false,
      base: { ref: 'main', sha: baseSha, repo: { full_name: repository, clone_url: repoPath, default_branch: 'main' } },
      head: { ref: 'review-head', sha: headSha }, merge_commit_sha: null, mergeable: index === 2 ? null : true,
      html_url: `https://github.com/${repository}/pull/${number}`, created_at: now, updated_at: now, changed_files: 1,
      requests: { users: index === 0 ? [{ login: 'reviewer' }] : [], teams: index === 2 ? [{ id: 7, slug: 'maintainers' }] : [] } };
    state.prs.set(`${repository}#${number}`, pr);
    const data = { ...pr, author: pr.user.login, head_sha: headSha, base_sha: baseSha, base_branch: 'main', head_branch: 'review-head', worktree_path: worktreePath,
      diff: git(repoPath, ['diff', '--no-ext-diff', '--no-color', '--unified=3', `${baseSha}...${headSha}`]) + '\n' };
    db.prepare('INSERT INTO pr_metadata(pr_number, repository, title, description, author, base_branch, head_branch, pr_data, last_accessed_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(number, repository, pr.title, pr.body, pr.user.login, 'main', 'review-head', JSON.stringify(data), now);
    const { id: reviewId } = await repo.createReview({ prNumber: number, repository, status: 'draft' });
    if (index < 2) await new WorktreeRepository(db).create({ prNumber: number, repository, branch: 'review-head', path: worktreePath, explicitId: `worktree-${index}` });
    if (index === 0) {
      await comments.createLineComment({ review_id: reviewId, file: 'sample.js', line_start: 2, line_end: 2, side: 'LEFT', body: 'Removing this guard changes the failure path.' });
      await comments.createLineComment({ review_id: reviewId, file: 'sample.js', line_start: 12, line_end: 14, side: 'RIGHT', body: 'These assignments no longer share the same value.' });
      await comments.createFileComment({ review_id: reviewId, file: 'sample.js', body: 'Keep the file-level invariant explicit.' });
    }
  }
  require('../../src/ai').checkAllProviders = async () => {};
  require('../../src/chat/chat-providers').checkAllChatProviders = async () => {};
  const { startServer } = require('../../src/server');
  await startServer(db);
  const admin = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port + 1}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const changes = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (request.method === 'POST' && url.pathname === '/control') {
      for (const field of ['readError', 'partialAfter', 'failAfterSubmit', 'viewer']) if (Object.hasOwn(changes, field)) state[field] = changes[field];
      if (changes.providerResult) fs.writeFileSync(process.env.WORKSPACE_PROVIDER_GATE, JSON.stringify(changes.providerResult));
      if (changes.pr) Object.assign(state.prs.get(changes.key || 'example/alpha#42'), changes.pr);
      if (changes.policy) fs.writeFileSync(policy, changes.policy);
      if (changes.importResult) await new AnalysisRunRepository(db).create({ id: changes.importResult, reviewId: 1, provider: 'fixture-import', model: 'not-executed', status: 'completed', totalSuggestions: 0 });
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ calls: state.calls, reviews: [...state.reviews.values()], home, providerGate: process.env.WORKSPACE_PROVIDER_GATE,
      analysis: db.prepare('SELECT id, status, activity_state FROM analysis_runs').all(), comments: db.prepare("SELECT id, review_id, source, status, file, side, line_start, line_end, body FROM comments WHERE source = 'user'").all() }));
  });
  await new Promise(resolve => admin.listen(port + 1, '127.0.0.1', resolve));
  console.log(JSON.stringify({ fixtureReady: true, port, adminPort: port + 1, home, pid: process.pid }));
}
main().catch(error => { console.error(error); process.exit(1); });
