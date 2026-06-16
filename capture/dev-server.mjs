// Local mock of the capture backend — lets you test the full submit loop
// WITHOUT AWS. It mimics the two endpoints the form expects:
//
//   POST /presign  → { url, key }   (where to upload a file)
//   PUT  /upload   → saves bytes to public/media/   (stands in for S3)
//   POST /submit   → writes one entry JSON to src/content/entries/
//
// The real AWS version will expose the same /presign and /submit contract, so
// the form code never has to change. This file is for local dev only.
//
//   node capture/dev-server.mjs      (then run `npm run dev` in another terminal)
//
// Uses only Node built-ins — no dependencies to install.

import { createServer } from 'node:http';
import { mkdir, writeFile, appendFile, readFile, readdir, unlink, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
// The site reads memories at runtime from /data/index.json and /entries/<id>.json,
// so the mock writes them under public/ (served by the dev server at those paths) —
// mirroring what the AWS Lambda writes to S3. Both are gitignored local artifacts.
const ENTRIES = join(PUBLIC, 'entries');
const DATA_DIR = join(PUBLIC, 'data');
const INDEX = join(DATA_DIR, 'index.json');
const PRIVATE = join(ROOT, 'capture', 'private'); // emails, edit tokens — gitignored, never published
const TOKENS = join(PRIVATE, 'tokens.json'); // { entryId: sha256(editToken) }
const PORT = 8787;

// Set RK_ADMIN_TOKEN to enable admin override (edit/delete ANY entry).
//   RK_ADMIN_TOKEN="some-long-secret" npm run capture
const ADMIN = process.env.RK_ADMIN_TOKEN || '';

// Cloudflare Turnstile secret. When set, /submit verifies the widget token with
// Cloudflare; when empty, the check is skipped (dev/preview). Test secrets:
//   1x000…AA always passes, 2x000…AA always fails.
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const send = (res, code, body, type = 'application/json') =>
  res.writeHead(code, { ...CORS, 'content-type': type }).end(typeof body === 'string' ? body : JSON.stringify(body));

const readBody = (req) =>
  new Promise((ok, err) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', err);
  });

const slug = (s) =>
  (s || 'anon').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 40) || 'anon';

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

// The entry id IS the URL slug — clean and human, from the title (or author as a
// fallback when there's no title). Add -2, -3, … only to avoid colliding with an
// existing entry. No date, no random. Fixed at creation, so editing a title later
// never changes the URL.
const uniqueEntryId = async (base) => {
  base = base || 'memory';
  let id = base, n = 2;
  while (await exists(join(ENTRIES, `${id}.json`))) id = `${base}-${n++}`;
  return id;
};

// Only allow keys under /media/, no traversal. Returns a safe absolute path.
const safeMediaPath = (key) => {
  if (typeof key !== 'string' || !key.startsWith('/media/') || key.includes('..')) return null;
  const abs = join(PUBLIC, key);
  return abs.startsWith(join(PUBLIC, 'media')) ? abs : null;
};

// Entry ids are filename-safe slugs only — block path traversal.
const safeEntryPath = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) ? join(ENTRIES, `${id}.json`) : null;

const sha = (t) => createHash('sha256').update(String(t)).digest('hex');
const eq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loadTokens = async () => {
  try { return JSON.parse(await readFile(TOKENS, 'utf8')); } catch { return {}; }
};
const saveTokens = async (o) => {
  await mkdir(PRIVATE, { recursive: true });
  await writeFile(TOKENS, JSON.stringify(o, null, 2) + '\n');
};
const isAdmin = (t) => !!ADMIN && typeof t === 'string' && eq(t, ADMIN);

// Verify a Cloudflare Turnstile token server-side. Skipped if no secret is set.
const verifyTurnstile = async (token, ip) => {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    return (await res.json())?.success === true;
  } catch {
    return false;
  }
};

// Memory dates may be any date in the past, but never the future (a future date
// is treated as an error and dropped). Returns YYYY-MM-DD or null.
const validMemoryDate = (v, now = new Date()) => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime()) || d.getTime() > now.getTime()) return null;
  return v.slice(0, 10);
};

// True if the caller owns this entry (valid edit token) or is the admin.
const authorize = async (id, token, adminToken) => {
  if (isAdmin(adminToken)) return true;
  if (!token) return false;
  const want = (await loadTokens())[id];
  return !!want && eq(sha(token), want);
};

// Rebuild public/data/index.json (the list the site reads) from the entry files,
// mirroring the Lambda. Called after every change and on startup, so hand-added
// entry files get picked up too.
const rebuildIndex = async () => {
  await mkdir(DATA_DIR, { recursive: true });
  let files = [];
  try { files = (await readdir(ENTRIES)).filter((f) => f.endsWith('.json')); } catch {}
  const out = [];
  for (const f of files) {
    try {
      const entry = JSON.parse(await readFile(join(ENTRIES, f), 'utf8'));
      if (entry.status !== 'hidden') out.push({ id: f.slice(0, -5), ...entry });
    } catch {}
  }
  out.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  await writeFile(INDEX, JSON.stringify(out, null, 2) + '\n');
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (req.method === 'POST' && url.pathname === '/presign') {
      const { filename, contentType } = JSON.parse((await readBody(req)).toString() || '{}');
      const rand = Math.random().toString(36).slice(2, 8);
      const key = `/media/u/${rand}-${slug(filename?.replace(/\.[^.]+$/, ''))}${(filename?.match(/\.[^.]+$/) || [''])[0]}`;
      // In AWS this would be a presigned S3 PUT URL; locally it's our own /upload.
      return send(res, 200, { url: `http://localhost:${PORT}/upload?key=${encodeURIComponent(key)}`, key, contentType });
    }

    if (req.method === 'PUT' && url.pathname === '/upload') {
      const abs = safeMediaPath(url.searchParams.get('key'));
      if (!abs) return send(res, 400, { error: 'bad key' });
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, await readBody(req));
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/submit') {
      const s = JSON.parse((await readBody(req)).toString() || '{}');
      if (!s?.author?.name || !s?.body) return send(res, 400, { error: 'name and memory are required' });
      if (!(await verifyTurnstile(s.turnstileToken, req.socket?.remoteAddress)))
        return send(res, 403, { error: 'verification failed' });

      const now = new Date();
      const id = await uniqueEntryId(s.title ? slug(s.title) : slug(s.author.name));

      const { email, memoryDate, turnstileToken, ...rest } = s; // private/transient fields never stored
      const entry = { ...rest, submittedAt: now.toISOString(), status: 'published' };
      const md = validMemoryDate(memoryDate, now); // future/invalid dates are dropped
      if (md) entry.memoryDate = md;

      await mkdir(ENTRIES, { recursive: true });
      await writeFile(join(ENTRIES, `${id}.json`), JSON.stringify(entry, null, 2) + '\n');

      // Issue a per-entry edit token; store only its hash. The token goes back to
      // the contributor's browser (cookie) so they can later edit/delete this entry.
      const editToken = randomBytes(16).toString('hex');
      const tokens = await loadTokens();
      tokens[id] = sha(editToken);
      await saveTokens(tokens);

      if (email) {
        await mkdir(PRIVATE, { recursive: true });
        await appendFile(join(PRIVATE, 'contacts.jsonl'), JSON.stringify({ id, name: s.author.name, email }) + '\n');
      }

      await rebuildIndex();
      console.log(`✓ saved entry ${id}${s.media?.length ? ` (+${s.media.length} media)` : ''}`);
      return send(res, 200, { ok: true, id, editToken });
    }

    if (req.method === 'POST' && url.pathname === '/update') {
      const { id, token, adminToken, name, relationship, title, body, memoryDate } = JSON.parse((await readBody(req)).toString() || '{}');
      const file = safeEntryPath(id);
      if (!file) return send(res, 400, { error: 'bad id' });
      if (!(await authorize(id, token, adminToken))) return send(res, 403, { error: 'not allowed' });

      let entry;
      try { entry = JSON.parse(await readFile(file, 'utf8')); } catch { return send(res, 404, { error: 'no such entry' }); }
      if (typeof body === 'string' && body.trim()) entry.body = body.trim();
      if (typeof name === 'string' && name.trim()) entry.author.name = name.trim();
      if (typeof title === 'string') entry.title = title.trim() || undefined; // '' removes it
      if (typeof relationship === 'string') entry.author.relationship = relationship.trim() || undefined;
      if (memoryDate === '') delete entry.memoryDate; // cleared
      else if (typeof memoryDate === 'string') { const md = validMemoryDate(memoryDate); if (md) entry.memoryDate = md; }
      entry.editedAt = new Date().toISOString();
      await writeFile(file, JSON.stringify(entry, null, 2) + '\n');

      await rebuildIndex();
      console.log(`✎ updated entry ${id}${isAdmin(adminToken) ? ' (admin)' : ''}`);
      return send(res, 200, { ok: true, id });
    }

    if (req.method === 'POST' && url.pathname === '/delete') {
      const { id, token, adminToken } = JSON.parse((await readBody(req)).toString() || '{}');
      const file = safeEntryPath(id);
      if (!file) return send(res, 400, { error: 'bad id' });
      if (!(await authorize(id, token, adminToken))) return send(res, 403, { error: 'not allowed' });

      let entry = null;
      try { entry = JSON.parse(await readFile(file, 'utf8')); } catch {}
      await unlink(file).catch(() => {});
      for (const m of entry?.media ?? []) { // remove this entry's uploaded media too
        const mp = safeMediaPath(m.src);
        if (mp) await unlink(mp).catch(() => {});
      }
      const tokens = await loadTokens();
      delete tokens[id];
      await saveTokens(tokens);

      await rebuildIndex();
      console.log(`✗ deleted entry ${id}${isAdmin(adminToken) ? ' (admin)' : ''}`);
      return send(res, 200, { ok: true, id });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, async () => {
  await rebuildIndex(); // pick up any hand-added entry files on startup
  console.log(`Capture mock running → http://localhost:${PORT}`);
  console.log('Submissions are written to public/entries/ + public/data/index.json — the dev site reads them live.');
});
