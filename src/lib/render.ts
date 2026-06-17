// Client-side renderers. They build the SAME markup the Astro components
// (MemoryCard / Media / the post page) produce at build time, so memories
// fetched at runtime look identical. Every user-supplied value is run through
// esc() so submitted text can never inject HTML/JS into the page.

export interface MediaItem {
  type: 'image' | 'audio' | 'video';
  src: string;
  poster?: string;
  caption?: string;
  alt?: string;
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
  const excerpt = truncate(firstPara, kind === 'text' ? 320 : 180);
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
      `<svg class="wave" viewBox="0 0 120 40" preserveAspectRatio="none">${rects}</svg>` +
      `<span class="badge">♪ Audio</span></div>`;
  }

  const chips: string[] = [];
  if (photoCount > 1) chips.push(`<span class="chip">◳ ${photoCount} photos</span>`);
  if (firstVideo) chips.push(`<span class="chip">▶ video</span>`);
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

// ── A single media attachment (mirrors Media.astro) ──────────────────────────
export function mediaHTML(m: MediaItem): string {
  let inner = '';
  if (m.type === 'image') inner = `<img src="${esc(m.src)}" alt="${esc(m.alt ?? m.caption ?? '')}" loading="lazy" />`;
  else if (m.type === 'audio') inner = `<audio controls preload="none" src="${esc(m.src)}"></audio>`;
  else if (m.type === 'video')
    inner = `<video controls preload="metadata" playsinline src="${esc(m.src)}"${m.poster ? ` poster="${esc(m.poster)}"` : ''}></video>`;
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

// ── Single post (mirrors memory/[id].astro) ──────────────────────────────────
// The visual lead (image or video) becomes a full-bleed banner above the title;
// an audio lead stays inline above the text. Remaining media follow the body.
export function bannerHTML(entry: Entry): string {
  const lead = (entry.media ?? [])[0];
  if (!lead || (lead.type !== 'image' && lead.type !== 'video')) return '';
  const m =
    lead.type === 'image'
      ? `<img src="${esc(lead.src)}" alt="${esc(lead.alt ?? lead.caption ?? '')}" />`
      : `<video src="${esc(lead.src)}"${lead.poster ? ` poster="${esc(lead.poster)}"` : ''} controls playsinline preload="metadata"></video>`;
  const cap = lead.caption ? `<p class="banner-caption">${esc(lead.caption)}</p>` : '';
  return `<div class="post-banner">${m}${cap}</div>`;
}

export function postContentHTML(entry: Entry): string {
  const media = entry.media ?? [];
  const lead = media[0];
  const hasBanner = !!lead && (lead.type === 'image' || lead.type === 'video');
  const paragraphs = (entry.body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const dl = dateLabel(entry.memoryDate);
  const rel = entry.author.relationship ? `<span> · Kristin's ${esc(entry.author.relationship.toLowerCase())}</span>` : '';
  const date = dl ? `<span class="date"> · Remembering ${esc(dl)}</span>` : '';

  let html = '';
  if (entry.title) html += `<h1>${esc(entry.title)}</h1>`;
  html += `<p class="byline">Shared by ${esc(entry.author.name)}${rel}${date}</p>`;
  if (!hasBanner && lead) html += mediaHTML(lead);
  html += `<article>${paragraphs.map((p) => `<p>${linkify(p)}</p>`).join('')}</article>`;
  html += media.slice(1).map(mediaHTML).join('');
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
