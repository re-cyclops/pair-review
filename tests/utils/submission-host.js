// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const http = require('node:http');
const { once } = require('node:events');

// A disposable HTTP boundary: real Octokit, capability dispatchers and publisher
// run against this host. Failure controls take effect after persisting effects.
async function createSubmissionHost(options = {}) {
  const repository = options.repository || 'owner/repo';
  const number = options.number || 1;
  const pullPath = `/repos/${repository}/pulls/${number}`;
  const state = { head: options.head || 'a'.repeat(40), base: options.base || 'b'.repeat(40), viewer: { id: 7, login: 'reviewer' },
    author: 'author', reviews: new Map(), calls: [], batches: 0, nextId: 10,
    loseCreate: false, loseBatch: null, partialBatch: null, loseSubmit: false, rejectBatch: null };
  if (options.author) state.author = options.author;
  const diff = options.diff || ['a.js', 'hidden.js'].map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,30 +1,30 @@\n${Array.from({ length: 30 }, (_, i) => ` line${i + 1}`).join('\n')}\n`).join('');
  let baseUrl;
  const server = http.createServer(async (req, res) => {
    const respond = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.url === '/user') return respond(state.viewer);
      if (pathname === pullPath) {
        if (req.headers.accept?.includes('.diff')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(diff); }
        await state.beforePullRead?.();
        return respond({ ...options.pr, number, node_id: 'PR_1', user: { login: state.author }, state: 'open', merged: false,
          head: { sha: state.head, ref: options.pr?.head_branch || 'feature' }, base: { sha: state.base, ref: options.pr?.base_branch || 'main', repo: { full_name: repository } },
          html_url: `${baseUrl}/${repository}/pull/${number}` });
      }
      if (pathname === `${pullPath}/reviews` && req.method === 'GET') return respond([...state.reviews.values()].map(restReview));
      const reviewMatch = pathname.startsWith(`${pullPath}/reviews/`)
        ? pathname.slice(`${pullPath}/reviews`.length).match(/^\/(\d+)(\/comments|\/events)?$/) : null;
      if (reviewMatch && req.method === 'GET') {
        const review = [...state.reviews.values()].find(value => value.databaseId === Number(reviewMatch[1]));
        if (!review) return respond({ message: 'Not found' }, 404);
        return respond(reviewMatch[2] === '/comments' ? review.comments.map(comment => ({ ...comment, node_id: comment.id, id: comment.databaseId,
          start_line: comment.startLine, subject_type: comment.subjectType.toLowerCase() }))
          : restReview(review));
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const data = raw ? JSON.parse(raw) : {};
      if (pathname === `${pullPath}/reviews` && req.method === 'POST') {
        const review = createReview(data.body, data.commit_id);
        if (state.loseCreate) return req.socket.destroy();
        return respond(restReview(review));
      }
      if (reviewMatch && req.method === 'POST') {
        const review = [...state.reviews.values()].find(value => value.databaseId === Number(reviewMatch[1]));
        if (reviewMatch[2] === '/events') {
          submit(review, data.event, data.body);
          if (state.loseSubmit) return req.socket.destroy();
          return respond(restReview(review));
        }
        state.batches++;
        if (state.rejectBatch === state.batches) return respond({ added: 0, failed: data.comments.map((_comment, index) => ({ index, error_message: 'Temporarily rejected' })) });
        for (const comment of data.comments) addComment(review, { ...comment, startLine: comment.start_line, subjectType: comment.subject_type.toUpperCase() });
        if (state.loseBatch === state.batches) return req.socket.destroy();
        return respond({ added: data.comments.length, failed: [] });
      }
      if (req.url !== '/graphql') return respond({ message: `Unexpected fixture path ${req.url}` }, 404);
      const source = data.query;
      const args = data.variables || {};
      const literals = [];
      const masked = source.replace(/"(?:\\.|[^"\\])*"/g, value => { literals.push(JSON.parse(value)); return `LITERAL_${literals.length - 1}`; });
      if (masked.includes('addPullRequestReview(input:')) {
        const review = createReview(args.body, args.commitOID);
        if (state.loseCreate) return req.socket.destroy();
        return respond({ data: { addPullRequestReview: { pullRequestReview: graphReview(review) } } });
      }
      if (masked.includes('addPullRequestReviewThread(input:')) {
        const review = state.reviews.get(args.reviewId);
        state.batches++;
        const result = {};
        for (const match of masked.matchAll(/(comment\d+):\s*addPullRequestReviewThread\(input:\s*\{([\s\S]*?)\}\)/g)) {
          const fields = match[2];
          const text = name => literals[Number(fields.match(new RegExp(`\\b${name}:\\s*LITERAL_(\\d+)`))?.[1])];
          const numeric = name => Number(fields.match(new RegExp(`\\b${name}:\\s*(\\d+)`))?.[1]) || null;
          const comment = addComment(review, { body: text('body'), path: text('path'), line: numeric('line'), startLine: numeric('startLine'),
            side: fields.match(/\bside:\s*(LEFT|RIGHT)/)?.[1] || null, subjectType: fields.includes('subjectType: FILE') ? 'FILE' : 'LINE' });
          result[match[1]] = { thread: { id: `THREAD_${comment.databaseId}`, comments: { nodes: [comment] } } };
          if (state.partialBatch === state.batches) return respond({ data: result, errors: [{ message: 'Resolver response interrupted', path: ['comment1'] }] });
        }
        if (state.loseBatch === state.batches) return req.socket.destroy();
        return respond({ data: result });
      }
      if (masked.includes('submitPullRequestReview(input:')) {
        const review = state.reviews.get(args.reviewId);
        submit(review, args.event, args.body);
        if (state.loseSubmit) return req.socket.destroy();
        return respond({ data: { submitPullRequestReview: { pullRequestReview: graphReview(review) } } });
      }
      if (args.nodeId) return respond({ data: { node: state.reviews.has(args.nodeId) ? graphReview(state.reviews.get(args.nodeId)) : null } });
      if (masked.includes('reviews(states: PENDING')) return respond({ data: { repository: { pullRequest: { reviews: {
        nodes: [...state.reviews.values()].filter(review => review.state === 'PENDING').map(graphReview), pageInfo: { hasNextPage: false }
      } } } } });
      return respond({ errors: [{ message: 'Unsupported fixture operation' }] }, 400);
    } catch (error) { respond({ message: error.message }, 500); }
  });
  const graphReview = review => ({ ...review, viewerDidAuthor: review.user.login === state.viewer.login,
    author: { login: review.user.login }, commit: { oid: review.head }, repository: { nameWithOwner: repository }, pullRequest: { number },
    comments: { totalCount: review.comments.length, nodes: review.comments, pageInfo: { hasNextPage: false } } });
  const restReview = review => ({ id: review.databaseId, node_id: state.omitNodeIds ? undefined : review.id,
    body: review.body, state: review.state, commit_id: review.head, user: review.user, html_url: review.url });
  const createReview = (body, head) => {
    const id = ++state.nextId;
    const review = { id: `REVIEW_${id}`, databaseId: id, state: 'PENDING', body: body ?? '', head,
      user: { ...state.viewer }, url: `${baseUrl}/${repository}/pull/${number}#review-${id}`, comments: [] };
    state.reviews.set(review.id, review);
    state.calls.push({ operation: 'create', id: review.id, head, body: review.body });
    return review;
  };
  const addComment = (review, fields) => {
    const id = ++state.nextId;
    const comment = { ...fields, id: `COMMENT_${id}`, databaseId: id };
    review.comments.push(comment);
    state.calls.push({ operation: 'comment', reviewId: review.id, comment });
    return comment;
  };
  const submit = (review, event, body) => {
    review.state = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[event];
    review.body = body;
    state.calls.push({ operation: 'submit', reviewId: review.id, event, body });
  };
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { state, baseUrl, createReview, addComment, async close() {
    const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped;
  } };
}
module.exports = { createSubmissionHost };
