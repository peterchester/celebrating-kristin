# Video transcoding (MediaConvert → HLS) — deploy notes

This site now transcodes every uploaded video into adaptive **HLS** (multiple
quality levels that switch with the viewer's connection) plus a reliable
server-generated **poster**, while keeping the original master as an archive.
Browser-side poster grabbing (which failed on HEVC/.mov phone videos) is gone.

Everything is wired into the existing SAM stack and the existing deploy scripts.
This doc is the checklist for whoever runs the AWS deploy.

## What changed (code, already in the repo)

- `template.yaml` — adds a **MediaConvert IAM role**, a **completion Lambda**
  (`TranscodeCompleteFn`) triggered by an **EventBridge rule** on MediaConvert
  job completion, and grants the capture function `mediaconvert:CreateJob` +
  `iam:PassRole`.
- `capture/mediaconvert.mjs` — builds + submits the HLS job (4-rung ladder:
  1080/720/480/360p + a JPEG poster).
- `capture/lambda.mjs` — submits a transcode job for each video on
  `/submit` and `/comment`; cleans up HLS output on delete.
- `capture/transcode-complete/handler.mjs` — patches the entry/reflection with
  `hls` + `poster` when a job finishes.
- Frontend (`src/lib/render.ts`, `src/lib/hls.ts`, `hls.js` dep) — plays HLS
  natively on Safari/iOS, via hls.js elsewhere, with a progressive MP4 fallback.

## One-time / deploy steps

1. **Confirm region** — the stack expects **us-east-1** (same as the site,
   bucket, and SES). MediaConvert is available there by default.

2. **Deploy the backend** (creates the new role, completion Lambda, EventBridge
   rule, and capture-function permissions):
   ```
   ./deploy-backend.sh
   ```
   The deploy role must be allowed to create IAM roles (SAM runs with
   `CAPABILITY_IAM`, which the existing backend deploy already uses).

3. **Deploy the frontend** (ships the hls.js player + renderer changes):
   ```
   ./deploy.sh
   ```

4. **MediaConvert endpoint (optional).** The capture Lambda auto-discovers the
   account/region MediaConvert endpoint at runtime (it has
   `mediaconvert:DescribeEndpoints`). To skip discovery, fetch it once:
   ```
   aws mediaconvert describe-endpoints --region us-east-1
   ```
   and pass it as the `MediaConvertEndpoint` parameter (and/or
   `MediaConvertQueueArn` for a non-default queue) in `.deploy.env`.

5. **Backfill the existing videos** (one-time). With AWS credentials:
   ```
   mkdir backfill-videos          # add your master files here
   # optional: backfill-videos/manifest.json for per-file title/author/date
   BUCKET=<site-bucket> node scripts/transcode-backfill.mjs
   ```
   It uploads each master to `media/originals/`, runs the same HLS ladder, waits
   for completion, and writes `src/content/entries/<id>.json`. Review the
   generated entries, then commit and `./deploy.sh`.

## Storage / cost notes

- **New spend:** MediaConvert is ~$0.04–0.05 per source-minute for the 4-rung
  ladder — a few dollars one-time for the backfill, pennies per future upload.
  No standing charge (billed per job).
- **Archival:** masters live under `media/originals/`. Consider an S3 lifecycle
  rule moving that prefix to **Glacier Instant Retrieval** after ~30 days — keeps
  them cheap while still instantly fetchable for the rare progressive fallback.
  (Not added to the template yet — confirm desired storage class first.)
- **Delivery:** HLS is just many small `.ts` + `.m3u8` objects under
  `media/hls/`; the existing S3-origin CloudFront distribution serves them with
  no config change. MediaConvert sets the correct `Content-Type`s.

## How it behaves

- On upload, a video plays **immediately** (progressively, from the master) and
  is marked `processing`. When the job finishes (usually under a few minutes),
  the entry gains `hls` + `poster` and the player upgrades to adaptive streaming.
- If a job errors, `processing` is cleared and the clip keeps playing
  progressively — nothing breaks for the viewer.
- The ladder/quality settings live in `capture/mediaconvert.mjs` (`jobSettings`)
  and are worth a glance after the first real transcode to tune bitrates.
