// Reprocess videos ALREADY uploaded to the live site: transcode each one that
// doesn't yet have an HLS manifest, so existing memories get adaptive streaming
// + a reliable poster just like new uploads do.
//
// How it works: this script only SUBMITS MediaConvert jobs, tagged with the same
// UserMetadata the live capture Lambda uses ({ kind, entryId, commentId,
// mediaIndex, vid }). The deployed transcode-complete Lambda then patches each
// entry/reflection in place when its job finishes — so there's no entry-editing
// logic here, and no race with the live site.
//
// REQUIRES the backend to be deployed first (it relies on the completion Lambda
// + EventBridge rule). Run it once, by whoever has AWS credentials:
//
//   BUCKET=<site-bucket> node scripts/transcode-reprocess.mjs            # do it
//   BUCKET=<site-bucket> node scripts/transcode-reprocess.mjs --dry-run  # just list
//
// Idempotent: videos that already have `hls` are skipped. Safe to re-run, but
// avoid running it again while a previous batch is still transcoding (those
// videos won't have `hls` set yet and would be resubmitted).
//
// Shells out to the AWS CLI — no npm dependencies. Reuses the exact HLS ladder
// from capture/mediaconvert.mjs.

import { execFileSync } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { jobSettings } from '../capture/mediaconvert.mjs';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const BUCKET = process.env.BUCKET || '';
const STACK = process.env.STACK_NAME || 'celebrate-kristin-backend';
const DRY_RUN = process.argv.includes('--dry-run');

function aws(args, { raw = false } = {}) {
  const out = execFileSync('aws', [...args, '--region', REGION], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw ? out : (out.trim() ? JSON.parse(out) : null);
}

// media[].src is a public path like "/media/u/xxx"; the S3 key drops the slash.
const mediaKey = (src) =>
  typeof src === 'string' && src.startsWith('/media/') && !src.includes('..') ? src.slice(1) : null;

function mediaConvertEndpoint() {
  const url = aws(['mediaconvert', 'describe-endpoints'])?.Endpoints?.[0]?.Url;
  if (!url) throw new Error('Could not resolve a MediaConvert endpoint');
  return url;
}
function mediaConvertRoleArn() {
  const out = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK])
    ?.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'MediaConvertRoleArn');
  if (!out?.OutputValue) throw new Error(`Stack ${STACK} has no MediaConvertRoleArn output — deploy the backend first.`);
  return out.OutputValue;
}

// List every object key under a prefix (paginated).
function listKeys(prefix) {
  const keys = [];
  let token;
  do {
    const args = ['s3api', 'list-objects-v2', '--bucket', BUCKET, '--prefix', prefix];
    if (token) args.push('--starting-token', token);
    const r = aws(args);
    for (const o of r?.Contents || []) keys.push(o.Key);
    token = r?.NextToken;
  } while (token);
  return keys;
}
function getJsonFromS3(key) {
  try { return JSON.parse(aws(['s3', 'cp', `s3://${BUCKET}/${key}`, '-'], { raw: true })); }
  catch { return null; }
}

let endpoint, roleArn, tmp;
let submitted = 0, skipped = 0, bad = 0;

async function submitJob({ inputKey, userMetadata, label }) {
  if (DRY_RUN) { console.log(`  would transcode ${label}  ←  /${inputKey}`); submitted++; return; }
  const vid = userMetadata.vid;
  const jobInput = {
    Role: roleArn,
    Settings: jobSettings({ bucket: BUCKET, inputKey, outDir: `media/hls/${vid}/` }),
    UserMetadata: userMetadata,
  };
  const jobFile = join(tmp, `${vid}.json`);
  await writeFile(jobFile, JSON.stringify(jobInput));
  const id = aws(['mediaconvert', 'create-job', '--endpoint-url', endpoint, '--cli-input-json', `file://${jobFile}`])?.Job?.Id;
  console.log(`  ✓ submitted ${label}  (job ${id})`);
  submitted++;
}

// Walk a media array; submit a job for each video missing `hls`.
async function processMedia(media, baseMeta, labelPrefix) {
  if (!Array.isArray(media)) return;
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    if (m?.type !== 'video') continue;
    if (m.hls) { skipped++; continue; }
    const inputKey = mediaKey(m.src);
    if (!inputKey) { console.warn(`  ! ${labelPrefix}[${i}] — unrecognized src ${m.src}`); bad++; continue; }
    await submitJob({
      inputKey,
      userMetadata: { ...baseMeta, mediaIndex: String(i), vid: randomBytes(6).toString('hex') },
      label: `${labelPrefix}[${i}]`,
    });
  }
}

async function main() {
  if (!BUCKET) throw new Error('Set BUCKET to the site bucket name.');
  endpoint = mediaConvertEndpoint();
  roleArn = mediaConvertRoleArn();
  tmp = await mkdtemp(join(tmpdir(), 'reprocess-'));
  console.log(`${DRY_RUN ? '[dry run] ' : ''}Reprocessing existing videos in ${BUCKET}\nRole: ${roleArn}\n`);

  // Top-level memories.
  for (const key of listKeys('entries/').filter((k) => k.endsWith('.json'))) {
    const id = key.slice('entries/'.length, -'.json'.length);
    const entry = getJsonFromS3(key);
    await processMedia(entry?.media, { kind: 'entry', entryId: id }, id);
  }

  // Reflections (each comments/<parentId>.json is an array of reflections).
  for (const key of listKeys('comments/').filter((k) => k.endsWith('.json'))) {
    const parentId = key.slice('comments/'.length, -'.json'.length);
    const list = getJsonFromS3(key);
    if (!Array.isArray(list)) continue;
    for (const reflection of list) {
      await processMedia(
        reflection?.media,
        { kind: 'comment', entryId: parentId, commentId: reflection.id },
        `${parentId}/${reflection.id}`,
      );
    }
  }

  console.log(`\n${DRY_RUN ? 'Would submit' : 'Submitted'} ${submitted} job(s); skipped ${skipped} already-HLS; ${bad} unrecognized.`);
  if (!DRY_RUN && submitted) console.log('The transcode-complete Lambda will patch each entry as its job finishes (a few minutes).');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
