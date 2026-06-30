// AWS Elemental MediaConvert helper: turn an uploaded video master into an
// adaptive HLS ladder + a poster thumbnail, all in one job.
//
// The capture Lambda calls submitTranscode() right after /submit (or /comment)
// stores an entry containing a video. MediaConvert reads the master from
// media/originals/ (or media/u/ for pre-existing uploads) and writes the HLS
// renditions + a JPEG poster to media/hls/<vid>/. When the job finishes, an
// EventBridge rule invokes the transcode-complete Lambda, which patches the entry
// with `hls` + `poster`.
//
// Config comes from the environment (set by template.yaml):
//   MEDIACONVERT_ROLE_ARN  — role MediaConvert assumes to read/write the bucket (required)
//   MEDIACONVERT_ENDPOINT  — account/region endpoint; if blank we DescribeEndpoints once
//   MEDIACONVERT_QUEUE_ARN — optional; omit to use the account default queue
//
// Uses the AWS SDK v3 MediaConvert client from the Lambda runtime — no extra deps.
// The ladder itself lives in ./job-settings.mjs (a pure, SDK-free module) so the
// local scripts can build identical settings without installing @aws-sdk.

import {
  MediaConvertClient, DescribeEndpointsCommand, CreateJobCommand,
} from '@aws-sdk/client-mediaconvert';
import { jobSettings } from './job-settings.mjs';

const ROLE_ARN = process.env.MEDIACONVERT_ROLE_ARN || '';
const QUEUE_ARN = process.env.MEDIACONVERT_QUEUE_ARN || '';
let cachedEndpoint = process.env.MEDIACONVERT_ENDPOINT || '';
let cachedClient = null;

// MediaConvert needs an account/region-specific endpoint for CreateJob. We
// prefer the env value (so Tai can hard-set it); otherwise we discover it once
// per cold start and reuse it.
async function client() {
  if (cachedClient) return cachedClient;
  if (!cachedEndpoint) {
    const probe = new MediaConvertClient({});
    const r = await probe.send(new DescribeEndpointsCommand({}));
    cachedEndpoint = r?.Endpoints?.[0]?.Url || '';
    if (!cachedEndpoint) throw new Error('MediaConvert: could not resolve endpoint');
  }
  cachedClient = new MediaConvertClient({ endpoint: cachedEndpoint });
  return cachedClient;
}

// Submit one transcode job. `userMetadata` is echoed back on the completion
// event so the transcode-complete Lambda knows which entry/media to patch.
export async function submitTranscode({ bucket, inputKey, vid, userMetadata }) {
  if (!ROLE_ARN) throw new Error('MEDIACONVERT_ROLE_ARN is not set');
  const c = await client();
  return c.send(new CreateJobCommand({
    Role: ROLE_ARN,
    ...(QUEUE_ARN ? { Queue: QUEUE_ARN } : {}),
    StatusUpdateInterval: 'SECONDS_60',
    UserMetadata: userMetadata,
    Settings: jobSettings({ bucket, inputKey, outDir: `media/hls/${vid}/` }),
  }));
}
