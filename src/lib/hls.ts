// Wire up adaptive HLS playback for any <video data-hls> the renderer produced.
//
// render.ts emits HLS-capable videos as a shell:
//   <video data-hls="…/index.m3u8" data-mp4="…/master.mp4" controls …></video>
// with no src, so nothing loads until we choose the right source here:
//
//   • Safari / iOS play HLS natively → just set video.src to the manifest.
//   • Chrome / Firefox / Android need hls.js → load it on demand (dynamic
//     import, so the ~100 KB only ships when an HLS video is actually present)
//     and attach it via Media Source Extensions.
//   • If neither works (or hls.js errors), fall back to the progressive MP4
//     master in data-mp4 so the video still plays, just without adaptation.
//
// Call attachHls(root) after injecting rendered markup into the DOM. It's
// idempotent: each element is wired at most once (data-hls is removed once handled).

export async function attachHls(root: ParentNode = document): Promise<void> {
  const vids = Array.from(root.querySelectorAll<HTMLVideoElement>('video[data-hls]'));
  if (!vids.length) return;

  let HlsCtor: typeof import('hls.js').default | null | undefined;

  for (const video of vids) {
    const manifest = video.getAttribute('data-hls') || '';
    const mp4 = video.getAttribute('data-mp4') || '';
    video.removeAttribute('data-hls'); // mark handled (idempotent)
    if (!manifest) {
      if (mp4) video.src = mp4;
      continue;
    }

    // Native HLS (Safari, iOS, some smart TVs) — no library needed. If the
    // manifest itself fails to load, drop back to the progressive master once.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      if (mp4) {
        let fellBack = false;
        video.addEventListener('error', () => {
          if (!fellBack) { fellBack = true; video.src = mp4; }
        }, { once: true });
      }
      video.src = manifest;
      continue;
    }

    // Everyone else: hls.js over MSE. Import once, reuse for the rest.
    if (HlsCtor === undefined) {
      try { HlsCtor = (await import('hls.js')).default; }
      catch { HlsCtor = null; } // import failed — fall through to MP4
    }

    if (HlsCtor && HlsCtor.isSupported()) {
      const hls = new HlsCtor({ enableWorker: true });
      let recovered = false;
      hls.on(HlsCtor.Events.ERROR, (_evt, data) => {
        // On an unrecoverable error, drop back to the progressive master once.
        if (data.fatal && !recovered) {
          recovered = true;
          hls.destroy();
          if (mp4) video.src = mp4;
        }
      });
      hls.loadSource(manifest);
      hls.attachMedia(video);
    } else if (mp4) {
      video.src = mp4; // no MSE support at all
    } else {
      video.src = manifest; // last resort: let the browser try directly
    }
  }
}
