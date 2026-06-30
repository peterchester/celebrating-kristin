// A small reusable upload progress bar, shared by the share form and the
// reflection form. Create it once over a container element, then drive it from
// uploadOne's onProgress callback. Markup is injected here (not in the .astro
// template), so its styles live in styles/content.css — Astro-scoped styles
// wouldn't reach JS-injected nodes.

import type { UploadProgress } from './upload';

const fmtSize = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.max(0, Math.round(mb)) + ' MB';
};

const fmtETA = (secs: number): string => {
  if (!isFinite(secs) || secs <= 0) return '';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
};

export interface UploadProgressUI {
  /** Begin a new file; resets the bar and shows which file (of how many). */
  start(name: string, index: number, total: number): void;
  /** Update from an onProgress event. */
  update(p: UploadProgress): void;
  /** Hide the bar (call when all uploads finish or on error). */
  reset(): void;
}

export function createUploadProgress(container: HTMLElement): UploadProgressUI {
  container.classList.add('upload-progress');
  container.innerHTML =
    `<div class="up-row"><span class="up-label"></span><span class="up-pct"></span></div>` +
    `<div class="up-track"><div class="up-fill"></div></div>` +
    `<div class="up-meta"></div>`;
  container.hidden = true;

  const label = container.querySelector('.up-label') as HTMLElement;
  const pct = container.querySelector('.up-pct') as HTMLElement;
  const fill = container.querySelector('.up-fill') as HTMLElement;
  const meta = container.querySelector('.up-meta') as HTMLElement;
  let started = 0;

  return {
    start(name, index, total) {
      container.hidden = false;
      started = Date.now();
      label.textContent =
        total > 1 ? `Uploading “${name}” — file ${index + 1} of ${total}` : `Uploading “${name}”`;
      pct.textContent = '0%';
      fill.style.width = '0%';
      meta.textContent = 'Starting…';
    },
    update(p) {
      const elapsed = (Date.now() - started) / 1000;
      const speed = elapsed > 0 ? p.loaded / elapsed : 0; // bytes/sec
      const eta = speed > 0 ? (p.total - p.loaded) / speed : Infinity;
      const pctVal = Math.round(p.fraction * 100);
      pct.textContent = pctVal + '%';
      fill.style.width = pctVal + '%';
      const left = fmtETA(eta);
      meta.textContent = `${fmtSize(p.loaded)} of ${fmtSize(p.total)}` + (left ? ` · about ${left} left` : '');
    },
    reset() {
      container.hidden = true;
    },
  };
}
