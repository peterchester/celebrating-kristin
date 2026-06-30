// Restore objects deleted by an `aws s3 sync --delete` on a VERSIONED bucket, by
// removing the delete markers under a prefix (default media/hls/).
//
// Why this exists: an early version of deploy.sh didn't exclude media/hls/, so a
// frontend deploy wiped the transcoded HLS renditions + posters. On a versioned
// bucket those deletions are just "delete markers" layered over the real object
// versions — removing the marker makes the object reappear. Nothing is
// re-transcoded; this is an exact, free restore.
//
//   BUCKET=<bucket> node scripts/restore-deleted.mjs --dry-run   # preview
//   BUCKET=<bucket> node scripts/restore-deleted.mjs             # restore
//   BUCKET=<bucket> PREFIX=media/u/ node scripts/restore-deleted.mjs   # other prefix
//
// Requires S3 versioning to have been enabled when the delete happened. AWS CLI
// only — no npm dependencies.

import { execFileSync } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const BUCKET = process.env.BUCKET || '';
const PREFIX = process.env.PREFIX || 'media/hls/';
const DRY_RUN = process.argv.includes('--dry-run');

function aws(args, { raw = false } = {}) {
  const out = execFileSync('aws', [...args, '--region', REGION], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return raw ? out : (out.trim() ? JSON.parse(out) : null);
}

// Every delete marker that is currently the latest version under PREFIX — i.e.
// an object that appears deleted but has a real version waiting underneath.
// The AWS CLI auto-paginates list-object-versions, so one call returns them all.
function listLatestDeleteMarkers() {
  return aws([
    's3api', 'list-object-versions', '--bucket', BUCKET, '--prefix', PREFIX,
    '--query', 'DeleteMarkers[?IsLatest==`true`].{Key:Key,VersionId:VersionId}',
  ]) || [];
}

async function main() {
  if (!BUCKET) throw new Error('Set BUCKET to the site bucket name.');
  const markers = listLatestDeleteMarkers();
  console.log(`${DRY_RUN ? '[dry run] ' : ''}Found ${markers.length} deleted object(s) under ${PREFIX}`);
  if (!markers.length) { console.log('Nothing to restore.'); return; }

  if (DRY_RUN) {
    markers.slice(0, 25).forEach((m) => console.log('  would restore', m.Key));
    if (markers.length > 25) console.log(`  …and ${markers.length - 25} more`);
    return;
  }

  // Deleting a delete marker (by its VersionId) restores the prior version as
  // current. Batch up to 1000 per delete-objects call, via a temp file to avoid
  // argv length limits.
  const tmp = await mkdtemp(join(tmpdir(), 'restore-'));
  for (let i = 0; i < markers.length; i += 1000) {
    const batch = markers.slice(i, i + 1000).map((m) => ({ Key: m.Key, VersionId: m.VersionId }));
    const file = join(tmp, `batch-${i}.json`);
    await writeFile(file, JSON.stringify({ Objects: batch, Quiet: true }));
    aws(['s3api', 'delete-objects', '--bucket', BUCKET, '--delete', `file://${file}`], { raw: true });
    console.log(`  restored ${Math.min(i + 1000, markers.length)}/${markers.length}`);
  }
  console.log('\nDone. Then invalidate CloudFront so the edge re-fetches:');
  console.log('  aws cloudfront create-invalidation --distribution-id <ID> --paths "/media/hls/*"');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
