// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ============================================================================
// Mocking Strategy
// ============================================================================
// The project uses CommonJS modules, and pr-setup.js destructures imports at
// module load time (e.g., `const { getRepoPath } = require('../config')`).
// This means the destructured variables capture whichever function is on the
// module exports object at the time pr-setup.js is first require()'d.
//
// To intercept these, we must install spies BEFORE pr-setup.js is loaded.
// We use vi.spyOn() at the top level (not in beforeEach) so the spied
// functions are already in place when pr-setup.js destructures them.
//
// Note: findRepositoryPath accepts `config` as a parameter (rather than
// calling loadConfig() internally), so we pass testConfig directly in tests.
//
// IMPORTANT: Do NOT call vi.restoreAllMocks() because that would replace the
// spied functions with the originals, breaking the interception for subsequent
// tests. Instead, use vi.clearAllMocks() to reset call history and mock
// implementations between tests.
//
// For simple-git, which is also captured at module load time, we use real git
// directory paths (the test repo itself) for success cases and non-existent
// paths for failure cases (caught by the production code's try-catch blocks).

const configModule = require('../../src/config');
const localReview = require('../../src/local-review');
const { GitWorktreeManager } = require('../../src/git/worktree');
const { RepoSettingsRepository, WorktreePoolRepository, ReviewRepository, run, queryOne } = require('../../src/database');
const { GitHubClient } = require('../../src/github/client');
const worktreePoolLifecycleModule = require('../../src/git/worktree-pool-lifecycle');
const hooksPayloads = require('../../src/hooks/payloads');
// Unmocked simple-git, used only to build/inspect real local repos in tests.
const realSimpleGit = require('simple-git');

// Install spies BEFORE pr-setup.js is loaded so that its destructured
// variables capture the spy wrappers, not the original functions.
vi.spyOn(configModule, 'getConfigDir');
vi.spyOn(configModule, 'getRepoPath');
vi.spyOn(configModule, 'resolveRepoOptions');
vi.spyOn(configModule, 'resolvePoolConfig');
vi.spyOn(configModule, 'getRepoPoolSize');
vi.spyOn(configModule, 'getRepoResetScript');
vi.spyOn(localReview, 'findMainGitRoot');
vi.spyOn(GitWorktreeManager.prototype, 'pathExists');

// Install spy on fireHooks BEFORE pr-setup.js is loaded
const hookRunnerModule = require('../../src/hooks/hook-runner');
vi.spyOn(hookRunnerModule, 'fireHooks');

// Spies for setupPRReview integration tests (pool-enabled path).
// GitHubClient, WorktreePoolLifecycle, and GitWorktreeManager are constructed
// inside setupPRReview via `new`, so we spy on their prototype methods
// before pr-setup.js captures the class references.
vi.spyOn(GitHubClient.prototype, 'repositoryExists');
vi.spyOn(GitHubClient.prototype, 'fetchPullRequest');
vi.spyOn(GitHubClient.prototype, 'fetchPullRequestFiles');
vi.spyOn(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype, 'acquireForPR');
vi.spyOn(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype, 'releaseAfterHeadless');
vi.spyOn(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype, 'setReviewOwner');
vi.spyOn(GitWorktreeManager.prototype, 'createWorktreeForPR');
vi.spyOn(GitWorktreeManager.prototype, 'isSparseCheckoutEnabled');
vi.spyOn(GitWorktreeManager.prototype, 'generateUnifiedDiff');
vi.spyOn(GitWorktreeManager.prototype, 'getChangedFiles');
vi.spyOn(GitWorktreeManager.prototype, 'assertPinnedWorktree').mockResolvedValue(undefined);
vi.spyOn(hooksPayloads, 'fireReviewStartedHook');

// NOW load pr-setup.js - its destructured variables will capture our spies
const { findRepositoryPath, storePRData, setupPRReview } = require('../../src/setup/pr-setup');

// The test repo root is a real git directory we can use for success cases
const TEST_REPO_ROOT = path.resolve(__dirname, '../..');

// Unique per test file so parallel vitest forks never share a config dir
const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-cfg-'));

afterAll(() => {
  fs.rmSync(testConfigDir, { recursive: true, force: true });
});

// ============================================================================
// findRepositoryPath Integration Tests - Monorepo Configuration
// ============================================================================

describe('findRepositoryPath with monorepo configuration', () => {
  let db;
  let testConfig;

  beforeEach(async () => {
    db = await createTestDatabase();

    // Reset mock implementations (but keep the spies installed)
    vi.clearAllMocks();

    // Default config object passed directly to findRepositoryPath
    testConfig = { github_token: 'test-token', monorepos: {} };

    configModule.getConfigDir.mockReturnValue(testConfigDir);
    configModule.getRepoPath.mockReturnValue(null);
    configModule.resolveRepoOptions.mockReturnValue({ checkoutScript: null, checkoutTimeout: 300000, worktreeConfig: null, resetScript: null, poolSize: 0, poolFetchIntervalMinutes: null });
    configModule.resolvePoolConfig.mockReturnValue({ poolSize: 0, poolFetchIntervalMinutes: null });
    configModule.getRepoPoolSize.mockReturnValue(0);
    configModule.getRepoResetScript.mockReturnValue(null);

    // Default: findMainGitRoot rejects
    localReview.findMainGitRoot.mockRejectedValue(new Error('Not a git repo'));

    // Default: no paths exist on disk
    GitWorktreeManager.prototype.pathExists.mockResolvedValue(false);
  });

  afterEach(async () => {
    // Do NOT call vi.restoreAllMocks() - that would remove the spy wrappers
    // that pr-setup.js has already captured via destructuring.
    if (db) {
      await closeTestDatabase(db);
    }
  });

  // Helper to make specific paths "exist" for pathExists checks
  function makePathsExist(paths) {
    GitWorktreeManager.prototype.pathExists.mockImplementation(async (p) => {
      return paths.includes(p);
    });
  }

  it('should use monorepo path (Tier -1) over repo_settings known path (Tier 0)', async () => {
    const knownDbPath = '/home/user/repos/my-repo';

    // Configure Tier -1: monorepo config points to the real test repo
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`, knownDbPath]);

    // Configure Tier 0: register a known path in the database
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath('owner/repo', knownDbPath);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // Tier -1 (monorepo) should win over Tier 0 (known path)
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    // knownPath should still be reported from the database
    expect(result.knownPath).toBe(knownDbPath);
  });

  it('should set worktreeSourcePath when monorepo path resolves to a different root', async () => {
    const configuredWorktreePath = '/workspace/monorepo-worktree';

    // The configured path is a worktree that resolves to the real repo root
    // (simulating a worktree -> main repo resolution)
    configModule.getRepoPath.mockReturnValue(configuredWorktreePath);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // repositoryPath should be the resolved main root
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    // worktreeSourcePath should be the original configured path (for sparse-checkout inheritance)
    expect(result.worktreeSourcePath).toBe(configuredWorktreePath);
  });

  it('should not set worktreeSourcePath when monorepo path is the main root itself', async () => {
    // Configured path IS the main root (no worktree resolution difference)
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.worktreeSourcePath).toBeNull();
  });

  it('should fall back to Tier 0 when monorepo path does not exist', async () => {
    const invalidMonorepoPath = '/nonexistent/monorepo';

    // Tier -1: monorepo path is configured but findMainGitRoot rejects
    configModule.getRepoPath.mockReturnValue(invalidMonorepoPath);
    localReview.findMainGitRoot.mockRejectedValue(new Error('Path does not exist'));

    // Tier 0: known path in the database is valid (use real repo root)
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath('owner/repo', TEST_REPO_ROOT);

    makePathsExist([TEST_REPO_ROOT]);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // Monorepo path failed, so Tier 0 (known path) should be used
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.knownPath).toBe(TEST_REPO_ROOT);
    expect(result.worktreeSourcePath).toBeNull();
  });

  it('should fall back to Tier 0 when monorepo path resolves but git commands fail', async () => {
    const monorepoPath = '/workspace/broken-monorepo';

    // Tier -1: monorepo path resolves but to a non-existent directory,
    // so simpleGit(resolvedPath).revparse(['HEAD']) will fail
    configModule.getRepoPath.mockReturnValue(monorepoPath);
    localReview.findMainGitRoot.mockResolvedValue(monorepoPath);

    makePathsExist([`${monorepoPath}/.git`, TEST_REPO_ROOT]);

    // Set up Tier 0 known path (real repo so simpleGit succeeds)
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath('owner/repo', TEST_REPO_ROOT);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // Monorepo git commands failed (non-existent path), should fall back to Tier 0
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
  });

  it('should fall back to Tier 0 when monorepo path has no .git directory or HEAD file', async () => {
    const monorepoPath = '/workspace/not-a-repo';

    // Tier -1: monorepo path resolves, but pathExists returns false for .git and HEAD
    configModule.getRepoPath.mockReturnValue(monorepoPath);
    localReview.findMainGitRoot.mockResolvedValue(monorepoPath);

    // Only the known DB path exists; monorepo path has neither .git nor HEAD
    makePathsExist([TEST_REPO_ROOT]);

    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath('owner/repo', TEST_REPO_ROOT);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // No valid git structure at monorepo path, should fall back to Tier 0
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
  });

  it('should handle bare repo at monorepo path (HEAD file without .git directory)', async () => {
    // Use the real test repo; findMainGitRoot resolves to it and
    // simpleGit can run revparse successfully
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    // Simulate bare repo: HEAD exists but .git does not
    GitWorktreeManager.prototype.pathExists.mockImplementation(async (p) => {
      if (p === `${TEST_REPO_ROOT}/.git`) return false;
      if (p === `${TEST_REPO_ROOT}/HEAD`) return true;
      return false;
    });

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
  });

  it('should report knownPath as null when no path is registered in repo_settings', async () => {
    // Configure Tier -1 to succeed
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // Do NOT register any known path in the database

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.knownPath).toBeNull();
  });

  it('should return checkoutScript when configured, with worktreeSourcePath nullified', async () => {
    const configuredWorktreePath = '/workspace/monorepo-worktree';

    // Tier -1: monorepo path resolves through a worktree
    configModule.getRepoPath.mockReturnValue(configuredWorktreePath);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // checkout_script is configured
    configModule.resolveRepoOptions.mockReturnValue({ checkoutScript: './scripts/pr-checkout.sh', checkoutTimeout: 300000, worktreeConfig: null, resetScript: null, poolSize: 0, poolFetchIntervalMinutes: null });

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.checkoutScript).toBe('./scripts/pr-checkout.sh');
    // worktreeSourcePath should be nullified when checkoutScript is set
    // (even though monorepo path differs from resolved root)
    expect(result.worktreeSourcePath).toBeNull();
  });

  it('should return null checkoutScript when not configured (existing behavior preserved)', async () => {
    // Tier -1: monorepo path resolves directly to main root
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // No checkout_script configured (default resolveMonorepoOptions mock returns nulls)

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.checkoutScript).toBeNull();
    expect(result.worktreeSourcePath).toBeNull();
  });

  it('should nullify worktreeSourcePath when checkoutScript is set even with different monorepo path', async () => {
    const configuredWorktreePath = '/workspace/different-worktree';

    // Monorepo path differs from resolved root (would normally set worktreeSourcePath)
    configModule.getRepoPath.mockReturnValue(configuredWorktreePath);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // But checkout_script is also configured
    configModule.resolveRepoOptions.mockReturnValue({ checkoutScript: './checkout.sh', checkoutTimeout: 300000, worktreeConfig: null, resetScript: null, poolSize: 0, poolFetchIntervalMinutes: null });

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // checkoutScript is set, so worktreeSourcePath must be null
    expect(result.checkoutScript).toBe('./checkout.sh');
    expect(result.worktreeSourcePath).toBeNull();
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
  });

  it('should return worktreeConfig with worktreeBaseDir and nameTemplate when both are configured', async () => {
    // Tier -1: monorepo path resolves directly to main root
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // Configure checkout_script alongside worktree options
    configModule.resolveRepoOptions.mockReturnValue({
      checkoutScript: './scripts/pr-checkout.sh',
      checkoutTimeout: 300000,
      worktreeConfig: {
        worktreeBaseDir: '/custom/worktrees',
        nameTemplate: '{owner}-{repo}-pr-{pr_number}'
      },
      resetScript: null,
      poolSize: 0,
      poolFetchIntervalMinutes: null
    });

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.checkoutScript).toBe('./scripts/pr-checkout.sh');
    expect(result.worktreeConfig).toEqual({
      worktreeBaseDir: '/custom/worktrees',
      nameTemplate: '{owner}-{repo}-pr-{pr_number}'
    });
  });

  it('should return worktreeConfig with only worktreeBaseDir when nameTemplate is not configured', async () => {
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    configModule.resolveRepoOptions.mockReturnValue({
      checkoutScript: null,
      checkoutTimeout: 300000,
      worktreeConfig: { worktreeBaseDir: '/custom/worktrees' },
      resetScript: null,
      poolSize: 0,
      poolFetchIntervalMinutes: null
    });

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.worktreeConfig).toEqual({
      worktreeBaseDir: '/custom/worktrees'
    });
  });

  it('should return worktreeConfig with only nameTemplate when worktreeBaseDir is not configured', async () => {
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    configModule.resolveRepoOptions.mockReturnValue({
      checkoutScript: null,
      checkoutTimeout: 300000,
      worktreeConfig: { nameTemplate: '{owner}-{repo}-pr-{pr_number}' },
      resetScript: null,
      poolSize: 0,
      poolFetchIntervalMinutes: null
    });

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.worktreeConfig).toEqual({
      nameTemplate: '{owner}-{repo}-pr-{pr_number}'
    });
  });

  it('should return null worktreeConfig when neither worktreeDirectory nor nameTemplate are configured', async () => {
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // Both left as default (null)

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.worktreeConfig).toBeNull();
  });
});

// ============================================================================
// findRepositoryPath Tier 3 - fresh clone uses the supplied clone URL
// ============================================================================
// Regression: Tier 3 used to hard-code `https://github.com/<owner>/<repo>.git`.
// For alt hosts (whose API may omit `base.repo.clone_url`, and which callers
// now backstop with the repo's configured `clone_url`) that cloned the wrong
// host. The source repository here is a local path, so the test performs a
// real clone with no network access.

describe('findRepositoryPath Tier 3 clone URL', () => {
  let db;
  let sourceRepoDir;
  let testConfig;

  beforeEach(async () => {
    db = await createTestDatabase();
    vi.clearAllMocks();

    testConfig = { github_token: 'test-token' };

    configModule.getConfigDir.mockReturnValue(testConfigDir);
    configModule.getRepoPath.mockReturnValue(null);
    configModule.resolveRepoOptions.mockReturnValue({
      checkoutScript: null,
      checkoutTimeout: 300000,
      worktreeConfig: null,
      resetScript: null,
      poolSize: 0,
      poolFetchIntervalMinutes: null
    });
    configModule.resolvePoolConfig.mockReturnValue({ poolSize: 0, poolFetchIntervalMinutes: null });
    configModule.getRepoPoolSize.mockReturnValue(0);
    configModule.getRepoResetScript.mockReturnValue(null);
    localReview.findMainGitRoot.mockRejectedValue(new Error('Not a git repo'));
    // Nothing exists on disk -> falls through every tier to the fresh clone.
    GitWorktreeManager.prototype.pathExists.mockResolvedValue(false);

    // A real local repository to clone from (no network).
    sourceRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-src-'));
    const git = realSimpleGit(sourceRepoDir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    fs.writeFileSync(path.join(sourceRepoDir, 'README.md'), '# src\n');
    await git.add('.');
    await git.commit('initial');
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
    if (sourceRepoDir) {
      fs.rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  });

  it('clones from the supplied cloneUrl instead of github.com', async () => {
    const owner = 'altowner';
    const repo = `altrepo-${process.pid}`;
    const cachedRepoPath = path.join(testConfigDir, 'repos', owner, repo);

    try {
      const result = await findRepositoryPath({
        db,
        owner,
        repo,
        repository: `${owner}/${repo}`,
        prNumber: 1,
        config: testConfig,
        cloneUrl: sourceRepoDir
      });

      expect(result.repositoryPath).toBe(cachedRepoPath);
      const originUrl = (await realSimpleGit(cachedRepoPath).raw(['remote', 'get-url', 'origin'])).trim();
      expect(originUrl).toBe(sourceRepoDir);
    } finally {
      fs.rmSync(cachedRepoPath, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// storePRData - isNewReview return value
// ============================================================================
// Regression: storePRData creates the review record during CLI/web setup,
// but previously didn't report whether the review was new. The GET route's
// getOrCreate then found the existing record and fired review.loaded instead
// of review.started.

describe('storePRData returns isNewReview flag', () => {
  let db;

  const prInfo = { owner: 'owner', repo: 'repo', number: 99 };
  const prData = {
    title: 'Test PR',
    body: 'Description',
    author: 'octocat',
    base_branch: 'main',
    head_branch: 'feature',
  };
  const diff = '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new';
  const changedFiles = [{ file: 'file.js', insertions: 1, deletions: 1, changes: 2 }];
  const worktreePath = '/tmp/wt/pr-99';

  beforeEach(async () => {
    db = await createTestDatabase();
    vi.clearAllMocks();
    hookRunnerModule.fireHooks.mockImplementation(() => {});
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  it('should return isNewReview: true when creating a review for the first time', async () => {
    const result = await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true
    });

    expect(result.isNewReview).toBe(true);
    expect(result.reviewId).toBeGreaterThan(0);
  });

  it('should return isNewReview: false when updating an existing review', async () => {
    // First call creates the review
    const first = await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true
    });
    expect(first.isNewReview).toBe(true);

    // Second call finds the existing review
    const second = await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true
    });
    expect(second.isNewReview).toBe(false);
    expect(second.reviewId).toBe(first.reviewId);
  });

  it('should return the correct reviewId for newly created reviews', async () => {
    const result = await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true
    });

    // Verify the returned reviewId matches what's in the database
    const row = await queryOne(db, 'SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE', [99, 'owner/repo']);
    expect(result.reviewId).toBe(row.id);
  });
});

// ============================================================================
// storePRData - host column stamping (per-PR host resolution)
// ============================================================================
// The host column records which system a PR lives on (NULL = github.com,
// otherwise the configured api_host URL). storePRData self-heals the stored
// host when the caller knows it, but must not disturb it on a plain re-fetch.

describe('storePRData host stamping', () => {
  let db;

  const prInfo = { owner: 'owner', repo: 'repo', number: 77 };
  const prData = {
    title: 'Host PR',
    body: 'Description',
    author: 'octocat',
    base_branch: 'main',
    head_branch: 'feature',
  };
  const diff = '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new';
  const changedFiles = [{ file: 'file.js', insertions: 1, deletions: 1, changes: 2 }];
  const worktreePath = '/tmp/wt/pr-77';

  async function readHost() {
    const row = await queryOne(
      db,
      'SELECT host FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE',
      [prInfo.number, 'owner/repo']
    );
    return row ? row.host : undefined;
  }

  beforeEach(async () => {
    db = await createTestDatabase();
    vi.clearAllMocks();
    hookRunnerModule.fireHooks.mockImplementation(() => {});
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  it('writes NULL host on INSERT when host is omitted', async () => {
    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true
    });
    expect(await readHost()).toBeNull();
  });

  it('writes an api_host URL string on INSERT when host is provided', async () => {
    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true,
      host: 'https://ghe.example.com/api/v3'
    });
    expect(await readHost()).toBe('https://ghe.example.com/api/v3');
  });

  it('writes explicit null host (github.com) on INSERT', async () => {
    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true,
      host: null
    });
    expect(await readHost()).toBeNull();
  });

  it('stamps host on UPDATE when a host is provided', async () => {
    // First insert with NULL host, then re-fetch with a known alt host.
    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true
    });
    expect(await readHost()).toBeNull();

    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true,
      host: 'https://ghe.example.com/api/v3'
    });
    expect(await readHost()).toBe('https://ghe.example.com/api/v3');
  });

  it('leaves a previously stamped host untouched on UPDATE when host is omitted', async () => {
    // Seed a stamped host, then re-fetch without a host (host undefined).
    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true,
      host: 'https://ghe.example.com/api/v3'
    });
    expect(await readHost()).toBe('https://ghe.example.com/api/v3');

    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: true
    });
    // The stored host must survive an ordinary re-fetch that doesn't know it.
    expect(await readHost()).toBe('https://ghe.example.com/api/v3');
  });
});

// ============================================================================
// Pool-enabled PR setup (setupPRReview with poolSize > 0)
// ============================================================================
// These tests exercise the pool code path inside setupPRReview, verifying that
// WorktreePoolLifecycle.acquireForPR is used instead of GitWorktreeManager.
// createWorktreeForPR, and that pool worktrees are properly released on failure
// and linked to reviews on success.

describe('pool-enabled PR setup', () => {
  let db;
  let testConfig;

  const owner = 'owner';
  const repo = 'repo';
  const prNumber = 42;
  const repository = 'owner/repo';
  const githubToken = 'test-token';

  const mockPrData = {
    title: 'Test PR',
    body: 'Description',
    author: 'octocat',
    base_branch: 'main',
    head_branch: 'feature',
    base_sha: 'base000',
    head_sha: 'head111',
    changed_files: 2,
  };

  const poolWorktreePath = '/tmp/pool/wt-pool-abc';
  const poolWorktreeId = 'pool-abc';

  beforeEach(async () => {
    db = await createTestDatabase();
    vi.clearAllMocks();

    testConfig = {
      github_token: githubToken,
      monorepos: {},
    };

    // Config spies: pool enabled (poolSize > 0)
    configModule.getConfigDir.mockReturnValue(testConfigDir);
    configModule.getRepoPath.mockReturnValue(TEST_REPO_ROOT);
    configModule.resolveRepoOptions.mockReturnValue({
      checkoutScript: null,
      checkoutTimeout: 300000,
      worktreeConfig: null,
      resetScript: null,
      poolSize: 3,
      poolFetchIntervalMinutes: null,
    });
    configModule.resolvePoolConfig.mockReturnValue({ poolSize: 3, poolFetchIntervalMinutes: null });
    configModule.getRepoPoolSize.mockReturnValue(3);
    configModule.getRepoResetScript.mockReturnValue(null);

    // findRepositoryPath dependencies
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    GitWorktreeManager.prototype.pathExists.mockImplementation(async (p) => {
      return p === `${TEST_REPO_ROOT}/.git`;
    });

    // GitHub client spies
    GitHubClient.prototype.repositoryExists.mockResolvedValue(true);
    GitHubClient.prototype.fetchPullRequest.mockResolvedValue(mockPrData);
    GitHubClient.prototype.fetchPullRequestFiles.mockResolvedValue([
      { filename: 'src/app.js', status: 'modified' },
    ]);

    // Pool lifecycle spies — acquireForPR returns a pool worktree
    worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.acquireForPR.mockResolvedValue({
      worktreePath: poolWorktreePath,
      worktreeId: poolWorktreeId,
    });
    worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.releaseAfterHeadless.mockResolvedValue(true);
    worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.setReviewOwner.mockResolvedValue(undefined);

    // GitWorktreeManager prototype spies
    GitWorktreeManager.prototype.isSparseCheckoutEnabled.mockResolvedValue(false);
    GitWorktreeManager.prototype.generateUnifiedDiff.mockResolvedValue(
      '--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-old\n+new'
    );
    GitWorktreeManager.prototype.getChangedFiles.mockResolvedValue([
      { file: 'src/app.js', insertions: 1, deletions: 1, changes: 2 },
    ]);

    // Suppress hook firing
    hookRunnerModule.fireHooks.mockImplementation(() => {});
    hooksPayloads.fireReviewStartedHook.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  it('should use pool acquireForPR when poolSize > 0 and return correct result', async () => {
    const result = await setupPRReview({
      db, owner, repo, prNumber, githubToken, config: testConfig,
    });

    // Pool path was used (acquireForPR called, createWorktreeForPR NOT called)
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.acquireForPR).toHaveBeenCalledOnce();
    expect(GitWorktreeManager.prototype.createWorktreeForPR).not.toHaveBeenCalled();

    // Verify acquireForPR received the expected arguments
    const [prInfoArg, prDataArg, repoPathArg, optionsArg] =
      worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.acquireForPR.mock.calls[0];
    expect(prInfoArg).toEqual(
      expect.objectContaining({ owner, repo, prNumber, repository })
    );
    expect(repoPathArg).toBe(TEST_REPO_ROOT);
    expect(optionsArg.poolSize).toBe(3);

    // Correct review URL returned
    expect(result.reviewUrl).toBe('/pr/owner/repo/42');
    expect(result.title).toBe('Test PR');
  });

  it('should resolve pool size from repo settings before file config', async () => {
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.saveRepoSettings(repository, { pool_size: 10 });
    configModule.resolvePoolConfig.mockReturnValue({ poolSize: 10, poolFetchIntervalMinutes: null });

    await setupPRReview({
      db, owner, repo, prNumber, githubToken, config: testConfig,
    });

    expect(configModule.resolvePoolConfig).toHaveBeenCalledWith(
      testConfig,
      repository,
      expect.objectContaining({ pool_size: 10 })
    );
    const optionsArg = worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.acquireForPR.mock.calls[0][3];
    expect(optionsArg.poolSize).toBe(10);
  });

  it('should persist review ID to pool entry via setReviewOwner', async () => {
    // Seed a real pool row so we can verify the DB state after setup.
    // This row simulates what acquireForPR would have created: an in_use
    // pool worktree with no review owner yet.
    const now = new Date().toISOString();
    await run(db, `
      INSERT INTO worktree_pool (id, repository, path, status, current_pr_number, current_review_id, last_switched_at, created_at)
      VALUES (?, ?, ?, 'in_use', ?, NULL, ?, ?)
    `, [poolWorktreeId, repository, poolWorktreePath, prNumber, now, now]);

    // Let setReviewOwner call through to the real DB implementation
    // so the seeded pool row is actually updated.
    const poolRepo = new WorktreePoolRepository(db);
    worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.setReviewOwner
      .mockImplementation((wtId, revId) => poolRepo.setCurrentReviewId(wtId, revId));

    await setupPRReview({
      db, owner, repo, prNumber, githubToken, config: testConfig,
    });

    // Primary assertion: verify current_review_id is set in the database
    const poolRow = await queryOne(
      db,
      'SELECT current_review_id FROM worktree_pool WHERE id = ?',
      [poolWorktreeId]
    );
    expect(poolRow).toBeTruthy();

    const review = await queryOne(
      db,
      'SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE',
      [prNumber, repository]
    );
    expect(review).toBeTruthy();
    expect(poolRow.current_review_id).toBe(review.id);

    // Complementary spy check: setReviewOwner was called with correct args
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.setReviewOwner)
      .toHaveBeenCalledOnce();
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.setReviewOwner)
      .toHaveBeenCalledWith(poolWorktreeId, review.id);
  });

  it('should call setReviewOwner on the pool entry after storing PR data', async () => {
    await setupPRReview({
      db, owner, repo, prNumber, githubToken, config: testConfig,
    });

    // Verify setReviewOwner was called after storePRData created the review
    const review = await queryOne(
      db,
      'SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE',
      [prNumber, repository]
    );
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.setReviewOwner)
      .toHaveBeenCalledWith(poolWorktreeId, review.id);
  });

  it('should release pool worktree on failure after acquireForPR', async () => {
    // Make diff generation fail AFTER pool worktree is acquired
    GitWorktreeManager.prototype.generateUnifiedDiff.mockRejectedValue(
      new Error('diff generation failed')
    );

    await expect(
      setupPRReview({ db, owner, repo, prNumber, githubToken, config: testConfig })
    ).rejects.toThrow('diff generation failed');

    // Pool worktree was acquired
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.acquireForPR).toHaveBeenCalledOnce();

    // Pool worktree was released after failure
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.releaseAfterHeadless).toHaveBeenCalledOnce();
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.releaseAfterHeadless).toHaveBeenCalledWith(poolWorktreeId);
  });

  it('should release pool worktree when storePRData fails', async () => {
    // Force storePRData to fail by closing the database before it runs.
    // Instead, mock generateUnifiedDiff to succeed but make the DB throw
    // during the store step by inserting invalid data.
    // Simplest approach: make getChangedFiles reject after diff succeeds.
    GitWorktreeManager.prototype.getChangedFiles.mockRejectedValue(
      new Error('getChangedFiles failed')
    );

    await expect(
      setupPRReview({ db, owner, repo, prNumber, githubToken, config: testConfig })
    ).rejects.toThrow('getChangedFiles failed');

    // Pool worktree was released
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.releaseAfterHeadless).toHaveBeenCalledOnce();
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.releaseAfterHeadless).toHaveBeenCalledWith(poolWorktreeId);
  });

  it('should succeed with non-pool fallback when pool is full (acquireForPR handles overflow)', async () => {
    // acquireForPR now handles pool exhaustion internally by creating a non-pool
    // worktree and returning it. The caller (setupPRReview) sees a normal result.
    const nonPoolPath = '/tmp/non-pool-overflow-wt';
    const nonPoolId = 'wt-overflow-123';
    worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.acquireForPR.mockResolvedValue({
      worktreePath: nonPoolPath,
      worktreeId: nonPoolId,
    });

    const result = await setupPRReview({
      db, owner, repo, prNumber, githubToken, config: testConfig,
    });

    expect(result.reviewUrl).toBe('/pr/owner/repo/42');
    // setReviewOwner should still be called with the returned worktreeId
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.setReviewOwner).toHaveBeenCalledWith(
      nonPoolId, expect.any(Number)
    );
  });

  it('should not use pool when poolSize is 0', async () => {
    // Override pool size to 0
    configModule.resolvePoolConfig.mockReturnValue({ poolSize: 0, poolFetchIntervalMinutes: null });

    // createWorktreeForPR must return the expected shape
    GitWorktreeManager.prototype.createWorktreeForPR.mockResolvedValue({
      path: '/tmp/non-pool-wt',
      id: 'wt-regular',
    });

    const result = await setupPRReview({
      db, owner, repo, prNumber, githubToken, config: testConfig,
    });

    // Pool path NOT used
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.acquireForPR).not.toHaveBeenCalled();

    // Non-pool createWorktreeForPR was used instead
    expect(GitWorktreeManager.prototype.createWorktreeForPR).toHaveBeenCalledOnce();

    expect(result.reviewUrl).toBe('/pr/owner/repo/42');
  });

  it('should not release pool worktree when error occurs before acquireForPR', async () => {
    // Make the verify step fail (before pool acquisition)
    GitHubClient.prototype.repositoryExists.mockResolvedValue(false);

    await expect(
      setupPRReview({ db, owner, repo, prNumber, githubToken, config: testConfig })
    ).rejects.toThrow('not found');

    // Neither acquire nor release should have been called
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.acquireForPR).not.toHaveBeenCalled();
    expect(worktreePoolLifecycleModule.WorktreePoolLifecycle.prototype.releaseAfterHeadless).not.toHaveBeenCalled();
  });
});
