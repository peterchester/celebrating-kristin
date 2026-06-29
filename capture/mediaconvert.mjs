// AWS Elemental MediaConvert helper: turn an uploaded video master into an
// adaptive HLS ladder + a poster thumbnail, all in one job.
//
// The capture Lambda calls submitTranscode() right after /submit (or /comment)
// stores an entry containing a video. MediaConvert reads the master from
// media/originals/ and writes the HLS renditions + a JPEG poster to
// media/hls/<vid>/. When the job finishes, an EventBridge rule invokes the
// transcode-complete Lambda, which patches the entry with `hls` + `poster`.
//
// Config comes from the environment (set by template.yaml):
//   MEDIACONVERT_ROLE_ARN  — role MediaConvert assumes to read/write the bucket (required)
//   MEDIACONVERT_ENDPOINT  — account/region endpoint; if blank we DescribeEndpoints once
//   MEDIACONVERT_QUEUE_ARN — optional; omit to use the account default queue
//
// Uses the AWS SDK v3 MediaConvert client from the Lambda runtime — no extra deps.

import {
  MediaConvertClient, DescribeEndpointsCommand, CreateJobCommand,
} from '@aws-sdk/client-mediaconvert';

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

// One H.264 rendition (a rung of the adaptive ladder). Height drives the output;
// width is derived from the source aspect ratio (so portrait phone clips stay
// portrait). QVBR targets a visual-quality level and only spends bits up to
// maxKbps, which keeps small/simple footage small.
function rung(height, maxKbps, audioKbps = 96) {
  return {
    NameModifier: `_${height}`,
    ContainerSettings: { Container: 'M3U8', M3u8Settings: {} },
    VideoDescription: {
      Height: height,
      ScalingBehavior: 'DEFAULT',
      CodecSettings: {
        Codec: 'H_264',
        H264Settings: {
          RateControlMode: 'QVBR',
          QvbrSettings: { QvbrQualityLevel: 7 },
          MaxBitrate: maxKbps * 1000,
          SceneChangeDetect: 'TRANSITION_DETECTION',
          GopSizeUnits: 'AUTO',
          CodecProfile: height >= 720 ? 'HIGH' : 'MAIN',
          CodecLevel: 'AUTO',
        },
      },
    },
    AudioDescriptions: [{
      CodecSettings: {
        Codec: 'AAC',
        AacSettings: { Bitrate: audioKbps * 1000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 },
      },
    }],
  };
}

// Build the full job settings: an HLS output group (4-rung ladder) plus a
// single-frame JPEG poster grabbed a little way into the clip. Exported so the
// backfill script (scripts/transcode-backfill.mjs) submits an identical ladder.
export function jobSettings({ bucket, inputKey, outDir }) {
  const dest = `s3://${bucket}/${outDir}`;
  return {
    TimecodeConfig: { Source: 'ZEROBASED' },
    Inputs: [{
      FileInput: `s3://${bucket}/${inputKey}`,
      TimecodeSource: 'ZEROBASED',
      VideoSelector: { Rotate: 'AUTO' }, // honor phone orientation metadata
      AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
    }],
    OutputGroups: [
      {
        Name: 'Apple HLS',
        OutputGroupSettings: {
          Type: 'HLS_GROUP_SETTINGS',
          HlsGroupSettings: {
            Destination: dest,
            SegmentLength: 6,
            MinSegmentLength: 0,
            DirectoryStructure: 'SINGLE_DIRECTORY',
            SegmentControl: 'SEGMENTED_FILES',
            ManifestDurationFormat: 'INTEGER',
            OutputSelection: 'MANIFESTS_AND_SEGMENTS',
            CodecSpecification: 'RFC_4281',
          },
        },
        // 1080p / 720p / 480p / 360p. Players (or hls.js) pick the best the
        // connection can sustain and switch on the fly.
        Outputs: [
          rung(1080, 5000),
          rung(720, 3000),
          rung(480, 1500),
          rung(360, 800, 64),
        ],
      },
      {
        Name: 'Poster',
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: { Destination: dest },
        },
        Outputs: [{
          NameModifier: 'poster',
          ContainerSettings: { Container: 'RAW' },
          VideoDescription: {
            ScalingBehavior: 'DEFAULT',
            CodecSettings: {
              Codec: 'FRAME_CAPTURE',
              // One frame, ~3s in (FramerateDenominator seconds per capture),
              // capped at a single capture — avoids a black opening frame.
              FrameCaptureSettings: {
                FramerateNumerator: 1,
                FramerateDenominator: 3,
                MaxCaptures: 1,
                Quality: 80,
              },
            },
          },
        }],
      },
    ],
  };
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
