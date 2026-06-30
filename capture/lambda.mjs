// AWS Lambda capture backend for Celebrating Kristin.
//
// This is the production sibling of capture/dev-server.mjs — same contract,
// same logic, but it stores everything in S3 instead of the local filesystem.
// It runs behind a Lambda Function URL. Routes (all POST):
//
//   /presign  -> { url, key }   presigned S3 PUT URL for one media file
//   /submit   -> writes entries/<id>.json (+ media already uploaded) and issues
//                a per-entry edit token
//   /update   -> edit an entry (owner token or admin)
//   /delete   -> delete an entry and its uploaded media
//
// The browser uploads media bytes DIRECTLY to S3 via the presigned URL, so big
// videos never pass through the function. Public memory JSON + media live in the
// site bucket (served by CloudFront). Edit-token hashes and contact emails live
// in a separate PRIVATE bucket the function alone can read.
//
// Uses only the AWS SDK v3 that ships with the Lambda Node runtime — no deps.

import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
  DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// requestChecksumCalculation: 'WHEN_REQUIRED' stops the SDK from baking a default
// CRC32 integrity checksum into presigned PUT URLs. A browser fetch() PUT can't
// reproduce that checksum, so with the SDK default (WHEN_SUPPORTED) S3 rejects the
// upload with 403. WHEN_REQUIRED omits it for PutObject, which doesn't need it.
const s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
const ses = new SESClient({});
const SITE = process.env.SITE_BUCKET;          // public bucket (entries + media)
const PRIV = process.env.PRIVATE_BUCKET;       // private bucket (tokens + emails)
const ADMIN = process.env.ADMIN_TOKEN || '';   // optional admin override
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || ''; // optional captcha
const NOTIFY_FROM = process.env.NOTIFY_FROM || '';          // SES sender; blank = no emails
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, ''); // for links in emails
const EMAIL_ADDRESS = process.env.EMAIL_ADDRESS || '';      // inbound address for reply-to (reply = reflection)

const ENTRIES = 'entries/';        // entries/<id>.json  (public)
const COMMENTS = 'comments/';      // comments/<entryId>.json — array of reflections (public)
const INDEX = 'data/index.json';   // the list the site reads (public, derived)
const TOGETHER = 'data/together.json'; // admin-editable /together page (public)
const TOKENS = 'tokens.json';      // { id: sha256(editToken) }  (private)
const CONTACTS = 'contacts.jsonl'; // one {id,name,email} per line (private)
const NO_CACHE = 'public, max-age=0, must-revalidate'; // so new data shows at once

const json = (code, body) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const slug = (s) =>
  (s || 'anon').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').slice(0, 40) || 'anon';
const sha = (t) => createHash('sha256').update(String(t)).digest('hex');
const eq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ADMIN_HASH = ADMIN ? sha(ADMIN) : '';
const isAdmin = (t) => !!ADMIN_HASH && typeof t === 'string' && eq(t, ADMIN_HASH);
const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);

// ── S3 helpers ───────────────────────────────────────────────────────────────
async function getJson(bucket, key, fallback) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return fallback;
    throw e;
  }
}
async function getText(bucket, key, fallback) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await r.Body.transformToString();
  } catch (e) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return fallback;
    throw e;
  }
}
const putJson = (bucket, key, obj) =>
  s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: JSON.stringify(obj, null, 2) + '\n',
    ContentType: 'application/json', CacheControl: NO_CACHE,
  }));
const putText = (bucket, key, text) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: text, ContentType: 'text/plain' }));
async function exists(bucket, key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch { return false; }
}

// The entry id IS the URL slug — title (or author fallback), with -2/-3 only to
// avoid colliding with an existing entry. Assigned once, never changes.
const uniqueEntryId = async (base) => {
  base = base || 'memory';
  let id = base, n = 2;
  while (await exists(SITE, `${ENTRIES}${id}.json`)) id = `${base}-${n++}`;
  return id;
};

const loadTokens = () => getJson(PRIV, TOKENS, {});
const saveTokens = (o) => putJson(PRIV, TOKENS, o);

const authorize = async (id, token, adminToken) => {
  if (isAdmin(adminToken)) return true;
  if (!token) return false;
  const want = (await loadTokens())[id];
  return !!want && eq(sha(token), want);
};

// Verify a Cloudflare Turnstile token. Skipped when no secret is configured.
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
  } catch { return false; }
};

// Memory dates: any past date, never the future. Returns YYYY-MM-DD or null.
const validMemoryDate = (v, now = new Date()) => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime()) || d.getTime() > now.getTime()) return null;
  return v.slice(0, 10);
};

// data/index.json is a derived cache the site reads to render the gallery. We
// rebuild it from the canonical entries/ objects after every change, so it can
// never drift out of sync. Hidden entries are excluded; newest first.
async function rebuildIndex() {
  const out = [];
  let token;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: SITE, Prefix: ENTRIES, ContinuationToken: token }));
    for (const o of list.Contents || []) {
      if (!o.Key.endsWith('.json')) continue;
      const id = o.Key.slice(ENTRIES.length, -'.json'.length);
      const entry = await getJson(SITE, o.Key, null);
      if (entry && entry.status !== 'hidden') out.push({ id, ...entry });
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  out.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  await putJson(SITE, INDEX, out);
}

// media[].src is a public path like "/media/u/xxx"; the S3 key drops the slash.
const mediaKey = (src) =>
  typeof src === 'string' && src.startsWith('/media/') && !src.includes('..') ? src.slice(1) : null;

// Delete every object under a key prefix (used to clear a video's media/hls/<vid>/
// directory). No-op on a missing/empty prefix.
async function deletePrefix(prefix) {
  if (!prefix) return;
  let token;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: SITE, Prefix: prefix, ContinuationToken: token }));
    const objs = (list.Contents || []).map((o) => ({ Key: o.Key }));
    if (objs.length) await s3.send(new DeleteObjectsCommand({ Bucket: SITE, Delete: { Objects: objs } }));
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}

// Remove all S3 objects backing one media item: the file(s) it references plus,
// for a transcoded video, the whole media/hls/<vid>/ output directory.
async function deleteMediaObjects(m) {
  for (const src of [m?.src, m?.original, m?.poster]) {
    const k = mediaKey(src);
    if (k) await s3.send(new DeleteObjectCommand({ Bucket: SITE, Key: k })).catch(() => {});
  }
  const hlsKey = mediaKey(m?.hls); // e.g. media/hls/<vid>/index.m3u8
  if (hlsKey) await deletePrefix(hlsKey.slice(0, hlsKey.lastIndexOf('/') + 1)).catch(() => {});
}

// Kick off a MediaConvert HLS job for every video in a freshly-stored entry or
// reflection. Each video's master sits at media/originals/…; we mint a per-video
// output id (vid) and tag the job (via UserMetadata) so the transcode-complete
// Lambda can patch the right media item. Best-effort: a failed submission leaves
// the clip playing progressively (processing stays true) instead of failing the
// whole request.
async function startTranscodes(media, meta) {
  if (!Array.isArray(media) || !media.some((m) => m?.type === 'video')) return;

  // Load the MediaConvert helper lazily and defensively: if its SDK client isn't
  // available in the runtime, transcoding is skipped (videos still play
  // progressively from src) rather than crashing the whole capture function.
  let submitTranscode;
  try {
    ({ submitTranscode } = await import('./mediaconvert.mjs'));
  } catch (e) {
    console.error('MediaConvert unavailable — leaving videos un-transcoded', e);
    return;
  }

  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    if (m?.type !== 'video') continue;
    const inputKey = mediaKey(m.src);
    if (!inputKey) continue;
    const vid = randomBytes(6).toString('hex');
    try {
      await submitTranscode({
        bucket: SITE,
        inputKey,
        vid,
        userMetadata: { ...meta, mediaIndex: String(i), vid },
      });
    } catch (e) {
      console.error('transcode submit failed', e);
    }
  }
}

// Look up the memory author's email from the private contacts log (last wins).
async function authorEmail(entryId) {
  const text = await getText(PRIV, CONTACTS, '');
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const c = JSON.parse(line); if (c.id === entryId && c.email) found = c; } catch {}
  }
  return found; // { id, name, email } | null
}

// Best-effort email to the memory's author when someone adds a reflection.
// Silently does nothing if SES isn't configured or the author left no email.
async function notifyAuthor(entryId, reflectorName) {
  if (!NOTIFY_FROM) return;
  const to = await authorEmail(entryId);
  if (!to?.email) return;
  const entry = await getJson(SITE, `${ENTRIES}${entryId}.json`, null);
  const title = entry?.title || 'your memory';
  const link = SITE_URL ? `${SITE_URL}/memory/${entryId}` : '';
  const canReply = !!EMAIL_ADDRESS;
  const body =
    `Hi ${to.name || ''},\n\n` +
    `${reflectorName} just added a reflection to "${title}" on Celebrating Kristin.\n\n` +
    (link ? `Read it here:\n${link}\n\n` : '') +
    (canReply ? `You can reply to this email to add your own reflection.\n\n` : '') +
    `With love,\nCelebrating Kristin`;
  // The [ref:<id>] tag lets a reply be routed back to this memory as a reflection.
  const subject = `${reflectorName} added a reflection to "${title}"` + (canReply ? ` [ref:${entryId}]` : '');
  await ses.send(new SendEmailCommand({
    Source: NOTIFY_FROM,
    Destination: { ToAddresses: [to.email] },
    ...(canReply ? { ReplyToAddresses: [EMAIL_ADDRESS] } : {}),
    Message: {
      Subject: { Data: subject },
      Body: { Text: { Data: body } },
    },
  }));
}

// ── Handler ──────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || 'GET';
  const path = event?.rawPath || '/';
  const ip = event?.requestContext?.http?.sourceIp;

  let s = {};
  if (event?.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try { s = JSON.parse(raw || '{}'); } catch { s = {}; }
  }

  try {
    // Lets the /admin page confirm a token is valid before saving it (and reject
    // a wrong one), instead of the user only finding out when an edit/delete
    // later 403s. Reveals nothing a /delete attempt wouldn't, and the compare is
    // constant-time. Note: this is an unauthenticated validity oracle — fine
    // given the token's entropy, but don't shorten the token.
    if (method === 'POST' && path === '/admin-check') {
      return isAdmin(s.adminToken) ? json(200, { ok: true }) : json(403, { error: 'not allowed' });
    }

    // Save the admin-editable /together page (alert bar text + title + HTML body).
    // Admin only. Written as a public JSON file the site reads at runtime; the
    // body's HTML is sanitized in the browser at render time, not here.
    if (method === 'POST' && path === '/page') {
      if (!isAdmin(s.adminToken)) return json(403, { error: 'not allowed' });
      const page = {
        alert: String(s.alert ?? '').trim(),
        title: String(s.title ?? '').trim(),
        body: String(s.body ?? ''),
      };
      await putJson(SITE, TOGETHER, page);
      return json(200, { ok: true });
    }

    if (method === 'POST' && path === '/presign') {
      const { filename, contentType, kind } = s;
      const rand = randomBytes(3).toString('hex');
      const base = slug(String(filename || '').replace(/\.[^.]+$/, ''));
      const ext = (String(filename || '').match(/\.[^.]+$/) || [''])[0];
      // kind:'original' stashes the untouched upload under media/originals/ so
      // the optimized version (default kind) at media/u/ is what the site shows.
      const prefix = kind === 'original' ? 'media/originals/' : 'media/u/';
      const key = `${prefix}${rand}-${base}${ext}`;
      // Sign only Content-Type (the browser sends it on PUT); CloudFront caches.
      // 1-hour expiry, not 5 minutes: large video masters can take a while to
      // upload, and the URL must stay valid for the whole transfer or S3 returns
      // 403 (expired). Note: a single PUT still can't exceed S3's 5 GiB limit —
      // the client rejects oversized files before requesting a URL.
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: SITE, Key: key, ContentType: contentType || 'application/octet-stream' }),
        { expiresIn: 3600 },
      );
      return json(200, { url, key: `/${key}` });
    }

    if (method === 'POST' && path === '/submit') {
      if (!s?.author?.name) return json(400, { error: 'name is required' });
      if (!s?.body && !(Array.isArray(s.media) && s.media.length))
        return json(400, { error: 'add a memory or at least one photo, video, or audio' });
      if (!(await verifyTurnstile(s.turnstileToken, ip))) return json(403, { error: 'verification failed' });

      const now = new Date();
      const id = await uniqueEntryId(s.title ? slug(s.title) : slug(s.author.name));
      const { email, memoryDate, turnstileToken, ...rest } = s; // private/transient, never stored
      const entry = { ...rest, submittedAt: now.toISOString(), status: 'published' };
      const md = validMemoryDate(memoryDate, now);
      if (md) entry.memoryDate = md;

      await putJson(SITE, `${ENTRIES}${id}.json`, entry);

      const editToken = randomBytes(16).toString('hex');
      const tokens = await loadTokens();
      tokens[id] = sha(editToken);
      await saveTokens(tokens);

      if (email) {
        const prev = await getText(PRIV, CONTACTS, '');
        await putText(PRIV, CONTACTS, prev + JSON.stringify({ id, name: s.author.name, email }) + '\n');
      }

      // Transcode any videos to HLS (best-effort; completion patches the entry).
      await startTranscodes(entry.media, { kind: 'entry', entryId: id });

      await rebuildIndex();
      return json(200, { ok: true, id, editToken });
    }

    if (method === 'POST' && path === '/update') {
      const { id, token, adminToken, name, relationship, title, body, memoryDate } = s;
      if (!safeId(id)) return json(400, { error: 'bad id' });
      if (!(await authorize(id, token, adminToken))) return json(403, { error: 'not allowed' });

      const entry = await getJson(SITE, `${ENTRIES}${id}.json`, null);
      if (!entry) return json(404, { error: 'no such entry' });
      if (typeof body === 'string' && body.trim()) entry.body = body.trim();
      if (typeof name === 'string' && name.trim()) entry.author.name = name.trim();
      if (typeof title === 'string') entry.title = title.trim() || undefined;
      if (typeof relationship === 'string') entry.author.relationship = relationship.trim() || undefined;
      if (memoryDate === '') delete entry.memoryDate;
      else if (typeof memoryDate === 'string') { const md = validMemoryDate(memoryDate); if (md) entry.memoryDate = md; }
      entry.editedAt = new Date().toISOString();

      await putJson(SITE, `${ENTRIES}${id}.json`, entry);
      await rebuildIndex();
      return json(200, { ok: true, id });
    }

    if (method === 'POST' && path === '/delete') {
      const { id, token, adminToken } = s;
      if (!safeId(id)) return json(400, { error: 'bad id' });
      if (!(await authorize(id, token, adminToken))) return json(403, { error: 'not allowed' });

      const entry = await getJson(SITE, `${ENTRIES}${id}.json`, null);
      await s3.send(new DeleteObjectCommand({ Bucket: SITE, Key: `${ENTRIES}${id}.json` })).catch(() => {});
      for (const m of entry?.media ?? []) await deleteMediaObjects(m);
      const tokens = await loadTokens();
      delete tokens[id];
      await saveTokens(tokens);

      await rebuildIndex();
      return json(200, { ok: true, id });
    }

    if (method === 'POST' && path === '/comment') {
      if (!safeId(s.entryId)) return json(400, { error: 'bad entry id' });
      if (!s?.author?.name) return json(400, { error: 'name is required' });
      if (!s?.body && !(Array.isArray(s.media) && s.media.length))
        return json(400, { error: 'add a reflection or a photo, video, or audio' });
      if (!(await verifyTurnstile(s.turnstileToken, ip))) return json(403, { error: 'verification failed' });
      if (!(await exists(SITE, `${ENTRIES}${s.entryId}.json`))) return json(404, { error: 'no such memory' });

      const commentId = randomBytes(8).toString('hex');
      const reflection = {
        id: commentId,
        author: { name: String(s.author.name).trim() },
        ...(s.body ? { body: String(s.body).trim() } : {}),
        ...(Array.isArray(s.media) && s.media.length ? { media: s.media } : {}),
        createdAt: new Date().toISOString(),
      };
      const key = `${COMMENTS}${s.entryId}.json`;
      const list = await getJson(SITE, key, []);
      list.push(reflection);
      await putJson(SITE, key, list);

      // Transcode any videos in the reflection; completion patches this comment.
      await startTranscodes(reflection.media, { kind: 'comment', entryId: s.entryId, commentId });

      const editToken = randomBytes(16).toString('hex');
      const tokens = await loadTokens();
      tokens[`comment:${commentId}`] = sha(editToken);
      await saveTokens(tokens);

      await notifyAuthor(s.entryId, reflection.author.name).catch((e) => console.error('notify failed', e));
      return json(200, { ok: true, id: commentId, editToken });
    }

    if (method === 'POST' && path === '/comment-delete') {
      const { entryId, commentId, token, adminToken } = s;
      if (!safeId(entryId) || !safeId(commentId)) return json(400, { error: 'bad id' });
      const want = (await loadTokens())[`comment:${commentId}`];
      const allowed = isAdmin(adminToken) || (!!token && !!want && eq(sha(token), want));
      if (!allowed) return json(403, { error: 'not allowed' });

      const key = `${COMMENTS}${entryId}.json`;
      const list = await getJson(SITE, key, []);
      const gone = list.find((c) => c.id === commentId);
      await putJson(SITE, key, list.filter((c) => c.id !== commentId));
      for (const m of gone?.media ?? []) await deleteMediaObjects(m);
      const tokens = await loadTokens();
      delete tokens[`comment:${commentId}`];
      await saveTokens(tokens);
      return json(200, { ok: true });
    }

    return json(404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(500, { error: String(e?.message || e) });
  }
};
