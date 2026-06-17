// SES inbound email processor for Celebrating Kristin.
//
// Flow: SES receipt rule stores the raw email in S3 and invokes this Lambda.
// We read the raw message, parse it, and either create a new memory or add a
// reflection — writing to the same S3 layout the HTTP backend uses.
//
//   celebrate@kristinallen.com, fresh email      -> new memory (subject = title)
//   reply to a notification (subject has [ref:X]) -> reflection on memory X
//
// Routing is by a [ref:<entryId>] token in the subject rather than plus-
// addressing, so it survives mail clients reliably. Notifications set their
// Reply-To to celebrate@... and include [ref:<id>] in the subject.
//
// Needs `mailparser` (see package.json) — the rest is the AWS SDK v3 bundled
// in the Lambda runtime.

import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomBytes, createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';

const s3 = new S3Client({});
const ses = new SESClient({});
const SITE = process.env.SITE_BUCKET;
const PRIV = process.env.PRIVATE_BUCKET;
const RAW = process.env.RAW_BUCKET;
const RAW_PREFIX = process.env.RAW_PREFIX || 'inbound/';
const EMAIL_ADDRESS = (process.env.EMAIL_ADDRESS || '').toLowerCase();
const NOTIFY_FROM = process.env.NOTIFY_FROM || '';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
// Optional comma-separated allowlist of sender addresses. Blank = accept anyone
// (SES spam/virus scanning still applies).
const ALLOW_SENDERS = (process.env.ALLOW_SENDERS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const ENTRIES = 'entries/';
const COMMENTS = 'comments/';
const INDEX = 'data/index.json';
const TOKENS = 'tokens.json';
const CONTACTS = 'contacts.jsonl';
const NO_CACHE = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const slug = (s) =>
  (s || 'anon').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').slice(0, 40) || 'anon';
const sha = (t) => createHash('sha256').update(String(t)).digest('hex');

async function bodyToString(body) { return await body.transformToString(); }
async function getJson(bucket, key, fallback) {
  try { const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return JSON.parse(await bodyToString(r.Body)); }
  catch (e) { if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return fallback; throw e; }
}
async function getText(bucket, key, fallback) {
  try { const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return await bodyToString(r.Body); }
  catch (e) { if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return fallback; throw e; }
}
const putJson = (bucket, key, obj) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(obj, null, 2) + '\n', ContentType: 'application/json', CacheControl: NO_CACHE }));
const putText = (bucket, key, text) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: text, ContentType: 'text/plain' }));
async function exists(bucket, key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; } catch { return false; }
}

const uniqueEntryId = async (base) => {
  base = base || 'memory';
  let id = base, n = 2;
  while (await exists(SITE, `${ENTRIES}${id}.json`)) id = `${base}-${n++}`;
  return id;
};

// Rebuild data/index.json from entries (same as the HTTP backend).
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

const loadTokens = () => getJson(PRIV, TOKENS, {});
const saveTokens = (o) => putJson(PRIV, TOKENS, o);
const authorEmailFor = async (entryId) => {
  const text = await getText(PRIV, CONTACTS, '');
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const c = JSON.parse(line); if (c.id === entryId && c.email) found = c; } catch {}
  }
  return found;
};

// Notify a memory's author that a reflection was added, with Reply-To +
// [ref:<id>] so a reply becomes another reflection by email.
async function notifyAuthor(entryId, reflectorName, skipEmail) {
  if (!NOTIFY_FROM) return;
  const to = await authorEmailFor(entryId);
  if (!to?.email || (skipEmail && to.email.toLowerCase() === skipEmail.toLowerCase())) return;
  const entry = await getJson(SITE, `${ENTRIES}${entryId}.json`, null);
  const title = entry?.title || 'your memory';
  const link = SITE_URL ? `${SITE_URL}/memory/${entryId}` : '';
  const body =
    `Hi ${to.name || ''},\n\n` +
    `${reflectorName} just added a reflection to "${title}" on Celebrating Kristin.\n\n` +
    (link ? `Read it here:\n${link}\n\n` : '') +
    `You can reply to this email to add your own reflection.\n\nWith love,\nCelebrating Kristin`;
  await ses.send(new SendEmailCommand({
    Source: NOTIFY_FROM,
    Destination: { ToAddresses: [to.email] },
    ReplyToAddresses: EMAIL_ADDRESS ? [EMAIL_ADDRESS] : undefined,
    Message: {
      Subject: { Data: `${reflectorName} added a reflection to "${title}" [ref:${entryId}]` },
      Body: { Text: { Data: body } },
    },
  }));
}

// Trim an email body down to the new content: stop at the signature delimiter,
// a quoted-reply header, or a long underscore line; drop trailing quoted lines.
function cleanBody(text) {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const markers = [
    /^--\s*$/,                       // signature delimiter
    /^On\b.*\bwrote:\s*$/i,          // gmail / apple quoted reply
    /^-{3,}\s*Original Message\s*-{3,}/i,
    /^_{5,}\s*$/,                    // outlook
    /^From:\s.+/i,                   // outlook header block start
    /^Sent from my /i,               // common mobile sig
  ];
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (markers.some((re) => re.test(lines[i].trim()))) { end = i; break; }
  }
  let kept = lines.slice(0, end);
  while (kept.length && (kept[kept.length - 1].trim() === '' || kept[kept.length - 1].trimStart().startsWith('>'))) kept.pop();
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Save email attachments (images/audio/video) as media. Skips tiny inline
// images (signature logos/icons) under 8 KB.
async function saveAttachments(attachments, baseName) {
  const media = [];
  for (const att of attachments || []) {
    const ct = String(att.contentType || '').toLowerCase();
    const kind = ct.startsWith('image/') ? 'image' : ct.startsWith('audio/') ? 'audio' : ct.startsWith('video/') ? 'video' : null;
    if (!kind) continue;
    if (kind === 'image' && (att.size || att.content?.length || 0) < 8000) continue;
    const rand = randomBytes(3).toString('hex');
    const origName = att.filename || `${kind}`;
    const ext = (origName.match(/\.[^.]+$/) || [`.${ct.split('/')[1] || 'bin'}`])[0];
    const key = `media/u/${rand}-${slug(baseName + '-' + origName.replace(/\.[^.]+$/, ''))}${ext}`;
    await s3.send(new PutObjectCommand({ Bucket: SITE, Key: key, Body: att.content, ContentType: att.contentType, CacheControl: IMMUTABLE }));
    media.push({ type: kind, src: `/${key}`, caption: '' });
  }
  return media;
}

export const handler = async (event) => {
  const record = event?.Records?.[0]?.ses;
  if (!record) { console.error('not an SES event'); return; }
  const { mail, receipt } = record;

  // Drop spam / viruses up front.
  if (receipt?.spamVerdict?.status === 'FAIL' || receipt?.virusVerdict?.status === 'FAIL') {
    console.log('dropped: spam/virus verdict', mail?.messageId);
    return;
  }

  // Read the raw message SES stored in S3.
  const key = `${RAW_PREFIX}${mail.messageId}`;
  let raw;
  try { raw = await bodyToString((await s3.send(new GetObjectCommand({ Bucket: RAW, Key: key }))).Body); }
  catch (e) { console.error('could not read raw email', key, e); return; }
  const parsed = await simpleParser(raw);

  const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
  const fromName = (parsed.from?.value?.[0]?.name || '').trim() || (fromAddr.split('@')[0] || 'A friend');
  if (ALLOW_SENDERS.length && !ALLOW_SENDERS.includes(fromAddr)) {
    console.log('dropped: sender not on allowlist', fromAddr);
    return;
  }

  const subject = (parsed.subject || '').trim();
  const refMatch = subject.match(/\[ref:([A-Za-z0-9_-]+)\]/);
  const text = cleanBody(parsed.text || '');

  if (refMatch) {
    // ── Reflection by reply ──────────────────────────────────────────────────
    const entryId = refMatch[1];
    if (!(await exists(SITE, `${ENTRIES}${entryId}.json`))) { console.log('reflection: no such memory', entryId); return; }
    const media = await saveAttachments(parsed.attachments, entryId);
    if (!text && !media.length) { console.log('reflection: empty, skipped'); return; }

    const commentId = randomBytes(8).toString('hex');
    const reflection = { id: commentId, author: { name: fromName }, ...(text ? { body: text } : {}), ...(media.length ? { media } : {}), createdAt: new Date().toISOString() };
    const ckey = `${COMMENTS}${entryId}.json`;
    const list = await getJson(SITE, ckey, []);
    list.push(reflection);
    await putJson(SITE, ckey, list);

    const tokens = await loadTokens();
    tokens[`comment:${commentId}`] = sha(randomBytes(16).toString('hex')); // no cookie owner; admin-only delete
    await saveTokens(tokens);

    await notifyAuthor(entryId, fromName, fromAddr).catch((e) => console.error('notify failed', e));
    console.log(`✓ email reflection on ${entryId} from ${fromAddr}`);
    return;
  }

  // ── New memory ─────────────────────────────────────────────────────────────
  const title = subject || '';
  const id = await uniqueEntryId(title ? slug(title) : slug(fromName));
  const media = await saveAttachments(parsed.attachments, title || fromName);
  if (!text && !media.length) { console.log('memory: empty (no text or media), skipped'); return; }

  const now = new Date();
  const entry = { author: { name: fromName }, ...(title ? { title } : {}), ...(text ? { body: text } : {}), media, submittedAt: now.toISOString(), status: 'published' };
  await putJson(SITE, `${ENTRIES}${id}.json`, entry);

  const tokens = await loadTokens();
  tokens[id] = sha(randomBytes(16).toString('hex')); // no cookie owner; admin can edit/delete
  await saveTokens(tokens);
  if (fromAddr) await putText(PRIV, CONTACTS, (await getText(PRIV, CONTACTS, '')) + JSON.stringify({ id, name: fromName, email: fromAddr }) + '\n');

  await rebuildIndex();
  console.log(`✓ email memory ${id} from ${fromAddr}${media.length ? ` (+${media.length} media)` : ''}`);
};
