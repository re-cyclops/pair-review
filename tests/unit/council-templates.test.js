// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const { getCouncilTemplates } = require('../../src/council-templates');
const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab');
require('../../public/js/components/TimeoutSelect');
const TimeoutSelect = window.TimeoutSelect;

let tab;
let saved;
let fetchMock;
function choose(selector, value) {
  const el = document.querySelector(selector);
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(async () => {
  document.body.innerHTML = '<div id="modal"><div id="tab-panel-council"></div></div>';
  vi.stubGlobal('TimeoutSelect', TimeoutSelect);
  saved = [{ id: 'mine', name: 'My existing council', type: 'council', config: getCouncilTemplates()[0].config }];
  fetchMock = vi.fn(async (_url, options) => {
    if (options?.method === 'POST') {
      const council = { ...JSON.parse(options.body), id: 'new-saved' };
      saved.push(council);
      return { ok: true, json: async () => ({ council }) };
    }
    return { ok: true, json: async () => ({ councils: saved, templates: getCouncilTemplates() }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  tab = new VoiceCentricConfigTab(document.querySelector('#modal'));
  tab.inject(document.querySelector('#tab-panel-council'));
  // Deliberately stale menu: explicit template models must survive editing/refresh.
  tab.setProviders({ omp: { name: 'OMP', models: [{ id: 'default', name: 'Default' }] } });
  await tab.loadCouncils();
});

afterEach(() => {
  delete window.textInputDialog;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('four-model council templates', () => {
  it.each(['four-model-focused', 'four-model-full'])('applies inspectable %s without altering saved councils', async id => {
    const before = JSON.stringify(saved);
    choose('#vc-template-selector', id);
    const config = tab.getCouncilConfig();
    expect(config.voices.map(v => v.model)).toEqual([
      'zai/glm-5.3-flash:high', 'google-antigravity/gemini-3.8-flash:high',
      'muse-code/muse-wonder-full-1.0:high', 'openai-codex/gpt-6.1-sol:high'
    ]);
    expect(config.consolidation.model).toBe('muse-code/muse-wonder-full-1.0:high');
    expect(config.levels).toEqual({ '1': true, '2': true, '3': id.endsWith('full') });
    tab.setProviders(tab.providers);
    expect(tab.getCouncilConfig().voices).toEqual(config.voices);
    await tab.autoSaveIfDirty();
    expect(fetchMock.mock.calls.every(([, options]) => !options)).toBe(true);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it.each(['missing', 'unavailable'])('preserves explicit OMP voices and consolidation when provider is %s, including saved reopen', state => {
    const providers = {
      claude: { name: 'Claude', models: [{ id: 'sonnet', name: 'Sonnet' }] }
    };
    if (state === 'unavailable') {
      providers.omp = {
        name: 'OMP', availability: { available: false },
        models: [{ id: 'default', name: 'Default' }]
      };
    }
    tab.setProviders(providers);
    choose('#vc-template-selector', 'four-model-full');
    const expected = getCouncilTemplates()[1].config;
    const assertExplicitSelection = () => {
      const config = tab.getCouncilConfig();
      expect(config.voices.map(({ provider, model }) => ({ provider, model })))
        .toEqual(expected.voices.map(({ provider, model }) => ({ provider, model })));
      expect(config.consolidation.provider).toBe('omp');
      expect(config.consolidation.model).toBe(expected.consolidation.model);
      const selectors = document.querySelectorAll('.voice-provider');
      expect(selectors).toHaveLength(5);
      selectors.forEach(select => {
        expect(select.value).toBe('omp');
        expect(select.selectedOptions[0].textContent).toMatch(/unavailable/);
      });
    };
    assertExplicitSelection();
    tab.setProviders(providers);
    assertExplicitSelection();
    // Reopening a saved council must preserve unavailable selections as well.
    tab.reset();
    choose('#vc-council-selector', 'mine');
    assertExplicitSelection();
    expect(tab.getCouncilConfig().levels['3']).toBe(false);
  });

  it('edits, explicitly saves, and reuses a user-owned copy', async () => {
    choose('#vc-template-selector', 'four-model-full');
    const level = document.querySelector('.vc-level-checkbox[data-level="3"]');
    level.checked = false;
    level.dispatchEvent(new Event('change', { bubbles: true }));
    window.textInputDialog = { show: vi.fn().mockResolvedValue('My focused council') };
    expect(document.querySelector('#vc-council-save-btn').disabled).toBe(false);
    await tab._saveCouncil();
    expect(tab.getSelectedCouncilId()).toBe('new-saved');
    choose('#vc-council-selector', 'mine');
    choose('#vc-council-selector', 'new-saved');
    expect(tab.getCouncilConfig().levels['3']).toBe(false);
    expect(saved[0].name).toBe('My existing council');
    expect(saved[1].config.voices).toHaveLength(4);
  });

});
