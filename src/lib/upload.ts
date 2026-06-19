// Shared upload flow used by the share form AND the reflection form.
//
// For images: upload the ORIGINAL untouched, then create a web-optimized JPEG
// (max 2400px, EXIF stripped, JPEG @0.85) and upload that. Return both keys;
// the site displays the optimized one (`src`) and keeps the original (`original`)
// as a permanent archive.
//
// For video: a single upload of the file, plus a poster — a JPEG frame grabbed
// in the browser (same canvas trick as image optimization) and uploaded as a
// second object. If the browser can't decode the codec, we skip the poster and
// the site falls back to its filmstrip cover.
//
// For audio: a single upload, no `original`, no poster.
//
// Both uploads go through the existing presign + PUT flow; the `kind: 'original'`
// flag tells the backend to stash the file under media/originals/ instead of
// media/u/.

const MAX_DIM = 2000;
const JPEG_QUALITY = 0.85;

export interface UploadedMedia {
  type: 'image' | 'audio' | 'video';
  src: string;
  original?: string;
  poster?: string; // video only: key of a JPEG frame for the cover/poster
  caption: string;
}

/** Compose an identifying base filename: "<author>-<title or original>".
 * Slugified client-side; the backend re-slugs and caps at 40 chars, then adds
 * the random hash prefix and original extension. Result keys look like
 * "media/u/abc123-jane-doe-the-road-trip.jpg" — handy for archiving. */
function composeBase(ctx: { author?: string; title?: string } | undefined, originalBase: string): string {
  const slug = (s: string, max: number) =>
    s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, max);
  const parts: string[] = [];
  if (ctx?.author) parts.push(slug(ctx.author, 16));
  if (ctx?.title) parts.push(slug(ctx.title, 22));
  else {
    const ob = slug(originalBase, 18);
    if (ob && ob !== 'anon') parts.push(ob);
  }
  const out = parts.filter(Boolean).join('-');
  return out || slug(originalBase, 22) || 'photo';
}

// Decode the image, resize if either side exceeds MAX_DIM, re-encode as JPEG.
// Returns null if the browser can't decode (e.g. HEIC on non-Safari) so the
// caller can fall back to uploading the original as-is.
async function optimizeImage(file: File): Promise<File | null> {
  if (!file.type.startsWith('image/')) return null;
  if (file.type === 'image/gif') return null; // preserve any animation
  let url: string | null = null;
  try {
    url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image decode failed'));
    });
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > MAX_DIM || h > MAX_DIM) {
      const r = Math.min(MAX_DIM / w, MAX_DIM / h);
      w = Math.round(w * r);
      h = Math.round(h * r);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) return null;
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], baseName + '.jpg', { type: 'image/jpeg' });
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

// Grab a representative frame from a video and return it as a JPEG File for use
// as the poster. Loads the video into an offscreen element, seeks a little way
// in (to dodge a black/blank first frame), draws the frame to a canvas capped
// at MAX_DIM, and re-encodes as JPEG @JPEG_QUALITY — same approach as
// optimizeImage. Returns null if the browser can't decode the codec (e.g. HEVC
// on a non-Apple desktop) or anything else goes wrong, so the caller can simply
// skip the poster.
async function captureVideoPoster(file: File): Promise<File | null> {
  if (!file.type.startsWith('video/')) return null;
  let url: string | null = null;
  const video = document.createElement('video');
  try {
    url = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = url;

    // Wait for enough data to know dimensions and to draw a frame.
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error('video decode failed'));
      video.onerror = fail;
      video.onloadeddata = () => resolve();
      // Safari sometimes fires loadedmetadata but not loadeddata until play;
      // a timeout keeps us from hanging on a codec the browser won't decode.
      setTimeout(fail, 5000);
    });

    // Seek a short way in: 1s, or 10% for very short clips. Clamp inside duration.
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    const target = dur ? Math.min(1, dur * 0.1) : 0;
    if (target > 0) {
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error('video seek failed'));
        video.currentTime = target;
        setTimeout(resolve, 3000); // draw whatever frame we have if seek stalls
      });
    }

    let w = video.videoWidth;
    let h = video.videoHeight;
    if (!w || !h) return null;
    if (w > MAX_DIM || h > MAX_DIM) {
      const r = Math.min(MAX_DIM / w, MAX_DIM / h);
      w = Math.round(w * r);
      h = Math.round(h * r);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) return null;
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'video';
    return new File([blob], baseName + '-poster.jpg', { type: 'image/jpeg' });
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    if (url) URL.revokeObjectURL(url);
  }
}

async function presignAndPut(
  presignURL: string,
  file: File,
  filename: string,
  kind?: 'original',
): Promise<string> {
  const res = await fetch(presignURL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename,
      contentType: file.type,
      size: file.size,
      ...(kind ? { kind } : {}),
    }),
  });
  if (!res.ok) throw new Error('Could not get upload URL');
  const { url, key } = await res.json();
  const put = await fetch(url, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
  if (!put.ok) throw new Error('Upload failed for ' + file.name);
  return key;
}

export async function uploadOne(
  file: File,
  presignURL: string,
  ctx?: { author?: string; title?: string },
): Promise<UploadedMedia> {
  // Build the identifying base from author + title (or fall back to the file's
  // original name) so archived keys are human-readable.
  const originalBase = file.name.replace(/\.[^.]+$/, '');
  const origExt = (file.name.match(/\.[^.]+$/) || [''])[0] || '';
  const base = composeBase(ctx, originalBase);

  // Try to web-optimize. If we got an optimized version, upload the ORIGINAL
  // into media/originals/ and the optimized into media/u/. If optimization
  // isn't possible (HEIC, GIF, decode error), just upload the file as-is.
  const optimized = await optimizeImage(file);

  if (optimized) {
    let originalKey: string | undefined;
    try {
      originalKey = await presignAndPut(presignURL, file, base + origExt, 'original');
    } catch {
      originalKey = undefined;
    }
    const key = await presignAndPut(presignURL, optimized, base + '.jpg');
    return originalKey
      ? { type: 'image', src: key, original: originalKey, caption: '' }
      : { type: 'image', src: key, caption: '' };
  }

  const key = await presignAndPut(presignURL, file, base + origExt);
  const type: UploadedMedia['type'] =
    file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'video';

  // For video, try to grab a poster frame in the browser and upload it as a
  // second object. On any failure we just omit it; the site falls back to the
  // filmstrip cover.
  if (type === 'video') {
    const posterFile = await captureVideoPoster(file);
    if (posterFile) {
      try {
        const poster = await presignAndPut(presignURL, posterFile, base + '-poster.jpg');
        return { type, src: key, poster, caption: '' };
      } catch {
        /* poster upload failed — fall through without it */
      }
    }
  }

  return { type, src: key, caption: '' };
}
