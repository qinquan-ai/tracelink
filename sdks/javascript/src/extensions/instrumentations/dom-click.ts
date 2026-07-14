/**
 * Auto click listener — captures every click in the page.
 *
 * Why auto? Manually instrumenting every button is tedious and the
 * first click we forget is the bug we're chasing. This is opt-out
 * via disableAutoClick() if a user wants silence.
 *
 * Only active in dev mode (import.meta.env.DEV). Production builds
 * tree-shake this entire module.
 */

import { tracer } from '../../index.js';

const SKIP_TAGS = new Set(['html', 'body', 'svg', 'path', 'g', 'rect', 'circle', 'script', 'style', 'link']);

let installed = false;
let enabled = true;

export function installAutoClick(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  document.addEventListener(
    'click',
    (e) => {
      if (!enabled) return;
      const target = e.target as HTMLElement | null;
      if (!target || !target.tagName) return;

      const tag = target.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;

      const text = (target.innerText || target.textContent || '').trim().slice(0, 50);
      const id = target.id ? `#${target.id}` : '';
      const cls = target.className && typeof target.className === 'string'
        ? `.${target.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')}`
        : '';

      tracer.action(
        'auto-click',
        `用户点击 ${tag}${id || cls}`,
        { text, x: e.clientX, y: e.clientY },
      );
    },
    { capture: true },
  );
}

export function disableAutoClick(): void {
  enabled = false;
}

export function enableAutoClick(): void {
  enabled = true;
}
