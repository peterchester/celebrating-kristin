// Extract a recording/capture date from an email attachment's embedded
// metadata, for use as a memory's `memoryDate`. Best-effort and defensive:
// every reader returns null rather than throwing, so a corrupt or exotic file
// just means "no date" and the entry falls back to having no memoryDate.
//
// By source:
//   image  → EXIF DateTimeOriginal / CreateDate (JPEG, HEIC, TIFF) via exifr
//   video  → ISO-BMFF / QuickTime `mvhd` creation_time (MP4, MOV, M4V) — a
//            small built-in parser, no dependency
//   audio  → tagged recording date (MP3 ID3, M4A, FLAC, …) via music-metadata
//
// Only a full calendar date (YYYY-MM-DD) counts — a bare year isn't precise
// enough for memoryDate, so it's discarded.

import exifr from 'exifr';
import { parseBuffer } from 'music-metadata';

// Reject obviously-wrong clock values. Cameras whose clock was never set report
// epoch-ish dates; we treat anything before this floor (or in the future) as
// junk and return null instead of poisoning the memoryDate.
const FLOOR_MS = Date.UTC(1995, 0, 1);

// Seconds between the QuickTime/ISO-BMFF epoch (1904-01-01 UTC) and the Unix
// epoch (1970-01-01 UTC).
const SECONDS_1904_TO_1970 = 2082844800;

// Clamp a Date to a valid memoryDate string (YYYY-MM-DD, UTC), or null. Future
// and implausibly-old dates are rejected.
function toYMD(date, now = new Date()) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return null;
  const t = date.getTime();
  if (t > now.getTime() || t < FLOOR_MS) return null;
  return date.toISOString().slice(0, 10);
}

// Pull YYYY-MM-DD out of an EXIF datetime string ("2019:07:04 13:00:00") or an
// ISO-ish string ("2019-07-04T…"). Returns a string or null — no timezone math,
// so the calendar date is exactly what the camera recorded.
function ymdFromString(s, now = new Date()) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})[:-](\d{2})[:-](\d{2})/);
  if (!m) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  // Validate range via a UTC Date built from the parts.
  return toYMD(new Date(`${ymd}T00:00:00Z`), now);
}

async function imageDate(buf, now) {
  try {
    // reviveValues:false keeps the raw EXIF strings so we read the camera's
    // local calendar date directly, with no timezone reinterpretation.
    const out = await exifr.parse(buf, { reviveValues: false, pick: ['DateTimeOriginal', 'CreateDate'] });
    return ymdFromString(out?.DateTimeOriginal || out?.CreateDate, now);
  } catch {
    return null;
  }
}

// Walk sibling ISO-BMFF boxes in [start, end) and return the first matching
// type as { off, size, headerSize }, or null. Handles 32- and 64-bit sizes.
function findBox(buf, start, end, type) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const boxType = buf.toString('latin1', off + 4, off + 8);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit largesize follows the type.
      if (off + 16 > end) break;
      const hi = buf.readUInt32BE(off + 8);
      const lo = buf.readUInt32BE(off + 12);
      size = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - off; // extends to end of buffer
    }
    if (size < headerSize || off + size > end) break;
    if (boxType === type) return { off, size, headerSize };
    off += size;
  }
  return null;
}

function videoDate(buf, now) {
  try {
    const moov = findBox(buf, 0, buf.length, 'moov');
    if (!moov) return null;
    const mvhd = findBox(buf, moov.off + moov.headerSize, moov.off + moov.size, 'mvhd');
    if (!mvhd) return null;
    const p = mvhd.off + mvhd.headerSize; // version(1) + flags(3) + creation_time…
    const version = buf.readUInt8(p);
    let creation;
    if (version === 1) {
      const hi = buf.readUInt32BE(p + 4);
      const lo = buf.readUInt32BE(p + 8);
      creation = hi * 2 ** 32 + lo;
    } else {
      creation = buf.readUInt32BE(p + 4);
    }
    if (!creation) return null; // 0 = unknown
    return toYMD(new Date((creation - SECONDS_1904_TO_1970) * 1000), now);
  } catch {
    return null;
  }
}

async function audioDate(buf, contentType, now) {
  try {
    const meta = await parseBuffer(buf, contentType ? { mimeType: contentType } : undefined, { duration: false });
    const d = meta?.common?.date; // e.g. "2019-07-04", "2019-07", or "2019"
    return ymdFromString(d, now);
  } catch {
    return null;
  }
}

// Return YYYY-MM-DD for one attachment's embedded capture date, or null. `att`
// is a mailparser attachment: { content: Buffer, contentType: string, … }.
export async function recordingDate(att, now = new Date()) {
  const buf = att?.content;
  if (!buf || !buf.length) return null;
  const ct = String(att.contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return imageDate(buf, now);
  if (ct.startsWith('video/')) return videoDate(buf, now);
  if (ct.startsWith('audio/')) return audioDate(buf, ct, now);
  return null;
}

// Across all attachments, return the EARLIEST valid capture date (the memory
// most likely happened around the oldest piece), or null if none carry one.
export async function earliestRecordingDate(attachments, now = new Date()) {
  let earliest = null;
  for (const att of attachments || []) {
    const ymd = await recordingDate(att, now);
    if (ymd && (!earliest || ymd < earliest)) earliest = ymd; // ISO dates sort lexically
  }
  return earliest;
}
