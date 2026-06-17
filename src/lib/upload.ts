// Shared upload flow used by the share form AND the reflection form.
//
// For images: upload the ORIGINAL untouched, then create a web-optimized JPEG
// (max 2400px, EXIF stripped, JPEG @0.85) and upload that. Return both keys;
// the site displays the optimized one (`src`) and keeps the original (`original`)
// as a permanent archive.
//
// For audio/video: a single upload, no `original`.
//
// Both uploads go through the existing presign + PUT flow; the `kind: 'original'`
// flag tells the backend to stash the file under media/originals/ instead of
// media/u/.

const MAX_DIM = 2400;
const JPEG_QUALITY = 0.85;

export interface UploadedMedia {
  type: 'image' | 'audio' | 'video';
  src: string;
  original?: string;
  caption: string;
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

async function presignAndPut(presignURL: string, file: File, kind?: 'original'): Promise<string> {
  const res = await fetch(presignURL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
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

export async function uploadOne(file: File, presignURL: string): Promise<UploadedMedia> {
  // Try to web-optimize first. If we got an optimized version, upload the
  // ORIGINAL into media/originals/ and the optimized into media/u/. If
  // optimization isn't possible (HEIC, GIF, decode error), just upload the file
  // as-is to media/u/ — no `original` recorded.
  const optimized = await optimizeImage(file);

  if (optimized) {
    let originalKey: string | undefined;
    try {
      originalKey = await presignAndPut(presignURL, file, 'original');
    } catch {
      // If keeping the original fails, still publish the optimized version.
      originalKey = undefined;
    }
    const key = await presignAndPut(presignURL, optimized);
    return originalKey
      ? { type: 'image', src: key, original: originalKey, caption: '' }
      : { type: 'image', src: key, caption: '' };
  }

  const key = await presignAndPut(presignURL, file);
  const type: UploadedMedia['type'] =
    file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'video';
  return { type, src: key, caption: '' };
}
