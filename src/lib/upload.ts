// Shared upload flow used by the share form AND the reflection form.
//
// For images: upload the ORIGINAL untouched, then create a web-optimized JPEG
// (max 2400px, EXIF stripped, JPEG @0.85) and upload that. Return both keys;
// the site displays the optimized one (`src`) and keeps the original (`original`)
// as a permanent archive.
//
// For video: a single upload of the master file to media/originals/ (kind:'original')
// — this is both the permanent archive and the source the backend feeds to AWS
// MediaConvert. The item comes back marked `processing: true`; the backend later
// transcodes it to adaptive HLS and fills in `hls` + a server-generated `poster`.
// We deliberately do NOT grab a poster in the browser anymore — it failed for
// HEVC/.mov on non-Apple devices; MediaConvert produces a reliable one for every
// codec instead.
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
  hls?: string; // video only: set by the backend after transcoding, not at upload time
  processing?: boolean; // video only: true until the backend finishes transcoding
  poster?: string; // video only: server-generated cover/poster (added after transcoding)
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

export interface UploadProgress {
  loaded: number; // bytes sent so far
  total: number; // total bytes
  fraction: number; // 0..1
}
export type OnUploadProgress = (p: UploadProgress) => void;

// PUT the file to S3 with progress reporting. We use XMLHttpRequest rather than
// fetch because fetch can't report upload (request-body) progress — essential
// feedback for the multi-GB video masters. Resolves on a 2xx, rejects otherwise.
function putWithProgress(url: string, file: File, onProgress?: OnUploadProgress): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress({ loaded: e.loaded, total: e.total, fraction: e.total ? e.loaded / e.total : 0 });
        }
      };
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed for ${file.name} (HTTP ${xhr.status})`));
    xhr.onerror = () => reject(new Error('Upload failed for ' + file.name));
    xhr.onabort = () => reject(new Error('Upload canceled for ' + file.name));
    xhr.send(file);
  });
}

async function presignAndPut(
  presignURL: string,
  file: File,
  filename: string,
  kind?: 'original',
  onProgress?: OnUploadProgress,
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
  await putWithProgress(url, file, onProgress);
  return key;
}

// S3 rejects a single PUT larger than 5 GiB — files that big need multipart
// upload, which this direct-to-S3 flow doesn't do. Stop early with a clear
// message instead of uploading for ages and then getting a cryptic 403.
const S3_MAX_PUT = 5 * 1024 * 1024 * 1024;

export async function uploadOne(
  file: File,
  presignURL: string,
  ctx?: { author?: string; title?: string },
  onProgress?: OnUploadProgress,
): Promise<UploadedMedia> {
  if (file.size > S3_MAX_PUT) {
    throw new Error(
      `"${file.name}" is ${(file.size / 1e9).toFixed(1)} GB — too large to upload here ` +
        `(the limit is about 5 GB). Please ask the site owner to add it directly.`,
    );
  }

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
      // The original is the larger upload — report progress on it.
      originalKey = await presignAndPut(presignURL, file, base + origExt, 'original', onProgress);
    } catch {
      originalKey = undefined;
    }
    const key = await presignAndPut(presignURL, optimized, base + '.jpg');
    return originalKey
      ? { type: 'image', src: key, original: originalKey, caption: '' }
      : { type: 'image', src: key, caption: '' };
  }

  const type: UploadedMedia['type'] =
    file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'video';

  // Video: upload the master to media/originals/ (kind:'original') — it's both the
  // archive and the MediaConvert source. `src` points at it so the clip plays
  // progressively right away; `processing` tells the UI a transcode is pending.
  // The backend swaps in `hls` + `poster` once MediaConvert completes.
  if (type === 'video') {
    const key = await presignAndPut(presignURL, file, base + origExt, 'original', onProgress);
    return { type, src: key, original: key, processing: true, caption: '' };
  }

  // Audio (and any image that couldn't be optimized, e.g. HEIC/GIF): upload as-is.
  const key = await presignAndPut(presignURL, file, base + origExt, undefined, onProgress);
  return { type, src: key, caption: '' };
}
