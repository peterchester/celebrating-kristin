// Minimal ID3v2 reader: pulls just the track title and artist out of an MP3's
// tag, client-side, with no dependency. We deliberately parse only the two text
// frames the playlist needs rather than shipping a full metadata library to the
// browser — the same spirit as the hand-written video-date parser in
// capture/email/mediadate.mjs (which hand-rolls an ISO-BMFF box walk instead of
// pulling a dep).
//
// Supports ID3v2.2 (TT2/TP1) and v2.3/v2.4 (TIT2/TPE1), the common text
// encodings (latin1, UTF-16 w/ BOM, UTF-16BE, UTF-8), and whole-tag
// unsynchronisation. Anything it can't parse yields nothing, and the caller
// falls back to a filename-derived label — so a blank/exotic tag never breaks,
// it just means "no embedded title".

export interface AudioTags {
  title?: string;
  artist?: string;
}

// A synchsafe integer stores 7 bits per byte (top bit always 0) — used for the
// tag size (all versions) and, in v2.4, frame sizes.
function synchsafe(b: Uint8Array, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}
function uint32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

// Decode one text-frame payload: the first byte is the encoding, the rest the
// string. NUL characters (frame terminators / padding) are stripped so a
// null-terminated value reads cleanly.
function decodeText(bytes: Uint8Array): string {
  if (bytes.length < 2) return '';
  const enc = bytes[0];
  const body = bytes.subarray(1);
  const label = enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'latin1';
  let s: string;
  try {
    s = new TextDecoder(label).decode(body);
  } catch {
    s = new TextDecoder('latin1').decode(body);
  }
  return s.replace(/\u0000+$/, "").replace(/\u0000/g, "").trim();
}

// Reverse unsynchronisation: every 0xFF 0x00 pair collapses back to 0xFF.
function deUnsync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

export async function readAudioTags(file: Blob): Promise<AudioTags> {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {}; // not "ID3"
    const major = head[3];
    const unsync = (head[5] & 0x80) !== 0;
    const extended = (head[5] & 0x40) !== 0;
    const size = synchsafe(head, 6);

    let body = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    if (unsync) body = deUnsync(body);

    let off = 0;
    // Skip an extended header if present (v2.4 size is synchsafe and covers
    // itself; v2.3 declares its own remaining length after a 4-byte size field).
    if (extended) {
      off += major >= 4 ? synchsafe(body, 0) : uint32(body, 0) + 4;
    }

    const idLen = major === 2 ? 3 : 4;
    const hdrLen = major === 2 ? 6 : 10;
    const want = major === 2 ? { title: 'TT2', artist: 'TP1' } : { title: 'TIT2', artist: 'TPE1' };
    const tags: AudioTags = {};

    while (off + hdrLen <= body.length) {
      const id = String.fromCharCode(...body.subarray(off, off + idLen));
      if (id.charCodeAt(0) === 0) break; // hit padding
      const frameSize =
        major === 2
          ? (body[off + 3] << 16) | (body[off + 4] << 8) | body[off + 5]
          : major >= 4
            ? synchsafe(body, off + 4)
            : uint32(body, off + 4);
      const dataStart = off + hdrLen;
      if (frameSize <= 0 || dataStart + frameSize > body.length) break;
      if (id === want.title || id === want.artist) {
        const text = decodeText(body.subarray(dataStart, dataStart + frameSize));
        if (id === want.title && text) tags.title = text;
        if (id === want.artist && text) tags.artist = text;
        if (tags.title && tags.artist) break;
      }
      off = dataStart + frameSize;
    }
    return tags;
  } catch {
    return {};
  }
}
