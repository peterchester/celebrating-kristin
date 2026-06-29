// One-off backfill: transcode your existing high-res videos into adaptive HLS +
// posters and create curated memory entries for them, using the SAME MediaConvert
// ladder the live site uses for uploads (capture/mediaconvert.mjs → jobSettings).
//
// This is meant to be run by whoever has AWS credentials (Tai), once. It shells
// out to the AWS CLI for every AWS call, so it needs NO extra npm dependencies —
// just the `aws` CLI you already use to deploy.
//
//   1. Put your master video files in ./backfill-videos/
//   2. (Optional) add ./backfill-videos/manifest.json to set per-file metadata:
//        {
//          "clip-one.mov": { "title": "Big Sur, 1998", "author": "Peter",
//                            "relationship": "husband", "body": "We left at 4am…",
//                            "memoryDate": "1998-07-04" },
//          ...
//        }
//      Files with no manifest entry get a title from the filename and author
//      "Peter" — edit the generated entry JSON afterwards.
//   3. Run:  BUCKET=<site-bucket> node scripts/transcode-backfill.mjs
//      (BUCKET defaults to $BUCKET from your shell/.deploy.env.)
//
// For each video it: uploads the master to media/originals/, submits an HLS job,
// waits for it to finish, finds the manifest + poster, and writes a build-time
// entry to src/content/entries/<id>.json. Commit + deploy as usual afterwards.

import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { jobSettings } from '../capture/mediaconvert.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const VIDEO_DIR = process.env.VIDEO_DIR || join(ROOT, 'backfill-videos');
const ENTRIES_DIR = join(ROOT, 'src', 'content', 'entries');
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const BUCKET = process.env.BUCKET || '';
const STACK = process.env.STACK_NAME || 'celebrate-kristin-backend';
const POLL_MS = 15000;

// Run the AWS CLI and return stdout (JSON parsed unless raw=true).
function aws(args, { raw = false } = {}) {
  const out = execFileSync('aws', [...args, '--region', REGION], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw ? out : (out.trim() ? JSON.parse(out) : null);
}

const slug = (s) =>
  (s || 'video').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 40) || 'video';

// MediaConvert needs an account/region endpoint and a role to assume. We read the
// role from the deployed stack's outputs so there's nothing to hand-configure.
function mediaConvertEndpoint() {
  const r = aws(['mediaconvert', 'describe-endpoints']);
  const url = r?.Endpoints?.[0]?.Url;
  if (!url) throw new Error('Could not resolve a MediaConvert endpoint');
  return url;
}
function mediaConvertRoleArn() {
  const r = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK]);
  const out = r?.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'MediaConvertRoleArn');
  if (!out?.OutputValue) throw new Error(`Stack ${STACK} has no MediaConvertRoleArn output — deploy the backend first.`);
  return out.OutputValue;
}

async function uniqueEntryId(base) {
  let id = base || 'memory', n = 2;
  while (existsSync(join(ENTRIES_DIR, `${id}.json`))) id = `${base}-${n++}`;
  return id;
}

async function main() {
  if (!BUCKET) throw new Error('Set BUCKET to the site bucket name.');
  if (!existsSync(VIDEO_DIR)) throw new Error(`No ${VIDEO_DIR} directory — create it and add your videos.`);
  await mkdir(ENTRIES_DIR, { recursive: true });

  const manifestPath = join(VIDEO_DIR, 'manifest.json');
  let manifest = {};
  if (existsSync(manifestPath)) manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const files = (await readdir(VIDEO_DIR)).filter((f) => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(f));
  if (!files.length) { console.log(`No videos found in ${VIDEO_DIR}.`); return; }

  const endpoint = mediaConvertEndpoint();
  const roleArn = mediaConvertRoleArn();
  console.log(`MediaConvert endpoint: ${endpoint}\nRole: ${roleArn}\nProcessing ${files.length} video(s)…\n`);

  const tmp = await mkdtemp(join(tmpdir(), 'backfill-'));

  for (const file of files) {
    const meta = manifest[file] || {};
    const ext = extname(file);
    const baseName = slug(meta.title || basename(file, ext));
    const rand = randomBytes(3).toString('hex');
    const vid = randomBytes(6).toString('hex');
    const inputKey = `media/originals/${rand}-${baseName}${ext}`;

    console.log(`• ${file} → uploading master…`);
    aws(['s3', 'cp', join(VIDEO_DIR, file), `s3://${BUCKET}/${inputKey}`], { raw: true });

    // Submit the job with the shared ladder via --cli-input-json.
    const jobInput = {
      Role: roleArn,
      Settings: jobSettings({ bucket: BUCKET, inputKey, outDir: `media/hls/${vid}/` }),
      UserMetadata: { kind: 'backfill', vid },
    };
    const jobFile = join(tmp, `${vid}.json`);
    await writeFile(jobFile, JSON.stringify(jobInput));
    const created = aws(['mediaconvert', 'create-job', '--endpoint-url', endpoint, '--cli-input-json', `file://${jobFile}`]);
    const jobId = created?.Job?.Id;
    console.log(`  job ${jobId} submitted — waiting…`);

    // Poll until the job leaves the queue.
    let status = 'SUBMITTED';
    while (['SUBMITTED', 'PROGRESSING'].includes(status)) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      status = aws(['mediaconvert', 'get-job', '--endpoint-url', endpoint, '--id', jobId])?.Job?.Status;
      process.stdout.write(`  …${status}\n`);
    }
    if (status !== 'COMPLETE') { console.error(`  ✗ job ${status} — skipping ${file}`); continue; }

    // Find the master manifest (the .m3u8 with #EXT-X-STREAM-INF) and the poster.
    const listed = aws(['s3api', 'list-objects-v2', '--bucket', BUCKET, '--prefix', `media/hls/${vid}/`]);
    const keys = (listed?.Contents || []).map((o) => o.Key);
    const poster = keys.find((k) => /\.jpe?g$/i.test(k));
    let master = null;
    for (const k of keys.filter((k) => k.endsWith('.m3u8'))) {
      const body = aws(['s3', 'cp', `s3://${BUCKET}/${k}`, '-'], { raw: true });
      if (body.includes('#EXT-X-STREAM-INF')) { master = k; break; }
    }

    const id = await uniqueEntryId(baseName);
    const entry = {
      author: { name: meta.author || 'Peter', ...(meta.relationship ? { relationship: meta.relationship } : {}) },
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.body ? { body: meta.body } : {}),
      media: [{
        type: 'video',
        src: `/${inputKey}`,
        original: `/${inputKey}`,
        ...(master ? { hls: `/${master}` } : {}),
        ...(poster ? { poster: `/${poster}` } : {}),
      }],
      submittedAt: new Date().toISOString(),
      ...(meta.memoryDate ? { memoryDate: meta.memoryDate } : {}),
      status: 'published',
    };
    await writeFile(join(ENTRIES_DIR, `${id}.json`), JSON.stringify(entry, null, 2) + '\n');
    console.log(`  ✓ wrote src/content/entries/${id}.json\n`);
  }

  console.log('Done. Review the generated entries, then commit + run ./deploy.sh (Tai).');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
