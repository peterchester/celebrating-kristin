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
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const ENTRIES = join(ROOT, 'src', 'content', 'entries');
const PRIVATE = join(ROOT, 'capture', 'private'); // emails etc. — gitignored, never published
const PORT = 8787;

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

// Only allow keys under /media/, no traversal. Returns a safe absolute path.
const safeMediaPath = (key) => {
  if (typeof key !== 'string' || !key.startsWith('/media/') || key.includes('..')) return null;
  const abs = join(PUBLIC, key);
  return abs.startsWith(join(PUBLIC, 'media')) ? abs : null;
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

      const now = new Date();
      const id = `${now.toISOString().slice(0, 10)}-${slug(s.author.name)}-${Math.random().toString(36).slice(2, 6)}`;

      const { email, ...rest } = s; // email stays private, never in the public entry
      const entry = { ...rest, submittedAt: now.toISOString(), status: 'published' };

      await mkdir(ENTRIES, { recursive: true });
      await writeFile(join(ENTRIES, `${id}.json`), JSON.stringify(entry, null, 2) + '\n');

      if (email) {
        await mkdir(PRIVATE, { recursive: true });
        await appendFile(join(PRIVATE, 'contacts.jsonl'), JSON.stringify({ id, name: s.author.name, email }) + '\n');
      }

      console.log(`✓ saved entry ${id}${s.media?.length ? ` (+${s.media.length} media)` : ''}`);
      return send(res, 200, { ok: true, id });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Capture mock running → http://localhost:${PORT}`);
  console.log('New submissions appear in src/content/entries/ — the dev site hot-reloads them.');
});
