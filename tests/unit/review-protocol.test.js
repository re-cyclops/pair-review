// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
const fs = require('node:fs/promises');
const { loadInstructionSources, loadedProtocol, captureRunProtocol, digest, serverReceipt, runReceipt } = require('../../src/utils/review-protocol');
const { AnalysisRunRepository } = require('../../src/database');

afterEach(() => vi.restoreAllMocks());

describe('trusted instruction sources', () => {
  it('extracts a real Markdown section without following headings inside fenced examples', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('# Policy\n\n## Review comments\nKeep the technical claim.\n\n```md\n## Private work\nLiteral example.\n```\n\n### Questions\nKeep uncertainty.\n\n## Private work\nDo not load this.\n');
    const loaded = await loadInstructionSources([{ path: '/fixture/policy.md', sections: ['Review comments'] }]);
    expect(loaded.content).toContain('Literal example.');
    expect(loaded.content).toContain('Keep uncertainty.');
    expect(loaded.content).not.toContain('Do not load this.');
    expect(loaded.sources[0].sections).toEqual(['Review comments']);
  });

  it('rejects a missing required section instead of silently omitting it', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('Policy\n======\n\nReview comments\n---------------\nKeep literal code.\n');
    expect((await loadInstructionSources([{ path: '/fixture/policy.md', sections: ['Review comments'] }])).content).toContain('Keep literal code.');
    await expect(loadInstructionSources([{ path: '/fixture/policy.md', sections: ['Commits'] }])).rejects.toThrow('Instruction section not found');
  });

  it('includes an explicit scope preamble and coalesces overlapping selected sections', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('# Policy\n\nOnly authored prose is in scope.\n\n## Review comments\nKeep the claim.\n\n### Questions\nKeep uncertainty.\n\n## Company\nNot applicable.\n');
    const loaded = await loadInstructionSources([{ path: '/fixture/policy.md', preamble: true, sections: ['Questions', 'Review comments', 'Review comments'] }]);
    expect(loaded.content).toBe('# Policy\n\nOnly authored prose is in scope.\n\n## Review comments\nKeep the claim.\n\n### Questions\nKeep uncertainty.');
    await expect(loadInstructionSources(['/fixture/policy.md', '/fixture/policy.md'])).rejects.toThrow('configured more than once');
  });

  it('reports disk drift without changing loaded instructions or the captured run', async () => {
    const file = vi.spyOn(fs, 'readFile').mockResolvedValue('Loaded policy');
    const loaded = await loadInstructionSources(['/fixture/private/policy.md']);
    const config = { globalInstructions: loaded.content, default_provider: 'omp', default_model: 'default', chat_provider: 'pi', external_comments: false };
    const before = await serverReceipt(config, loaded.sources);
    const row = { id: 'run', provider: 'omp', model: 'default', global_instructions: loaded.content, head_sha: 'old-head' };
    const captured = runReceipt(row);
    file.mockResolvedValue('New on-disk policy');
    const after = await serverReceipt(config, loaded.sources);
    expect(after['Configuration sources'][0]).toMatchObject({ restartRequired: true, loadedDigest: before['Configuration sources'][0].loadedDigest });
    expect(after['Instruction content loaded']).toEqual(before['Instruction content loaded']);
    expect(runReceipt(row)).toEqual(captured);
    expect(JSON.stringify(after)).not.toContain('/fixture/private');
    expect(JSON.stringify(after)).not.toContain('Loaded policy');
    expect(after['Server defaults']).toMatchObject({ provider: 'omp', model: 'default', chatProvider: 'pi', externalComments: false });
  });
});

describe('captured protocol receipts', () => {
  it('keeps root and inherited council receipts unchanged after configuration mutates', async () => {
    const db = createTestDatabase();
    try {
      db.prepare("INSERT INTO reviews(id, repository, review_type) VALUES(1, 'fixture/repo', 'pr')").run();
      const config = { default_provider: 'omp', default_model: 'default', comment_format: 'plain', globalInstructions: 'Original policy',
        review_prose: { profile: 'Fixture profile', rules: { 'terminal-period': 'advisory' } } };
      config._protocol = loadedProtocol(config, [{ name: 'config', data: config }],
        [{ label: 'Instructions: policy.md', digest: digest('Original policy'), sections: ['Review'] }]);
      const protocol = captureRunProtocol(config);
      config.default_model = 'next-model';
      config._protocol.sources[0].loadedDigest = 'changed';
      expect(protocol.serverInputs.default_model).toEqual({ value: 'default', source: 'config' });
      expect(protocol.sources[0].loadedDigest).toBe(digest('Original policy'));
      const runs = new AnalysisRunRepository(db);
      const creating = runs.create({ id: 'root', reviewId: 1, protocol });
      protocol.serverInputs.default_model.value = 'mutated-before-insert';
      await creating;
      const child = await runs.create({ id: 'child', reviewId: 1, parentRunId: 'root', protocol: captureRunProtocol(config) });
      const root = runReceipt(await runs.getById('root'));
      expect(root.protocol.serverInputs.default_model.value).toBe('default');
      expect(runReceipt(child).protocol).toEqual(root.protocol);
      expect(root.protocol.prosePolicy.rules[0]).toMatchObject({ layer: 'config', severity: 'advisory' });
      expect(runReceipt(await runs.create({ id: 'import', reviewId: 1, status: 'completed' })).protocol).toBeNull();
    } finally { closeTestDatabase(db); }
  });

  it('attributes in-app analysis defaults and exposes voice hashes without private instructions or commands', async () => {
    const secret = 'Private fixture content must remain hidden';
    const execution = { voices: [{ provider: 'omp', model: 'default', customInstructions: secret, env: { TOKEN: secret } }],
      providerOverridesMap: { omp: { load_skills: false, command: secret } } };
    const config = { default_model: 'next-model', default_council_id: 'selected-council',
      _globalOverrides: { default_model: 'next-model', default_council_id: 'selected-council' } };
    const protocol = captureRunProtocol(config, execution);
    const receipt = runReceipt({ id: 'voice', protocol_snapshot: JSON.stringify(protocol), levels_config: JSON.stringify(execution), global_instructions: secret });
    expect(receipt.protocol.serverInputs.default_model).toEqual({ value: 'next-model', source: 'app' });
    expect(receipt.protocol.serverInputs.default_council_id).toEqual({ value: 'selected-council', source: 'app' });
    const server = await serverReceipt(config);
    expect(server['Server setting sources'].default_council_id).toEqual({ value: 'selected-council', source: 'app' });
    expect(server['Server defaults'].councilId).toBe('selected-council');
    expect(receipt.levels.voices[0]).toMatchObject({ provider: 'omp', model: 'default', customInstructionsDigest: digest(JSON.stringify(secret)) });
    expect(receipt.protocol.execution.selection.providerOverridesMap.omp.load_skills).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(secret);
  });
});
