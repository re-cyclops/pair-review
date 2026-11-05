// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function createGitFixture(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-model-flow-'));
  const close = () => fs.rmSync(directory, { recursive: true, force: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: directory, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Model Flow Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), 'const value = 1;\n');
    }
    git('add', '.');
    git('commit', '--quiet', '--message=Base');
    const base = git('rev-parse', 'HEAD');
    for (const file of files) fs.writeFileSync(path.join(directory, file), 'const value = 2;\n');
    git('add', '.');
    git('commit', '--quiet', '--message=Current head');
    return { directory, base, head: git('rev-parse', 'HEAD'), close };
  } catch (error) {
    close();
    throw error;
  }
}

module.exports = { createGitFixture };
