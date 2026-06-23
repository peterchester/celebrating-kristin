// Allowlist HTML sanitizer for the admin-authored /together page body.
//
// The rest of the site escapes every user value (see render.ts esc()), because
// it's untrusted submissions. The /together body is different: only the
// authenticated admin can write it, and we WANT real HTML (headings, lists,
// tables, links, images, basic formatting). So instead of escaping, we sanitize
// against an allowlist — keeping a rich, useful subset while stripping anything
// that could run code or hijack the page (scripts, iframes, event handlers,
// javascript: URLs, etc.). This runs in the browser at render time, which is
// the actual security boundary: it's what decides what gets inserted into the
// live DOM. Parsing happens via DOMParser (inert — no scripts run) and the
// clean tree is rebuilt with createElement/setAttribute (also inert).

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'blockquote', 'q', 'cite', 'abbr', 'address', 'time', 'wbr',
  'pre', 'code', 'kbd', 'samp', 'var',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'img', 'figure', 'figcaption', 'picture', 'source',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'details', 'summary',
]);

// Dropped element AND its contents — never unwrapped, since their text/children
// are part of the threat (or meaningless without execution).
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'noscript', 'template',
  'svg', 'math', 'link', 'meta', 'base', 'head', 'title', 'input', 'button',
  'textarea', 'select', 'option', 'frame', 'frameset', 'applet', 'audio', 'video',
]);

// Attributes allowed on any element. `style` is allowed but value-filtered below.
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'dir', 'lang', 'align', 'style']);

// Per-tag attributes layered on top of the global set.
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading']),
  source: new Set(['srcset', 'media', 'sizes', 'type']),
  td: new Set(['colspan', 'rowspan', 'headers', 'scope']),
  th: new Set(['colspan', 'rowspan', 'headers', 'scope', 'abbr']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  ol: new Set(['start', 'type', 'reversed']),
  time: new Set(['datetime']),
  details: new Set(['open']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
};

const URL_ATTRS = new Set(['href', 'src']);

// Allow http(s)/mailto/tel and scheme-relative or relative URLs; for images
// also allow data: URLs of raster image types (never svg — it can carry script).
function safeUrl(value: string, isImg: boolean): string | null {
  const v = value.trim();
  if (!v) return null;
  // A scheme is "word chars then a colon" before any /, ?, or #. No such prefix
  // → it's relative (path, query, or #anchor) and safe.
  const m = v.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) return v;
  const scheme = m[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return v;
  if (isImg && scheme === 'data' && /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i.test(v)) return v;
  return null; // javascript:, vbscript:, data:text/html, etc.
}

// Inline style is useful (colors, alignment, spacing) but can be abused. Reject
// the whole declaration if it contains anything that loads external resources,
// runs code, or could be used to overlay/cloak other content off the page.
function safeStyle(value: string): string | null {
  if (/url\s*\(|expression|javascript:|@import|behaviou?r:|position\s*:\s*fixed|<|\\/i.test(value)) return null;
  return value.trim() || null;
}

function copyAttrs(src: Element, dest: HTMLElement, tag: string): void {
  for (const attr of Array.from(src.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) continue; // event handlers — never
    if (!(GLOBAL_ATTRS.has(name) || TAG_ATTRS[tag]?.has(name))) continue;

    const value = attr.value;
    if (URL_ATTRS.has(name)) {
      const safe = safeUrl(value, tag === 'img');
      if (safe) dest.setAttribute(name, safe);
    } else if (name === 'style') {
      const safe = safeStyle(value);
      if (safe) dest.setAttribute('style', safe);
    } else if (name === 'target') {
      dest.setAttribute('target', value === '_blank' ? '_blank' : '_self');
    } else {
      dest.setAttribute(name, value);
    }
  }
  // Harden links: anything opening a new tab (or going off-site) gets noopener
  // so the destination can't reach back via window.opener.
  if (tag === 'a') {
    const href = dest.getAttribute('href') || '';
    if (dest.getAttribute('target') === '_blank' || /^https?:/i.test(href)) {
      dest.setAttribute('rel', 'noopener noreferrer');
    }
  }
  if (tag === 'img') dest.setAttribute('loading', 'lazy');
}

function sanitizeInto(src: Node, dest: HTMLElement): void {
  src.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      dest.appendChild(document.createTextNode(node.nodeValue || ''));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return; // drop comments, etc.
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) return;
    if (!ALLOWED_TAGS.has(tag)) {
      sanitizeInto(el, dest); // unknown but harmless wrapper → keep its children
      return;
    }
    const clean = document.createElement(tag);
    copyAttrs(el, clean, tag);
    sanitizeInto(el, clean);
    dest.appendChild(clean);
  });
}

/** Sanitize an untrusted HTML string into a safe HTML string for innerHTML. */
export function sanitizeHTML(dirty: string): string {
  if (!dirty) return '';
  const doc = new DOMParser().parseFromString(dirty, 'text/html');
  const out = document.createElement('div');
  sanitizeInto(doc.body, out);
  return out.innerHTML;
}
