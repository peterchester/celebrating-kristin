// Invoked by EventBridge when a MediaConvert job finishes (COMPLETE / ERROR /
// CANCELED). It patches the entry (or reflection) that owns the transcoded video:
//
//   COMPLETE → set media[i].hls (the master .m3u8) + media[i].poster (the JPEG),
//              clear `processing`.
//   ERROR/CANCELED → just clear `processing` so the UI stops waiting; the clip
//              keeps playing progressively from `src`.
//
// The capture Lambda tagged the job with UserMetadata { kind, entryId, commentId,
// mediaIndex, vid }, which MediaConvert echoes back on the event. `vid` tells us
// the output directory (media/hls/<vid>/); we scan it for the master manifest and
// the poster rather than guessing exact filenames.
//
// Uses only the AWS SDK v3 that ships with the Lambda Node runtime — no deps.

import {
  S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const SITE = process.env.SITE_BUCKET;
const ENTRIES = 'entries/';
const COMMENTS = 'comments/';
const INDEX = 'data/index.json';
const NO_CACHE = 'public, max-age=0, must-revalidate';

async function getJson(key, fallback) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: SITE, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return fallback;
    throw e;
  }
}
const putJson = (key, obj) =>
  s3.send(new PutObjectCommand({
    Bucket: SITE, Key: key, Body: JSON.stringify(obj, null, 2) + '\n',
    ContentType: 'application/json', CacheControl: NO_CACHE,
  }));
async function getText(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: SITE, Key: key }));
  return r.Body.transformToString();
}

// Rebuild data/index.json from the entry files (mirrors the capture Lambda) so
// the gallery card picks up the new poster. Newest first; hidden entries skipped.
async function rebuildIndex() {
  const out = [];
  let token;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: SITE, Prefix: ENTRIES, ContinuationToken: token }));
    for (const o of list.Contents || []) {
      if (!o.Key.endsWith('.json')) continue;
      const id = o.Key.slice(ENTRIES.length, -'.json'.length);
      const entry = await getJson(o.Key, null);
      if (entry && entry.status !== 'hidden') out.push({ id, ...entry });
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  out.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  await putJson(INDEX, out);
}

// Scan media/hls/<vid>/ for the master manifest and the poster. The master HLS
// manifest is the one .m3u8 that lists variant streams (#EXT-X-STREAM-INF);
// the variants only contain #EXTINF. The poster is the single .jpg.
async function findOutputs(vid) {
  const prefix = `media/hls/${vid}/`;
  const keys = [];
  let token;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: SITE, Prefix: prefix, ContinuationToken: token }));
    for (const o of list.Contents || []) keys.push(o.Key);
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);

  const poster = keys.find((k) => /\.jpe?g$/i.test(k));
  const manifests = keys.filter((k) => k.endsWith('.m3u8'));
  let master = null;
  for (const k of manifests) {
    try {
      if ((await getText(k)).includes('#EXT-X-STREAM-INF')) { master = k; break; }
    } catch {}
  }
  // Fallback: if we somehow couldn't read a master tag, prefer the shortest name
  // (the master usually lacks a _1080-style rung suffix).
  if (!master && manifests.length) master = manifests.sort((a, b) => a.length - b.length)[0];
  return { master, poster };
}

// Apply the transcode result to one media item in place. Returns true if changed.
function patchMediaItem(media, index, status, outputs) {
  const m = Array.isArray(media) ? media[index] : null;
  if (!m || m.type !== 'video') return false;
  delete m.processing;
  if (status === 'COMPLETE') {
    if (outputs.master) m.hls = '/' + outputs.master;
    if (outputs.poster) m.poster = '/' + outputs.poster;
  }
  return true;
}

export const handler = async (event) => {
  const detail = event?.detail || {};
  const status = detail.status; // COMPLETE | ERROR | CANCELED
  const meta = detail.userMetadata || {};
  const { kind, entryId, commentId } = meta;
  const mediaIndex = Number(meta.mediaIndex);

  if (!entryId || !Number.isInteger(mediaIndex)) {
    console.error('transcode-complete: missing/invalid metadata', meta);
    return;
  }
  const outputs = status === 'COMPLETE' && meta.vid ? await findOutputs(meta.vid) : { master: null, poster: null };

  if (kind === 'comment') {
    const key = `${COMMENTS}${entryId}.json`;
    const list = await getJson(key, []);
    const reflection = list.find((c) => c.id === commentId);
    if (!reflection) { console.error('transcode-complete: no reflection', commentId); return; }
    if (patchMediaItem(reflection.media, mediaIndex, status, outputs)) await putJson(key, list);
    return; // reflections aren't in data/index.json
  }

  // Default: a top-level memory entry.
  const key = `${ENTRIES}${entryId}.json`;
  const entry = await getJson(key, null);
  if (!entry) { console.error('transcode-complete: no entry', entryId); return; }
  if (patchMediaItem(entry.media, mediaIndex, status, outputs)) {
    await putJson(key, entry);
    await rebuildIndex(); // refresh the gallery card's poster
  }
  console.log(`transcode ${status} → ${entryId}[${mediaIndex}]`, outputs);
};
