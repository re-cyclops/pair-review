// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// Real application, database, git diffs, provider lifecycle and HTTP/WebSocket routes.
// Only the GitHub transport and provider executable cross into deterministic fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const appRoot = path.resolve(process.env.WORKSPACE_TEST_APP_ROOT || path.join(__dirname, '../..'));
const home = process.env.WORKSPACE_TEST_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-workspace-'));
const files = Array.from({ length: Number(process.env.WORKSPACE_TEST_FILE_COUNT || 1) }, (_, index) => index ? `sample-${index}.js` : 'sample.js');
const lineCount = Number(process.env.WORKSPACE_TEST_LINES || 40);
const historyCount = Number(process.env.WORKSPACE_TEST_HISTORY_COUNT || 0);
const fixtureNow = process.env.WORKSPACE_TEST_NOW ? Date.parse(process.env.WORKSPACE_TEST_NOW) : Date.now();
const changedLines = [...new Set([1, 12, ...(files.length > 1 ? Array.from({ length: Math.floor((lineCount - 20) / 8) }, (_, index) => 20 + index * 8) : [])])];
// The baseline application predates explicit loopback binding. Keep both
// comparison servers private at the fixture's network boundary.
const net = require('node:net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number') {
    if (typeof args[1] === 'string') args[1] = '127.0.0.1';
    else args.splice(1, 0, '127.0.0.1');
  } else if (args[0] && typeof args[0] === 'object' && args[0].port) args[0] = { ...args[0], host: '127.0.0.1' };
  return listen.apply(this, args);
};
const port = Number(process.env.WORKSPACE_TEST_PORT || 7399);
process.env.HOME = home;
process.env.USERPROFILE = home;
if (require.main === module) process.chdir(home);
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
const { initializeDatabase, ReviewRepository, WorktreeRepository, CommentRepository, AnalysisRunRepository } = require(path.join(appRoot, 'src/database'));
const { GitHubClient } = require(path.join(appRoot, 'src/github/client'));
const hostStatePath = path.join(home, 'synthetic-host.json');
const saved = fs.existsSync(hostStatePath) ? JSON.parse(fs.readFileSync(hostStatePath, 'utf8')) : {};
const state = { calls: [], viewer: 'reviewer', readError: null, partialAfter: null, failAfterSubmit: false,
  ...saved, prs: new Map(saved.prs || []), reviews: new Map(saved.reviews || []) };
const readCalls = [];
let activeReads = 0;
let maxConcurrentReads = 0;
const key = args => `${args.owner}/${args.repo}#${args.pull_number || args.prNumber || args.number}`;
const copy = value => JSON.parse(JSON.stringify(value));
const response = data => ({ data: copy(data), headers: {} });
let id = saved.nextId || 1000;
const persistHost = () => fs.writeFileSync(hostStatePath, JSON.stringify({ ...state,
  prs: [...state.prs], reviews: [...state.reviews], nextId: id }));
const read = operation => async args => {
  if (state.readError) throw Object.assign(new Error('Synthetic host read failure'), { status: state.readError });
  return response(operation(args));
};
const graphComment = comment => ({ ...comment, id: `COMMENT_${comment.id}`, databaseId: comment.id,
  startLine: comment.start_line, subjectType: comment.subject_type?.toUpperCase(), url: comment.html_url });
const graphReview = review => ({ ...review, viewerDidAuthor: review.user.login === state.viewer,
  author: review.user, commit: { oid: review.commit_id }, repository: { nameWithOwner: review.key.split('#')[0] },
  pullRequest: { number: Number(review.key.split('#')[1]) }, createdAt: review.created_at, submittedAt: review.submitted_at,
  comments: { totalCount: review.comments.length, nodes: review.comments.map(graphComment), pageInfo: { hasNextPage: false, endCursor: null } } });
const octokit = {
  rest: {
    users: { getAuthenticated: read(() => ({ id: state.viewer === 'reviewer' ? 7 : 8, login: state.viewer })) },
    teams: { listForAuthenticatedUser: read(() => [{ id: 7, slug: 'maintainers' }]) },
    search: { issuesAndPullRequests: read(({ q }) => ({ items: [...state.prs.values()].filter(pr => {
      if (q.includes('reviewed-by:')) return [...state.reviews.values()].some(review => review.key === `${pr.repository}#${pr.number}` && review.user?.login === state.viewer);
      if (q.includes('author:')) return pr.user.login === state.viewer;
      if (q.includes('team-review-requested:') || q.includes('-user-review-requested:')) return pr.requests.teams.length && !pr.requests.users.some(user => user.login === state.viewer);
      return pr.requests.users.some(user => user.login === state.viewer);
    }).map(pr => ({ ...pr, repository_url: `https://api.github.com/repos/${pr.repository}` })) })) },
    pulls: {
      get: read(args => {
        const pr = state.prs.get(key(args));
        if (!args.mediaType?.format && state.foreignCommentOnIdentity === key(args)) {
          const pending = [...state.reviews.values()].find(review => review.key === key(args) && review.state === 'PENDING' && review.comments.length);
          if (pending) {
            const comment = { id: ++id, pull_request_review_id: pending.databaseId, path: 'sample.js',
              body: 'Unselected host addition during the final identity check', line: 2, side: 'RIGHT',
              subject_type: 'line', commit_id: pending.commit_id, html_url: `${pending.url}-comment-${id}` };
            pending.comments.push(comment);
            state.calls.push({ operation: 'external-comment', reviewId: pending.id, comment: copy(comment) });
            state.foreignCommentOnIdentity = null;
            persistHost();
          }
        }
        return args.mediaType?.format === 'diff'
          ? git(path.join(home, 'repository'), ['diff', '--no-ext-diff', '--no-color', '--unified=3', `${pr.base.sha}...${pr.head.sha}`]) + '\n' : pr;
      }),
      listReviews: read(args => [...state.reviews.values()].filter(review => review.key === key(args))),
      listRequestedReviewers: read(args => state.prs.get(key(args)).requests),
      listCommentsForReview: read(args => [...state.reviews.values()].find(review => review.databaseId === Number(args.review_id))?.comments || []),
      listReviewComments: read(args => [...state.reviews.values()].filter(review => review.key === key(args)).flatMap(review => review.comments)),
      listFiles: read(() => files.map(filename => ({ filename, status: 'modified', additions: changedLines.length, deletions: changedLines.length })))
    },
    issues: { listComments: read(() => []) },
    repos: {
      get: read(({ owner, repo }) => {
        const pr = [...state.prs.values()].find(value => value.repository === `${owner}/${repo}`);
        if (!pr) throw Object.assign(new Error('Synthetic repository not found'), { status: 404 });
        return pr.base.repo;
      }),
      getBranchProtection: read(() => ({ required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true }, required_status_checks: { contexts: ['build', 'lint'] } })),
      getRulesForBranch: read(() => []),
      listCommitStatusesForRef: read(args => state.commitStatuses?.[args.ref] || [])
    },
    checks: { listForRef: read(args => ({ check_runs: (state.checkRuns?.[args.ref] || [
      { id: 10, name: 'build', app: { id: 1 }, status: 'completed', conclusion: 'failure', started_at: '2026-01-01', details_url: 'https://example.invalid/checks/build' },
      { id: 11, name: 'lint', app: { id: 1 }, status: 'in_progress', conclusion: null, started_at: '2026-01-02', details_url: 'https://example.invalid/checks/lint' }
    ]).map(check => ({ head_sha: args.ref, ...check })) })) }
  },
  paginate: async (method, args) => {
    const results = [];
    for (let page = 1; ; page++) {
      const response = await method({ ...args, per_page: 100, page });
      const data = response.data;
      results.push(...(Array.isArray(data) ? data : data.items || data.check_runs || []));
      if (!response.headers.link) return results;
    }
  },
  graphql: async (source, args = {}) => {
    const literals = [];
    const syntax = source.replace(/"(?:\\.|[^"\\])*"/g, value => { literals.push(JSON.parse(value)); return `LITERAL_${literals.length - 1}`; });
    try {
    if (state.readError && !syntax.includes('mutation ')) throw Object.assign(new Error('Synthetic GraphQL read failure'), { status: state.readError });
    if (syntax.includes('addPullRequestReview(input:')) {
      const pr = [...state.prs.values()].find(pr => pr.node_id === args.prId);
      const databaseId = ++id;
      const review = { id: `REVIEW_${databaseId}`, databaseId, key: `${pr.repository}#${pr.number}`, user: { login: state.viewer },
        state: 'PENDING', body: args.body ?? '', commit_id: args.commitOID, comments: [], created_at: new Date().toISOString(), url: `${pr.html_url}#review-${databaseId}`, html_url: `${pr.html_url}#review-${databaseId}` };
      state.reviews.set(review.id, review);
      state.calls.push({ operation: 'create', reviewId: review.id });
      return { addPullRequestReview: { pullRequestReview: graphReview(review) } };
    }
    if (syntax.includes('addPullRequestReviewThread(input:')) {
      const review = state.reviews.get(args.reviewId);
      const data = {};
      for (const match of syntax.matchAll(/(comment\d+):\s*addPullRequestReviewThread\(input:\s*\{([\s\S]*?)\}\)/g)) {
        const fields = match[2];
        const text = name => literals[Number(fields.match(new RegExp(`\\b${name}:\\s*LITERAL_(\\d+)`))?.[1])];
        const numeric = name => Number(fields.match(new RegExp(`\\b${name}:\\s*(\\d+)`))?.[1]) || null;
        const comment = { id: ++id, pull_request_review_id: review.databaseId, path: text('path'), body: text('body'),
          line: numeric('line'), start_line: numeric('startLine'), side: fields.match(/\bside:\s*(LEFT|RIGHT)/)?.[1] || null,
          start_side: fields.match(/\bstartSide:\s*(LEFT|RIGHT)/)?.[1] || null,
          subject_type: fields.includes('subjectType: FILE') ? 'file' : 'line', commit_id: review.commit_id, html_url: `${review.url}-comment-${id}` };
        review.comments.push(comment);
        state.calls.push({ operation: 'comment', reviewId: review.id, comment: copy(comment) });
        data[match[1]] = { thread: { id: `THREAD_${id}`, comments: { nodes: [graphComment(comment)] } } };
        if (state.partialAfter != null && --state.partialAfter === 0) {
          state.partialAfter = null;
          throw Object.assign(new Error('Synthetic partial GraphQL mutation'), { data, errors: [{ message: 'Later aliases failed', path: ['comment1'] }] });
        }
      }
      return data;
    }
    if (syntax.includes('submitPullRequestReview(input:')) {
      const review = state.reviews.get(args.reviewId);
      review.state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[args.event];
      review.body = args.body || '';
      review.submitted_at = new Date().toISOString();
      state.calls.push({ operation: 'submit', reviewId: review.id, event: args.event, body: review.body });
      if (state.failAfterSubmit) { state.failAfterSubmit = false; throw new Error('Synthetic response lost after publication'); }
      return { submitPullRequestReview: { pullRequestReview: graphReview(review) } };
    }
    if (syntax.includes('deletePullRequestReview(input:')) {
      state.calls.push({ operation: 'delete', reviewId: args.reviewId });
      state.reviews.delete(args.reviewId);
      return { deletePullRequestReview: { pullRequestReview: { id: args.reviewId } } };
    }
    if (args.nodeId) return { node: state.reviews.has(args.nodeId) ? graphReview(state.reviews.get(args.nodeId)) : null };
    const pr = state.prs.get(key(args));
    if (syntax.includes('reviewThreads(')) return { repository: { pullRequest: {
      reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', reviewThreads: { nodes: [
        { id: 'discussion-1', isResolved: false, isOutdated: false, comments: { nodes: [{ url: `${pr.html_url}#discussion-1`, author: { login: 'maintainer' } }] } }
      ], pageInfo: { hasNextPage: false } }
    } } };
    if (syntax.includes('reviews(states: PENDING')) return { repository: { pullRequest: { reviews: {
      nodes: [...state.reviews.values()].filter(review => review.key === key(args) && review.state === 'PENDING').map(graphReview),
      pageInfo: { hasNextPage: false, endCursor: null }
    } } } };
    if (syntax.includes('viewer')) return { viewer: { login: state.viewer } };
    throw new Error('Unimplemented fixture GitHub query');
    } finally { if (syntax.includes('mutation')) persistHost(); }
  }
};
for (const [resource, methods] of Object.entries(octokit.rest)) {
  for (const [name, method] of Object.entries(methods)) {
    methods[name] = async (args = {}) => {
      const call = { operation: `${resource}.${name}`, key: args.owner ? key(args) : null, page: args.page || 1,
        perPage: args.per_page || 30, diff: args.mediaType?.format === 'diff', startedAt: performance.now() };
      readCalls.push(call);
      maxConcurrentReads = Math.max(maxConcurrentReads, ++activeReads);
      try {
        const result = await method(args);
        const collection = Array.isArray(result.data) ? null
          : ['items', 'check_runs'].find(field => Array.isArray(result.data?.[field]));
        const values = collection ? result.data[collection] : result.data;
        if (Array.isArray(values)) {
          const start = (call.page - 1) * call.perPage;
          const page = values.slice(start, start + call.perPage);
          result.data = collection ? { ...result.data, [collection]: page, total_count: values.length } : page;
          if (start + page.length < values.length) result.headers.link = '<https://example.invalid/next>; rel="next"';
          call.items = page.length;
        }
        return result;
      } finally {
        call.durationMs = performance.now() - call.startedAt;
        activeReads--;
      }
    };
  }
}
const graphql = octokit.graphql;
octokit.graphql = async (source, args) => {
  if (!/\bmutation\b/.test(source)) readCalls.push({ operation: 'graphql', startedAt: performance.now() });
  return graphql(source, args);
};
GitHubClient.prototype._buildOctokit = () => octokit;
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z' };
const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], { env: gitEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function main() {
  fs.mkdirSync(path.join(home, '.pair-review'), { recursive: true });
  const resume = fs.existsSync(path.join(home, '.pair-review', 'workspace.db'));
  const repoPath = path.join(home, 'repository');
  const worktreePath = path.join(home, 'worktree');
  const localPath = path.join(home, 'local worktree');
  const policy = path.join(home, 'review-policy.md');
  if (!resume) {
    fs.mkdirSync(repoPath);
    execFileSync('git', ['init', '-q', '--initial-branch=main', repoPath], { env: gitEnv });
    git(repoPath, ['config', 'user.email', 'fixture@example.invalid']);
    git(repoPath, ['config', 'user.name', 'Review Fixture']);
    git(repoPath, ['config', 'core.hooksPath', '/dev/null']);
    git(repoPath, ['remote', 'add', 'origin', repoPath]);
    const lines = Array.from({ length: lineCount }, (_, index) => `const value${index + 1} = ${index};`);
    for (const file of files) fs.writeFileSync(path.join(repoPath, file), lines.join('\n') + '\n');
    git(repoPath, ['add', '.']); git(repoPath, ['commit', '-qm', 'Fixture base']);
    git(repoPath, ['checkout', '-qb', 'review-head']);
    for (const index of changedLines) lines[index] = `const value${index + 1} = ${index + 100};`;
    for (const file of files) fs.writeFileSync(path.join(repoPath, file), lines.join('\n') + '\n');
    git(repoPath, ['add', '.']); git(repoPath, ['commit', '-qm', 'Fixture head']);
    const head = git(repoPath, ['rev-parse', 'HEAD']);
    git(repoPath, ['checkout', '-q', 'main']);
    git(repoPath, ['worktree', 'add', '--quiet', '--detach', worktreePath, head]);
    git(repoPath, ['worktree', 'add', '--quiet', '--detach', localPath, head]);
    fs.appendFileSync(path.join(localPath, 'sample.js'), 'const localOnly = true;\n');
    fs.writeFileSync(policy, '# Fixture policy\n\n## Review comments\nDescribe the specific defect and evidence. Do not post or modify files.\n');
    fs.writeFileSync(path.join(home, '.pair-review', 'config.json'), JSON.stringify({ port, single_port: true, dev_mode: true,
      default_provider: 'omp', default_model: 'default', comment_format: 'plain', external_comments: true, enable_chat: false,
      instruction_files: [{ path: policy, sections: ['Review comments'] }],
      repos: { 'example/alpha': { path: repoPath }, 'example/beta': { path: repoPath } }
    }));
  }
  const configPath = path.join(home, '.pair-review', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.db_name !== 'workspace.db' || config.port !== port) {
    fs.writeFileSync(configPath, JSON.stringify({ ...config, db_name: 'workspace.db', port }));
  }
  const baseSha = git(repoPath, ['rev-parse', 'main']);
  const headSha = git(repoPath, ['rev-parse', 'review-head']);
  const db = await initializeDatabase('workspace.db');
  if (!resume) {
    const repo = new ReviewRepository(db);
    const comments = new CommentRepository(db);
    const diff = git(repoPath, ['diff', '--no-ext-diff', '--no-color', '--unified=3', `${baseSha}...${headSha}`]) + '\n';
    const total = Number(process.env.WORKSPACE_TEST_REVIEW_COUNT || 4);
    for (let index = 0; index < total; index++) {
      const repository = index === 1 ? 'example/beta' : 'example/alpha';
      const number = index < 2 ? 42 : 41 + index;
      const now = new Date(fixtureNow - index * 1000).toISOString();
      git(repoPath, ['update-ref', `refs/pull/${number}/head`, headSha]);
      const pr = { repository, number, node_id: `PR_${index}`, title: `Preserve request state ${index + 1}`, body: 'Synthetic fixture only.',
        user: { login: index === 1 ? 'reviewer' : 'contributor' }, state: 'open', merged: false, draft: false,
        base: { ref: 'main', sha: baseSha, repo: { full_name: repository, clone_url: repoPath, default_branch: 'main' } },
        head: { ref: 'review-head', sha: headSha }, merge_commit_sha: null, mergeable: index === 2 ? null : true,
        html_url: `https://github.com/${repository}/pull/${number}`, created_at: now, updated_at: now, changed_files: files.length,
        additions: changedLines.length * files.length, deletions: changedLines.length * files.length,
        requests: { users: index === 0 ? [{ login: 'reviewer' }] : [], teams: index === 2 ? [{ id: 7, slug: 'maintainers' }] : [] } };
      state.prs.set(`${repository}#${number}`, pr);
      const opinions = index === 0 ? [['kim', 'APPROVED'], ['pat', 'APPROVED']]
        : index === 2 ? [['reviewer', 'APPROVED'], ['maintainer', 'CHANGES_REQUESTED']]
          : index === 3 ? [['reviewer', 'CHANGES_REQUESTED'], ['reviewer', 'COMMENTED'], ['maintainer', 'APPROVED']] : [];
      const history = index < 4 ? Array.from({ length: historyCount }, (_, i) => [`previous-reviewer-${i % 20}`, 'COMMENTED']) : [];
      for (const [login, decision] of [...history, ...opinions]) {
        const databaseId = ++id;
        state.reviews.set(`REVIEW_${databaseId}`, { id: `REVIEW_${databaseId}`, databaseId, key: `${repository}#${number}`,
          state: decision, user: { login }, submitted_at: new Date(databaseId * 1000).toISOString(),
          commit_id: baseSha, comments: [], html_url: `${pr.html_url}#review-${databaseId}` });
      }
      const data = { ...pr, author: pr.user.login, head_sha: headSha, base_sha: baseSha, base_branch: 'main', head_branch: 'review-head',
        ...(index < 2 ? { worktree_path: worktreePath, diff } : {}) };
      db.prepare('INSERT INTO pr_metadata(pr_number, repository, title, description, author, base_branch, head_branch, pr_data, last_accessed_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(number, repository, pr.title, pr.body, pr.user.login, 'main', 'review-head', JSON.stringify(data), now);
      const { id: reviewId } = await repo.createReview({ prNumber: number, repository, status: 'draft' });
      if (index < 2) await new WorktreeRepository(db).create({ prNumber: number, repository, branch: 'review-head', path: worktreePath, explicitId: `worktree-${index}` });
      if (index === 0) {
        await comments.createLineComment({ review_id: reviewId, file: 'sample.js', line_start: 2, line_end: 2, side: 'LEFT', commit_sha: headSha, body: 'Removing this guard changes the failure path.' });
        await comments.createLineComment({ review_id: reviewId, file: 'sample.js', line_start: 12, line_end: 14, side: 'RIGHT', commit_sha: headSha, body: 'These assignments no longer share the same value.' });
        await comments.createFileComment({ review_id: reviewId, file: 'sample.js', commit_sha: headSha, body: 'Keep the file-level invariant explicit.' });
      }
    }
    if (historyCount) {
      state.checkRuns = { [headSha]: [
        ...Array.from({ length: historyCount }, (_, index) => ({
          id: 100 + index, name: index % 2 ? 'build' : 'lint', app: { id: 1 }, status: 'completed',
          conclusion: index % 3 ? 'success' : 'failure', started_at: new Date(Date.UTC(2025, 0, 1) + index * 1000).toISOString(),
          details_url: `https://example.invalid/checks/history-${index}`
        })),
        { id: 100 + historyCount, name: 'build', app: { id: 1 }, status: 'completed', conclusion: 'failure', started_at: '2026-01-01', details_url: 'https://example.invalid/checks/build' },
        { id: 101 + historyCount, name: 'lint', app: { id: 1 }, status: 'in_progress', conclusion: null, started_at: '2026-01-02', details_url: 'https://example.invalid/checks/lint' }
      ] };
    }
    persistHost();
  } else if (!state.prs.size) {
    for (const row of db.prepare('SELECT pr_number, repository, pr_data FROM pr_metadata').all()) {
      state.prs.set(`${row.repository}#${row.pr_number}`, JSON.parse(row.pr_data));
    }
    persistHost();
  }
  require(path.join(appRoot, 'src/ai')).checkAllProviders = async () => {};
  const chatProviders = require(path.join(appRoot, 'src/chat/chat-providers'));
  const checkChatProviders = chatProviders.checkAllChatProviders;
  const chatCommands = new Set(Object.values(config.chat_providers || {}).map(provider => provider.command).filter(Boolean));
  chatProviders.checkAllChatProviders = () => checkChatProviders({
    spawn: (command, args, options) => chatCommands.has(command)
      ? spawn(command, args, options)
      : spawn(path.join(home, 'unavailable-chat-provider'), [], { ...options, shell: false })
  });
  const { startServer } = require(path.join(appRoot, 'src/server'));
  await startServer(db);
  let localReview = null;
  if (fs.existsSync(localPath)) {
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/local/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: localPath })
    });
    localReview = await response.json();
    if (!response.ok) throw new Error(`Local fixture bootstrap failed: ${JSON.stringify(localReview)}`);
  }
  const activityColumn = db.prepare('PRAGMA table_info(analysis_runs)').all().some(column => column.name === 'activity_state')
    ? 'activity_state' : 'NULL AS activity_state';
  const admin = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port + 1}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const changes = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (request.method === 'POST' && url.pathname === '/control') {
      if (changes.resetReadCalls) { readCalls.length = 0; maxConcurrentReads = activeReads; }
      for (const field of ['readError', 'partialAfter', 'failAfterSubmit', 'viewer', 'foreignCommentOnIdentity', 'checkRuns', 'commitStatuses']) if (Object.hasOwn(changes, field)) state[field] = changes[field];
      if (changes.providerResult) fs.writeFileSync(process.env.WORKSPACE_PROVIDER_GATE, JSON.stringify(changes.providerResult));
      if (changes.pr) Object.assign(state.prs.get(changes.key || 'example/alpha#42'), changes.pr);
      if (changes.policy) fs.writeFileSync(policy, changes.policy);
      if (changes.importResult) await new AnalysisRunRepository(db).create({ id: changes.importResult, reviewId: 1, provider: 'fixture-import', model: 'not-executed', status: 'completed', totalSuggestions: 0 });
      persistHost();
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ calls: state.calls, readCalls, maxConcurrentReads, reviews: [...state.reviews.values()], home, providerGate: process.env.WORKSPACE_PROVIDER_GATE,
      analysis: db.prepare(`SELECT id, status, ${activityColumn} FROM analysis_runs`).all(),
      comments: db.prepare("SELECT id, review_id, source, status, file, side, line_start, line_end, body FROM comments WHERE source = 'user'").all() }));
  });
  await new Promise(resolve => admin.listen(port + 1, '127.0.0.1', resolve));
  console.log(JSON.stringify({ fixtureReady: true, port, adminPort: port + 1, home, pid: process.pid, localReview }));
}
if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });
