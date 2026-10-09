// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
const fs = require('node:fs/promises');
const { loadInstructionSources, serverReceipt, runReceipt } = require('../../src/utils/review-protocol');

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
