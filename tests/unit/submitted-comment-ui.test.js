// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

window.reviewModal = {}; // Prevent automatic browser startup from opening authoring.
const { PRManager } = require('../../public/js/pr.js');
const { CommentManager } = require('../../public/js/modules/comment-manager.js');
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');
const PierreBridge = require('../../public/js/modules/pierre-bridge.js');
const { AIPanel } = require('../../public/js/components/AIPanel.js');
const { getPostedCommentIcon, shouldHidePostedComment } = require('../../public/js/utils/posted-comment.js');
const PostedComment = require('../../public/js/utils/posted-comment.js');

let comments, fetchMock;

beforeEach(() => {
  localStorage.clear();
  PostedComment.setShowPostedOverride(null);
  document.body.innerHTML = `
    <button id="review-button"><span class="review-button-text"></span></button>
    <button id="clear-comments-btn"></button>
    <div id="diff"><table><tbody><tr data-line="10"></tr><tr data-line="11"></tr></tbody></table></div>
    <div class="file-comments-zone"><div class="file-comments-container"></div></div>`;
  window.aiPanel = { setComments: vi.fn(), updateFindingStatus: vi.fn() };
  window.toast = { showSuccess: vi.fn(), showWarning: vi.fn(), showError: vi.fn() };
  window.CommentManager = CommentManager;
  window.PostedComment = PostedComment;
  window.getPostedCommentIcon = getPostedCommentIcon;
  window.shouldHidePostedComment = shouldHidePostedComment;
  window.escapeHtmlAttribute = PostedComment.escapeHtml;
  comments = [
    { id: 1, status: 'active', file: 'src/a.js', line_start: 10, body: 'New line' },
    { id: 2, status: 'active', publication: { state: 'posted' }, file: 'src/a.js', line_start: 11, body: 'Old line' },
    { id: 3, status: 'active', is_file_level: 1, file: 'src/b.js', body: 'New file' },
    { id: 4, status: 'active', publication: { state: 'posted' }, is_file_level: 1, file: 'src/b.js', body: 'Old file' },
    { id: 5, status: 'active', publication: { state: 'draft' }, is_file_level: 1, file: 'src/b.js', body: 'Saved draft' },
  ];
  fetchMock = vi.fn(async url => {
    if (url === '/api/reviews/42/comments' || url === '/api/reviews/42/comments?includeDismissed=true') {
      return { ok: true, json: async () => ({ comments }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeManager() {
  const manager = Object.create(PRManager.prototype);
  manager.currentPR = { id: 42, owner: 'acme', repo: 'widget', number: 7 };
  manager.ensureLinesVisible = vi.fn();
  manager.findFileElement = () => document.querySelector('#diff');
  manager.getLineNumber = row => Number(row.dataset.line);
  manager.commentManager = new CommentManager(manager);
  manager.commentManager.isLineInDiffHunk = () => true;
  manager.fileCommentManager = new FileCommentManager(manager);
  manager.fileCommentManager.findZoneForFile = () => document.querySelector('.file-comments-zone');
  manager.splitButton = { updateCommentCount: vi.fn() };
  manager.updatePendingDraftIndicator = vi.fn();
  window.prManager = manager;
  return manager;
}


describe('posted comment UI', () => {
  it('shows posted line/file comments with icons by default, counting only active data', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    expect(document.querySelectorAll('.user-comment-row')).toHaveLength(2);
    expect(document.querySelectorAll('.file-comment-card')).toHaveLength(3);
    expect(document.querySelectorAll('.posted-comment-icon[title="Posted comment"]')).toHaveLength(2);
    expect(document.querySelectorAll('.posted-comment-icon[title="In pending draft review"]')).toHaveLength(1);
    expect(manager.getPendingCommentCount()).toBe(2);
    expect(window.aiPanel.setComments.mock.lastCall[0]).toHaveLength(5);
    const panel = Object.create(AIPanel.prototype);
    expect(panel.renderCommentItem(comments[1], 0)).toContain('title="Posted comment"');
    expect(panel.renderCommentItem(comments[0], 0)).not.toContain('posted-comment-icon');

  });


  it('refreshes file-comment header state and minimize indicators when hiding posted comments', async () => {
    comments = comments.filter(c => c.id === 4); // one submitted file-level comment
    const manager = makeManager();
    manager.commentMinimizer = { refreshIndicators: vi.fn() };
    const zone = document.querySelector('.file-comments-zone');
    zone.headerButton = document.createElement('button');
    await manager.loadUserComments();
    expect(zone.headerButton.classList.contains('has-comments')).toBe(true);
    const refreshesAfterLoad = manager.commentMinimizer.refreshIndicators.mock.calls.length;

    localStorage.setItem('pair-review-hide-posted-comments', 'true');
    manager.applyPostedCommentVisibility();
    expect(zone.headerButton.classList.contains('has-comments')).toBe(false);
    expect(manager.commentMinimizer.refreshIndicators.mock.calls.length).toBe(refreshesAfterLoad + 1);

    localStorage.setItem('pair-review-hide-posted-comments', 'false');
    manager.applyPostedCommentVisibility();
    expect(zone.headerButton.classList.contains('has-comments')).toBe(true);
    expect(manager.commentMinimizer.refreshIndicators.mock.calls.length).toBe(refreshesAfterLoad + 2);
  });

  it('keeps the latest preference when toggled while comments are loading', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    let release;
    manager.ensureLinesVisible.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const loading = manager.loadUserComments();
    await vi.waitFor(() => expect(manager.ensureLinesVisible).toHaveBeenCalledTimes(2));
    localStorage.setItem('pair-review-hide-posted-comments', 'true');
    manager.applyPostedCommentVisibility();
    release();
    await loading;
    expect(document.querySelectorAll('.user-comment-row')).toHaveLength(2);
    expect(document.querySelectorAll('.user-comment-row:not(.posted-comment-hidden)')).toHaveLength(1);
    expect(document.querySelectorAll('.file-comment-card:not(.posted-comment-hidden)')).toHaveLength(2);
    expect(localStorage.getItem('pair-review-hide-posted-comments')).toBe('true');
  });


  it('passes posted comments to Pierre annotations unless submitted comments are hidden', async () => {
    const manager = makeManager();
    const bridge = Object.create(PierreBridge.prototype);
    const annotations = document.createElement('div');
    document.body.appendChild(annotations);
    manager.pierreBridge = {
      files: new Map([['src/a.js', {}]]),
      removeAnnotationsByType: () => annotations.replaceChildren(),
      addAnnotations: (_file, items) => items.forEach(item => annotations.appendChild(bridge._renderCommentAnnotation(item.data, item.id))),
    };
    await manager.loadUserComments();
    expect(annotations.querySelectorAll('.user-comment-row')).toHaveLength(2);
    expect(annotations.querySelectorAll('.posted-comment-icon')).toHaveLength(1);
    localStorage.setItem('pair-review-hide-posted-comments', 'true');
    manager.applyPostedCommentVisibility();
    expect(annotations.querySelectorAll('.user-comment-row:not(.posted-comment-hidden)')).toHaveLength(1);
    expect(annotations.querySelectorAll('.user-comment-row:not(.posted-comment-hidden) .posted-comment-icon')).toHaveLength(0);
    // Pierre recreates annotation containers when suggestions or forms change.
    annotations.replaceChildren(bridge._renderCommentAnnotation(comments[1], 'comment-2'));
    expect(annotations.querySelector('.user-comment-row').classList.contains('posted-comment-hidden')).toBe(true);
  });


  it('keeps an acknowledged posted edit while a stale reload waits on the diff', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    let release;
    manager.ensureLinesVisible.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const reload = manager.loadUserComments();
    await vi.waitFor(() => expect(manager.ensureLinesVisible).toHaveBeenCalledTimes(2));

    comments = comments.map(comment => comment.id === 2
      ? { ...comment, body: 'Updated on the host', publication: { state: 'posted', changed: false } }
      : comment);
    manager.applyServerComment(comments.find(comment => comment.id === 2));
    release();
    await reload;

    expect(document.querySelector('[data-comment-id="2"] .user-comment-body').textContent).toBe('Updated on the host');
    expect(manager.getPendingCommentCount()).toBe(2);
  });

  it('lets the newest reload win when two overlap', async () => {
    const manager = makeManager();
    let release;
    manager.ensureLinesVisible.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const first = manager.loadUserComments();
    await vi.waitFor(() => expect(manager.ensureLinesVisible).toHaveBeenCalledTimes(1));
    comments = comments.filter(c => c.id !== 1);
    const second = manager.loadUserComments();
    expect(await second).toBe(true);
    release();
    expect(await first).toBe(true);
    // The overtaken load did not render its stale list over the newer one
    expect(document.querySelector('.user-comment-row[data-comment-id="1"]')).toBeNull();
    expect(manager.userComments.map(c => c.id)).not.toContain(1);
  });

  it('does not resurrect dismissed panel comments when the preference changes', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await manager.deleteUserComment(1);
    manager.applyPostedCommentVisibility();
    expect(window.aiPanel.setComments.mock.lastCall[0].map(c => c.id)).not.toContain(1);
    window.aiPanel.showDismissedComments = true;
    manager.applyPostedCommentVisibility();
    expect(window.aiPanel.setComments.mock.lastCall[0].find(c => c.id === 1).status).toBe('inactive');
  });

  it('does not render inactive comments or count them as pending', async () => {
    comments = [{ id: 8, status: 'inactive', file: 'src/a.js', line_start: 10, body: 'Dismissed' }];
    const manager = makeManager();
    await manager.loadUserComments();
    expect(document.querySelectorAll('.user-comment-row, .file-comment-card')).toHaveLength(0);
    expect(manager.getPendingCommentCount()).toBe(0);
  });

});
