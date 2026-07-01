// Client-side renderers. They build the SAME markup the Astro components
// (MemoryCard / Media / the post page) produce at build time, so memories
// fetched at runtime look identical. Every user-supplied value is run through
// esc() so submitted text can never inject HTML/JS into the page.

export interface MediaItem {
  type: 'image' | 'audio' | 'video';
  src: string;
  hls?: string; // video only: adaptive HLS manifest; preferred over src when present
  poster?: string;
  title?: string; // audio only: track title (ID3), shown in a multi-track playlist
  artist?: string; // audio only: track artist (ID3)
  caption?: string;
  alt?: string;
}

// Build the markup for a playable <video>. When an HLS manifest exists we emit a
// posterless src-less shell carrying data-hls (+ data-mp4 fallback); attachHls()
// (src/lib/hls.ts) wires up native HLS or hls.js after it's in the DOM. Without a
// manifest (still processing, or a legacy entry) we fall back to a plain
// progressive <video src>. The whole post is rendered by JS anyway, so requiring
// JS to start playback is consistent with the rest of the page.
function videoTag(m: MediaItem, extraAttrs = ''): string {
  const poster = m.poster ? ` poster="${esc(m.poster)}"` : '';
  const common = `controls playsinline preload="metadata"${poster}${extraAttrs ? ' ' + extraAttrs : ''}`;
  return m.hls
    ? `<video data-hls="${esc(m.hls)}" data-mp4="${esc(m.src)}" ${common}></video>`
    : `<video src="${esc(m.src)}" ${common}></video>`;
}
export interface Entry {
  id: string;
  author: { name: string; relationship?: string };
  title?: string;
  body: string;
  media?: MediaItem[];
  memoryDate?: string;
  submittedAt?: string;
  status?: string;
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s);

// Common title/name abbreviations whose trailing period must NOT be treated as
// a sentence end (e.g. "Dr.", "Mr. and Mrs.", "St. Mary's"). Lowercased, no dot.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'rev', 'fr', 'sr', 'jr', 'st', 'mt', 'vs', 'etc',
]);

// Grid-card preview text. Prefer ending at the first sentence boundary — a
// '.', '!' or '?' followed by whitespace or the end of the text — so a card
// ends on a complete thought rather than a mid-sentence cut. The whitespace/end
// lookahead avoids breaking on decimals (3.5) or URLs (example.com); a period is
// also skipped when it follows a known abbreviation or a single-letter initial
// ("J. R. R."). When the first real sentence runs past the limit (or there's no
// sentence break at all), fall back to the hard character truncation.
const firstSentence = (s: string, n: number): string => {
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const end = m.index;
    if (s[end] === '.') {
      // Include apostrophes so a possessive ("Mary's.") reads as a whole word
      // rather than collapsing to a stray single-letter "s".
      const word = (s.slice(0, end).match(/([A-Za-z']+)$/)?.[1] ?? '').toLowerCase();
      if (word.length === 1 || ABBREVIATIONS.has(word)) continue; // abbreviation/initial, not a sentence end
    }
    return end + 1 <= n ? s.slice(0, end + 1) : truncate(s, n);
  }
  return truncate(s, n);
};

// Escape text, then turn bare URLs (http(s):// or www.) into clickable links.
// Safe by construction: escaping runs first (no raw HTML survives), and only
// http/https URLs are linked — never javascript:/data:. Trailing sentence
// punctuation is left outside the link. Used for the post body only.
function linkify(text: string): string {
  return esc(text).replace(/((?:https?:\/\/|www\.)[^\s<]+)/gi, (m) => {
    const t = m.match(/[.,;:!?]+$/);
    const trail = t ? t[0] : '';
    if (trail) m = m.slice(0, -trail.length);
    const href = m.toLowerCase().startsWith('www.') ? 'https://' + m : m;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${m}</a>${trail}`;
  });
}

// ── Home gallery card (mirrors MemoryCard.astro) ─────────────────────────────
export function cardHTML(entry: Entry): string {
  const media = entry.media ?? [];
  const firstImage = media.find((m) => m.type === 'image');
  const firstVideo = media.find((m) => m.type === 'video');
  const hasAudio = media.some((m) => m.type === 'audio');
  const photoCount = media.filter((m) => m.type === 'image').length;
  const cover = firstImage
    ? { src: firstImage.src, alt: firstImage.alt ?? firstImage.caption ?? '' }
    : firstVideo?.poster
      ? { src: firstVideo.poster, alt: '' }
      : null;
  const kind = firstImage ? 'image' : firstVideo ? 'video' : hasAudio ? 'audio' : 'text';

  const firstPara = (entry.body || '').split(/\n\s*\n/)[0].trim();
  const excerpt = firstSentence(firstPara, kind === 'text' ? 320 : 180);
  const excerptHTML = excerpt ? `<p class="excerpt">${esc(excerpt)}</p>` : '';

  let coverHTML = '';
  if (cover) {
    coverHTML =
      `<div class="cover"><img src="${esc(cover.src)}" alt="${esc(cover.alt)}" loading="lazy" />` +
      (kind === 'video'
        ? `<span class="play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></span>`
        : '') +
      `</div>`;
  } else if (kind === 'audio') {
    const bars = [6, 14, 9, 22, 30, 18, 26, 34, 20, 12, 28, 16, 24, 10, 18, 8];
    const rects = bars
      .map((h, i) => `<rect x="${i * 7.5 + 2}" y="${20 - h / 2}" width="3.5" height="${h}" rx="1.75" />`)
      .join('');
    coverHTML =
      `<div class="cover audio-cover" aria-hidden="true">` +
      `<svg class="wave" viewBox="0 0 120 40">${rects}</svg></div>`;
  } else if (kind === 'video') {
    // Posterless-video cover: a flat horizontal filmstrip (body + perforations
    // + frame windows) cut via mask, then rotated and oversized so it fills the
    // cover diagonally — the rest is the aurora gradient showing through the
    // perforation/frame cutouts. Mask ids scoped by entry.id.
    const m = `fm-${esc(entry.id)}`;
    // Perforations: 10×10 squares with slight corner radius, every 20 units
    // along top and bottom edges of the strip.
    let perfs = '';
    for (let x = 5; x <= 585; x += 20) {
      perfs += `<rect x="${x}" y="4" width="10" height="10" rx="1.5" fill="black" />`;
      perfs += `<rect x="${x}" y="86" width="10" height="10" rx="1.5" fill="black" />`;
    }
    // 6 rounded frame windows down the middle.
    const frames = [5, 105, 205, 305, 405, 505]
      .map((x) => `<rect x="${x}" y="22" width="90" height="56" rx="5" fill="black" />`)
      .join('');
    coverHTML =
      `<div class="cover video-cover" aria-hidden="true">` +
      `<svg class="film-mark" viewBox="0 0 600 100">` +
        `<mask id="${m}">` +
          `<rect width="600" height="100" fill="white" />${perfs}${frames}` +
        `</mask>` +
        `<rect width="600" height="100" fill="currentColor" mask="url(#${m})" />` +
      `</svg>` +
      `</div>`;
  }

  const chips: string[] = [];
  if (photoCount > 1) chips.push(`<span class="chip">◳ ${photoCount} photos</span>`);
  if (firstVideo && kind !== 'video') chips.push(`<span class="chip">▶ video</span>`);
  if (hasAudio && kind !== 'audio') chips.push(`<span class="chip">♪ audio</span>`);
  const chipsHTML = chips.length ? `<p class="chips">${chips.join('')}</p>` : '';

  return (
    `<a class="card kind-${kind}" href="/memory/${esc(entry.id)}">${coverHTML}` +
    `<div class="body">` +
    (entry.title ? `<h2>${esc(entry.title)}</h2>` : '') +
    `<p class="byline">${esc(entry.author.name)}</p>` +
    `${excerptHTML}${chipsHTML}` +
    `</div></a>`
  );
}

// A display label for one audio track: its ID3 title when tagged, otherwise a
// human-readable name recovered from the upload key. Backend keys are always
// "<6-char random hash>-<slug>.<ext>" (see the presign handler in
// capture/lambda.mjs), so drop that leading hash token and the extension, then
// de-slug the rest. This guarantees distinct labels even for a batch of untagged
// files sharing one post.
function audioTitle(m: MediaItem): string {
  if (m.title && m.title.trim()) return m.title.trim();
  const file = (m.src.split('/').pop() || m.src).replace(/\.[^.]+$/, '');
  const named = file.replace(/^[a-z0-9]{6}-(?=.)/i, '');
  const words = named.replace(/[-_]+/g, ' ').trim();
  return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Audio';
}

// ── Multi-track audio playlist ───────────────────────────────────────────────
// Group a post's audio attachments into ONE dark-themed player that reads as a
// single card: a custom transport bar (play/pause, now-playing title, seek,
// time) sits above a labeled track list, sharing the same surface. We drive a
// controls-less <audio> ourselves rather than showing the native player, whose
// light OS chrome never blends with the dark card. Each row keeps an
// always-visible native download link (<a download> — preserves saving the
// original file; works on Android, and a long-press saves to Files on iOS).
// The markup ships without a chosen source; attachAudioPlaylist() (src/lib/audio.ts)
// loads the first track and wires the transport + rows once it's in the DOM.
export function audioPlaylistHTML(items: MediaItem[]): string {
  const playSvg = `<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>`;
  const pauseSvg = `<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></svg>`;
  const dlSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10m0 0l-4-4m4 4l4-4M5 20h14" /></svg>`;
  const rows = items
    .map((m, i) => {
      const label = audioTitle(m);
      const sub = (m.artist && m.artist.trim()) || m.caption || '';
      const subHTML = sub ? `<span class="track-sub">${esc(sub)}</span>` : '';
      return (
        `<li class="track" data-track data-src="${esc(m.src)}" data-title="${esc(label)}">` +
        `<button type="button" class="track-play" data-play aria-label="Play ${esc(label)}">` +
        `<span class="track-num" aria-hidden="true">${i + 1}</span>` +
        `<span class="track-eq" aria-hidden="true"><i></i><i></i><i></i></span>` +
        `<span class="track-meta"><span class="track-title">${esc(label)}</span>${subHTML}</span>` +
        `</button>` +
        `<a class="track-dl" href="${esc(m.src)}" download aria-label="Download ${esc(label)}">${dlSvg}</a>` +
        `</li>`
      );
    })
    .join('');
  return (
    `<figure class="media audio-playlist" data-audio-playlist>` +
    `<audio preload="none"></audio>` +
    `<div class="ap-bar">` +
    `<button type="button" class="ap-toggle" data-toggle aria-label="Play">${playSvg}${pauseSvg}</button>` +
    `<div class="ap-body">` +
    `<div class="ap-top"><span class="ap-title" data-nowtitle></span><span class="ap-time" data-time>0:00 / 0:00</span></div>` +
    `<input type="range" class="ap-seek" data-seek min="0" max="1000" value="0" step="1" aria-label="Seek" />` +
    `</div>` +
    `</div>` +
    `<ol class="tracks">${rows}</ol>` +
    `</figure>`
  );
}

// ── A single media attachment (mirrors Media.astro) ──────────────────────────
export function mediaHTML(m: MediaItem): string {
  let inner = '';
  if (m.type === 'image') inner = `<img src="${esc(m.src)}" alt="${esc(m.alt ?? m.caption ?? '')}" loading="lazy" />`;
  else if (m.type === 'audio') inner = `<audio controls preload="none" src="${esc(m.src)}"></audio>`;
  else if (m.type === 'video') inner = videoTag(m);
  const cap = m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : '';
  return `<figure class="media">${inner}${cap}</figure>`;
}

// Date the memory happened — past only, formatted in UTC so a date-only value
// doesn't slip to the previous day in the local zone.
export function dateLabel(memoryDate?: string): string {
  if (!memoryDate) return '';
  const d = new Date(memoryDate);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// A lead image that's markedly portrait or low-resolution looks poor as a
// full-bleed banner — the banner crops tall images and upscales small ones into
// blur. In those cases we skip the banner and render the image inline in the
// body like any other attachment. Decided client-side from the loaded image's
// natural dimensions, since no size metadata is stored.
const LEAD_TALL_RATIO = 1.2;        // height/width above this → treat as tall
const LEAD_MIN_BANNER_WIDTH = 1000; // natural width below this → treat as low-res
export function shouldInlineLeadImage(width: number, height: number): boolean {
  if (!width || !height) return false; // unknown dimensions → keep the banner
  return height / width > LEAD_TALL_RATIO || width < LEAD_MIN_BANNER_WIDTH;
}

// ── Single post (mirrors memory/[id].astro) ──────────────────────────────────
// The visual lead becomes a full-bleed banner above the title; an audio lead —
// or a tall/low-res image lead (inlineLead) — stays inline above the text
// instead. Remaining media follow the body. `inlineLead` is set by the caller
// after measuring the lead image (see shouldInlineLeadImage).
export function bannerHTML(entry: Entry, inlineLead = false): string {
  const lead = (entry.media ?? [])[0];
  if (!lead) return '';
  // Video always banners; an image banners unless the caller demoted it inline.
  const isBanner = lead.type === 'video' || (lead.type === 'image' && !inlineLead);
  if (!isBanner) return '';
  const m =
    lead.type === 'image'
      ? `<img src="${esc(lead.src)}" alt="${esc(lead.alt ?? lead.caption ?? '')}" />`
      : videoTag(lead);
  const cap = lead.caption ? `<p class="banner-caption">${esc(lead.caption)}</p>` : '';
  return `<div class="post-banner">${m}${cap}</div>`;
}

export function postContentHTML(entry: Entry, inlineLead = false): string {
  const media = entry.media ?? [];
  const lead = media[0];
  // Mirror bannerHTML: an inlined image lead is NOT a banner, so it falls
  // through to the inline render below alongside audio leads.
  const hasBanner = !!lead && (lead.type === 'video' || (lead.type === 'image' && !inlineLead));
  // Two or more audio clips collapse into a single playlist (rendered once,
  // under the byline). A lone clip keeps the bare inline player it's always had.
  const audioItems = media.filter((m) => m.type === 'audio');
  const isPlaylist = audioItems.length >= 2;
  const paragraphs = (entry.body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const dl = dateLabel(entry.memoryDate);
  const rel = entry.author.relationship ? `<span> · Kristin's ${esc(entry.author.relationship.toLowerCase())}</span>` : '';
  const date = dl ? `<span class="date"> · Remembering ${esc(dl)}</span>` : '';

  let html = '';
  // A tall/low-res image lead (demoted from the banner) still leads the page,
  // above the title — keeping the "photo at the top" feel, just rendered inline
  // and uncropped like any other body image rather than as a full-bleed banner.
  if (!hasBanner && lead?.type === 'image') html += mediaHTML(lead);
  if (entry.title) html += `<h1>${esc(entry.title)}</h1>`;
  html += `<p class="byline">Shared by ${esc(entry.author.name)}${rel}${date}</p>`;
  // Audio sits inline just under the byline (no banner for audio): a playlist
  // when there are several, or a single bare player for one lead clip.
  if (isPlaylist) html += audioPlaylistHTML(audioItems);
  else if (!hasBanner && lead?.type === 'audio') html += mediaHTML(lead);
  html += `<article>${paragraphs.map((p) => `<p>${linkify(p)}</p>`).join('')}</article>`;
  // Trailing media after the body. When the audio became a playlist it's already
  // rendered above, so drop the audio items from the inline flow.
  const trailing = media.slice(1).filter((m) => !(isPlaylist && m.type === 'audio'));
  html += trailing.map(mediaHTML).join('');
  return html;
}

// ── Reflections (contributions others add to a memory) ───────────────────────
export interface Reflection {
  id: string;
  author: { name: string };
  body?: string;
  media?: MediaItem[];
  createdAt?: string; // stored for ordering; not displayed
}

export function reflectionHTML(r: Reflection): string {
  const paragraphs = (r.body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const body = paragraphs.length
    ? `<div class="reflection-body">${paragraphs.map((p) => `<p>${linkify(p)}</p>`).join('')}</div>`
    : '';
  const media = (r.media || []).map(mediaHTML).join('');
  return (
    `<article class="reflection" data-id="${esc(r.id)}">` +
    `<div class="reflection-head">` +
    `<p class="byline">${esc(r.author?.name || '')} posted</p>` +
    `<button type="button" class="reflection-del" hidden>Delete</button>` +
    `</div>` +
    body + media +
    `</article>`
  );
}
