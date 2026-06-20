// Full-screen photo lightbox for the single memory view. Vanilla TS, no deps.
//
// openGallery(items, start) shows a black full-window overlay with the photo
// fitted to the viewport (small photos shown at native size, never upscaled),
// prev/next nav (arrows, on-screen buttons, swipe), a counter + caption, and a
// download button that fetches the full-resolution original. isLightboxOpen()
// lets the page hand keyboard arrows to the gallery while it's open and restore
// post-to-post navigation when it closes.
//
// Each gallery is an independent set of items — the main post's photos are one
// gallery; every reflection's photos are their own.

export interface LightboxItem {
  src: string;        // display image (web-optimized)
  original?: string;  // full-resolution untouched upload, used for download
  caption?: string;
  alt?: string;
}

let overlay: HTMLElement | null = null;
let imgEl: HTMLImageElement;
let capEl: HTMLElement;
let counterEl: HTMLElement;
let dlEl: HTMLAnchorElement;
let prevBtn: HTMLButtonElement;
let nextBtn: HTMLButtonElement;
let closeBtn: HTMLButtonElement;

let items: LightboxItem[] = [];
let idx = 0;
let lastFocus: HTMLElement | null = null;

export function isLightboxOpen(): boolean {
  return !!overlay && !overlay.hidden;
}

function basename(url: string): string {
  try {
    return decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || 'photo');
  } catch {
    return 'photo';
  }
}

function render(): void {
  const it = items[idx];
  if (!it) return;
  imgEl.style.opacity = '0';
  imgEl.src = it.src;
  imgEl.alt = it.alt ?? it.caption ?? '';
  capEl.textContent = it.caption ?? '';
  counterEl.textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : '';
  const url = it.original ?? it.src;
  dlEl.href = url;
  dlEl.setAttribute('download', basename(url));
  const multi = items.length > 1;
  prevBtn.hidden = !multi;
  nextBtn.hidden = !multi;
}

function go(delta: number): void {
  if (items.length < 2) return;
  idx = (idx + delta + items.length) % items.length;
  render();
}

function close(): void {
  if (!overlay) return;
  overlay.hidden = true;
  document.body.classList.remove('lb-lock');
  imgEl.removeAttribute('src');
  if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
}

// Build the overlay DOM once, on first open.
function build(): void {
  overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Photo viewer');
  overlay.hidden = true;
  overlay.innerHTML =
    '<button class="lb-close" type="button" aria-label="Close">&times;</button>' +
    '<button class="lb-prev" type="button" aria-label="Previous photo">&#8249;</button>' +
    '<div class="lb-stage"><img class="lb-img" alt="" /></div>' +
    '<button class="lb-next" type="button" aria-label="Next photo">&#8250;</button>' +
    '<div class="lb-bar">' +
    '<span class="lb-counter"></span>' +
    '<span class="lb-caption"></span>' +
    '<a class="lb-download" href="#" aria-label="Download full-resolution photo">Download</a>' +
    '</div>';
  document.body.appendChild(overlay);

  imgEl = overlay.querySelector('.lb-img') as HTMLImageElement;
  capEl = overlay.querySelector('.lb-caption') as HTMLElement;
  counterEl = overlay.querySelector('.lb-counter') as HTMLElement;
  dlEl = overlay.querySelector('.lb-download') as HTMLAnchorElement;
  prevBtn = overlay.querySelector('.lb-prev') as HTMLButtonElement;
  nextBtn = overlay.querySelector('.lb-next') as HTMLButtonElement;
  closeBtn = overlay.querySelector('.lb-close') as HTMLButtonElement;

  imgEl.addEventListener('load', () => { imgEl.style.opacity = '1'; });
  prevBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => go(1));
  closeBtn.addEventListener('click', close);
  // Click the black backdrop (not the photo or a control) to close.
  overlay.addEventListener('click', (e) => { if (e.target === overlay || (e.target as HTMLElement).classList.contains('lb-stage')) close(); });

  // Keyboard: only while open. preventDefault stops arrows from also scrolling.
  document.addEventListener('keydown', (e) => {
    if (!isLightboxOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'Tab') { e.preventDefault(); cycleFocus(e.shiftKey ? -1 : 1); }
  });

  // Touch: horizontal swipe navigates, a downward swipe closes.
  let x0 = 0, y0 = 0, tracking = false;
  overlay.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    tracking = true; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  overlay.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close();
  }, { passive: true });
}

// Minimal focus trap: keep Tab within the overlay's controls.
function cycleFocus(dir: number): void {
  const focusables = [closeBtn, prevBtn, nextBtn, dlEl].filter((el) => el && !(el as HTMLElement).hidden);
  if (!focusables.length) return;
  const cur = focusables.indexOf(document.activeElement as any);
  const nextEl = focusables[(cur + dir + focusables.length) % focusables.length] as HTMLElement;
  nextEl.focus();
}

export function openGallery(list: LightboxItem[], start = 0): void {
  if (!list.length) return;
  if (!overlay) build();
  items = list;
  idx = Math.max(0, Math.min(start, list.length - 1));
  lastFocus = document.activeElement as HTMLElement;
  render();
  overlay!.hidden = false;
  document.body.classList.add('lb-lock');
  closeBtn.focus();
}

// Wire a set of in-page <img> thumbnails (in gallery order) to open the gallery
// at the clicked photo. `imgEls[i]` must correspond to `items[i]`.
export function attachThumbs(imgEls: HTMLImageElement[], list: LightboxItem[]): void {
  imgEls.forEach((el, i) => {
    if (i >= list.length) return;
    el.classList.add('lb-thumb');
    el.addEventListener('click', () => openGallery(list, i));
  });
}

// Pull the image items (in order) out of a media array — the gallery skips
// audio/video, photos only.
export function imageItems(media: Array<{ type: string; src: string; original?: string; caption?: string; alt?: string }> | undefined): LightboxItem[] {
  return (media ?? [])
    .filter((m) => m.type === 'image')
    .map((m) => ({ src: m.src, original: m.original, caption: m.caption, alt: m.alt }));
}
