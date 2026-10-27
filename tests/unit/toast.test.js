// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

require('../../public/js/components/Toast.js');
beforeAll(async () => {
  if (!window.toast) await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
});
beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  window.toast.createContainer();
  window.toast.activeToasts = [];
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('renders untrusted filenames and error text literally through every notification type', () => {
  const message = 'Cannot remove <img src=x onerror="window.injected=true"> & `checkout`';
  for (const method of ['error', 'warning', 'info', 'success']) {
    window.toast[method](message);
    const toast = document.querySelector('.toast:last-child');
    expect(toast.querySelector('.toast-message').textContent).toBe(message);
    expect(toast.querySelector('img, script')).toBeNull();
  }
});

it('preserves an HTTP destination and link label without parsing markup', () => {
  const link = 'https://github.com/example/alpha/pull/42?text="quoted"';
  const linkText = '<strong>Open review</strong>';
  window.toast.success('Submitted', { link, linkText });
  const anchor = document.querySelector('.toast-link');
  expect(anchor.href).toBe(new URL(link).href);
  expect(anchor.textContent).toBe(linkText);
  expect(anchor.querySelector('strong')).toBeNull();
});

it('does not offer executable notification destinations', () => {
  window.toast.success('Result retained', { link: 'javascript:alert(document.domain)' });
  expect(document.querySelector('.toast-link')).toBeNull();
  expect(document.querySelector('.toast-message').textContent).toBe('Result retained');
});
