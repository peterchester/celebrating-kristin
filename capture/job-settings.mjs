// Pure MediaConvert job-settings builder — NO AWS SDK imports, so it can be used
// both by the Lambda (capture/mediaconvert.mjs, which submits via the SDK) and by
// the local scripts (transcode-backfill / transcode-reprocess, which submit via
// the AWS CLI and have no @aws-sdk packages installed). Keeping this dependency
// free is the whole point: importing it must never require @aws-sdk.

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
// single-frame JPEG poster grabbed a little way into the clip. Shared by the
// Lambda and the backfill/reprocess scripts so every path uses an identical ladder.
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
