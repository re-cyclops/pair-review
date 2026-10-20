// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import BulkAnalysisLauncher from '../../public/js/components/BulkAnalysisLauncher.js';

const config = { provider: 'claude', model: 'sonnet-4.6', customInstructions: 'Check boundaries', enabledLevels: [1, 2], excludePrevious: true };
const pr = (number = 1, host) => ({ owner: 'team', repo: 'repo', number, host, url: `/pr/team/repo/${number}` });
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let workspace, launcher, calls, fetchMock, handlers;
const activity = runs => window.dispatchEvent(new CustomEvent('workspaceActivity', { detail: { runs, available: true } }));
const run = (overrides = {}) => ({ analysisId: 'run-1', reviewId: 10, reviewType: 'pr', repository: 'team/repo', prNumber: 1, host: null, status: 'running', stage: 'Reviewing files', observation: 'live', ...overrides });

beforeEach(() => {
  document.body.innerHTML = '<section id="recent-reviews-section"><div class="section-header"></div></section>';
  workspace = { runs: new Map(), available: true, refresh: vi.fn(), loadReviews: vi.fn(), showActivity: vi.fn() };
  handlers = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, handler, options) => { handlers.push([type, handler]); add(type, handler, options); });
  launcher = new BulkAnalysisLauncher(workspace);
  calls = [];
  fetchMock = vi.fn(async (url, options) => {
    calls.push({ url, body: options.body && JSON.parse(options.body) });
    if (url.startsWith('/api/setup/pr/')) return reply({ existing: true });
    if (url.endsWith('/check-stale')) return reply({ isStale: false });
    if (url.includes('/analyses')) return reply({ analysisId: 'run-1' });
    throw new Error(`Unexpected endpoint ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  for (const [type, handler] of handlers) window.removeEventListener(type, handler);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inbox direct bulk analysis', () => {
  it('shows all queued targets immediately and prepares a new PR without opening a tab', async () => {
    const setup = deferred();
    fetchMock.mockImplementationOnce(() => setup.promise);
    const operation = launcher.start([pr(), pr(2)], config);
    expect(document.querySelectorAll('.workspace-bulk-analysis li')).toHaveLength(2);
    expect(launcher.state(pr()).status).toBe('preparing');
    expect(launcher.state(pr(2)).status).toBe('queued');
    expect(document.querySelector('[role="status"]').textContent).toContain('Keep this page open');
    setup.resolve(reply({ setupId: 'setup-new' }));
    fetchMock.mockImplementationOnce(async url => { expect(url).toBe('/api/setup/setup-new/status'); return reply({ status: 'complete' }); });
    await operation;
    expect(calls.filter(call => call.url.endsWith('/analyses'))).toHaveLength(2);
    expect(calls.every(call => !call.url.includes('bulk-open'))).toBe(true);
    expect(launcher.state(pr()).status).toBe('accepted');
    expect(workspace.refresh).toHaveBeenCalled();
  });

  it('preserves enterprise setup identity and selected unsaved council configuration', async () => {
    const councilConfig = { voices: [{ provider: 'codex', model: 'gpt-5' }] };
    await launcher.start([pr(1, 'git.example')], { isCouncil: true, configType: 'council', councilConfig, customInstructions: 'Security', excludePrevious: true });
    expect(calls[0]).toEqual({ url: '/api/setup/pr/team/repo/1', body: { host: 'git.example' } });
    expect(calls[1]).toEqual({ url: '/api/pr/team/repo/1/analyses/council', body: { councilConfig, configType: 'council', customInstructions: 'Security', excludePrevious: true } });
  });

  it('retains partial failure reasons while later targets still dispatch', async () => {
    fetchMock.mockImplementationOnce(async () => reply({ error: 'Checkout is in use by another review' }, 409));
    await launcher.start([pr(), pr(2)], config);
    expect(launcher.state(pr()).status).toBe('failed');
    expect(launcher.state(pr(2)).status).toBe('accepted');
    expect(document.querySelector('.workspace-bulk-analysis').textContent).toContain('Checkout is in use');
    expect(calls.some(call => call.url === '/api/pr/team/repo/1/analyses')).toBe(false);
  });

  it('does not regress terminal activity received before the launch response', async () => {
    const launch = deferred();
    fetchMock.mockImplementationOnce(async () => reply({ existing: true })).mockImplementationOnce(() => launch.promise);
    const operation = launcher.start([pr()], config);
    await vi.waitFor(() => expect(launcher.state(pr()).status).toBe('launching'));
    activity([run({ status: 'completed', stage: 'Complete' })]);
    launch.resolve(reply({ analysisId: 'run-1' }));
    await operation;
    expect(launcher.state(pr()).status).toBe('completed');
    expect(document.querySelector('.workspace-bulk-analysis').textContent).toContain('completed · Complete');
    document.querySelector('.workspace-bulk-analysis button').click();
    expect(workspace.showActivity).toHaveBeenCalledOnce();
  });

  it('follows accepted run progress and failure without claiming completion', async () => {
    await launcher.start([pr()], config);
    activity([run()]);
    expect(document.querySelector('.workspace-bulk-analysis').textContent).toContain('Reviewing files');
    activity([run({ status: 'failed', stage: 'Provider exited', error: 'Authentication required' })]);
    expect(launcher.state(pr()).status).toBe('failed');
    expect(document.querySelector('.workspace-bulk-analysis').textContent).toContain('Authentication required');
  });

  it('guards repeated clicks, duplicate selection and an already active target', async () => {
    const setup = deferred();
    fetchMock.mockImplementationOnce(() => setup.promise);
    const operation = launcher.start([pr(), pr()], config);
    await launcher.start([pr()], config);
    setup.resolve(reply({ existing: true }));
    await operation;
    await launcher.start([pr()], config);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    workspace.runs.set('run-2', run({ analysisId: 'run-2', prNumber: 2 }));
    await launcher.start([pr(2)], config);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses local preflight and local council launch without PR setup', async () => {
    const target = { local: true, reviewId: 42, url: '/local/42' };
    await launcher.start([target], { isCouncil: true, councilId: 'saved', configType: 'advanced' });
    expect(calls.map(call => call.url)).toEqual(['/api/local/42/check-stale', '/api/local/42/analyses/council']);
    expect(calls[1].body.councilId).toBe('saved');
    activity([run({ reviewType: 'local', reviewId: 42, status: 'completed' })]);
    expect(launcher.state(target).status).toBe('completed');
  });

  it('retains stale local sessions for an explicit refresh or Analyze Anyway decision', async () => {
    fetchMock.mockImplementationOnce(async () => reply({ isStale: true }));
    const target = { local: true, reviewId: 42, url: '/local/42' };
    await launcher.start([target], config);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(launcher.state(target).status).toBe('failed');
    expect(document.querySelector('.workspace-bulk-analysis').textContent).toContain('Analyze Anyway');
  });

  it('does not report acceptance or blindly relaunch when an analysis ID is missing', async () => {
    fetchMock.mockImplementationOnce(async () => reply({ existing: true })).mockImplementationOnce(async () => reply({ success: true }));
    await launcher.start([pr()], config);
    expect(launcher.state(pr()).status).toBe('uncertain');
    await launcher.start([pr()], config);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops unsubmitted targets and ignores stale callbacks after server context changes', async () => {
    const setup = deferred();
    fetchMock.mockImplementationOnce(() => setup.promise);
    const operation = launcher.start([pr(), pr(2)], config);
    window.dispatchEvent(new CustomEvent('workspaceContextChanged'));
    setup.resolve(reply({ existing: true }));
    await operation;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(launcher.targets.size).toBe(0);
    expect(document.querySelector('.workspace-bulk-analysis')).toBeNull();
  });

  it('rejects a missing modal model instead of choosing a different paid default', async () => {
    await launcher.start([pr()], { provider: 'codex' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(launcher.state(pr()).message).toContain('Choose a provider and model');
  });
});

it.each([[undefined, {}], ['github', { host: null }], ['github.com', { host: null }], ['https://git.example/api', { host: 'https://git.example/api' }]])('preserves setup host semantics for %s', async (hostHint, body) => {
  await launcher.start([pr(1, hostHint)], config);
  expect(calls[0].body).toEqual(body);
});

it.each(['throw', 'reject'])('preserves confirmed acceptance when Workspace refresh fails (%s)', async failure => {
  workspace.refresh.mockImplementation(() => {
    if (failure === 'throw') throw new TypeError('Refresh UI unavailable');
    return Promise.reject(new TypeError('Refresh UI unavailable'));
  });
  await launcher.start([pr()], config);
  const target = launcher.state(pr());
  expect(target.analysisId).toBe('run-1');
  expect(target.status).toBe('accepted');
  expect(target.message).toContain('Accepted by server');
  expect(target.message).toContain('Could not refresh progress');
  expect(target.message).not.toContain('Launch outcome unknown');
  expect(target.message).not.toContain('Not launched');
  await launcher.start([pr()], config);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('preserves an acknowledged terminal run when post-acceptance refresh throws', async () => {
  activity([run({ status: 'completed', stage: 'Complete' })]);
  workspace.refresh.mockImplementation(() => { throw new Error('Activity refresh unavailable'); });
  await launcher.start([pr()], config);
  expect(launcher.state(pr()).analysisId).toBe('run-1');
  expect(launcher.state(pr()).status).toBe('completed');
  expect(launcher.state(pr()).message).toContain('completed · Complete');
  expect(launcher.state(pr()).message).not.toContain('Not launched');
});
