# Data model

Everything in this project keys off one idea: **one submission = one JSON file.**
Those files are the source of truth. The capture form writes them; the static
site reads them; git stores them. Get this shape right and both phases fall out
of it for free.

## One entry

Each story is a single JSON file under `src/content/entries/`, named with a
clean, human, URL-safe id:

```
src/content/entries/the-road-trip-to-big-sur.json
```

The filename (minus `.json`) becomes the entry's `id` and its page URL
(`/memory/the-road-trip-to-big-sur`). The id is a slug of the **title**, falling
back to the **author's name** when there's no title, with a numeric suffix
(`-2`, `-3`, …) added only to avoid colliding with an existing entry. No date,
no random string. It is **assigned once at creation and never changes** — so
editing a title later won't break the URL or the contributor's edit access.
Ordering ("most recent") comes from the `submittedAt` field, not the filename.

### Schema

```jsonc
{
  "author": {
    "name": "Jane Doe",                 // required — shown publicly
    "relationship": "College roommate"  // optional — free text, shown publicly
  },
  "title": "The road trip to Big Sur",  // optional — a headline for the story
  "body": "We left at 4am...\n\nBy noon we were...",  // optional — the story (a memory may be media-only)
  "media": [                            // optional — 0 or more attachments
    {
      "type": "image",                  // "image" | "audio" | "video"
      "src": "/media/2026-06-14-jane-doe-big-sur/sunset.jpg",
      "caption": "Pfeiffer Beach, summer '98",  // optional
      "alt": "Orange sky over a rocky beach"      // optional, images only
    }
  ],
  "submittedAt": "2026-06-14T18:32:00Z", // ISO 8601 UTC — sorting only, never shown
  "memoryDate": "1998-07-04",            // optional: when the memory happened (past only)
  "status": "published"                  // "published" | "hidden" (admin hide w/o deleting)
}
```

The authoritative, machine-checked version of this schema lives in
[`src/content.config.ts`](../src/content.config.ts) as a Zod schema. Astro
validates every entry against it at build time, so a malformed submission fails
the build instead of silently rendering broken. **That file and this document
must stay in sync** — Zod is the law, this is the explanation.

### Field notes

- **`author.name`** — the only truly required identity field. No accounts, no logins.
- **`submittedAt`** vs **`memoryDate`** — `submittedAt` orders the gallery (newest
  first) but is *never displayed*. `memoryDate` is the optional date the memory
  itself happened; it's the only date readers see, and only when given. It must be
  in the past — future dates are treated as errors and dropped at capture time.
- **`body`** — *optional*: a memory may be media-only. A valid submission needs
  a `name` plus **either** a `body` or at least one `media` item (enforced on the
  form and in the backend). Stored as plain text; blank lines separate paragraphs.
  It is rendered through Astro's auto-escaping, so user text can never inject
  HTML/JS into the page. (We can upgrade to full Markdown later by adding a
  renderer; the stored format doesn't change.)
- **`media[].src`** — a path under `public/`, i.e. `/media/<entry-id>/<file>`.
  During capture these may temporarily be S3 keys; the *freeze* step downloads
  them into `public/media/` and rewrites the paths to local ones.
- **`media[].original`** — optional path to the *untouched* uploaded file. For
  images the form generates a web-optimized JPEG (max 2000px, EXIF stripped,
  ~85% quality) at `src` and saves the unmodified upload at `original`. The
  site displays `src`; `original` exists for archival and "download original"
  links. Stored under `/media/originals/` instead of `/media/u/`. For **video**,
  the upload IS the master: it goes straight to `/media/originals/` and both
  `src` and `original` point at it.
- **Video transcoding fields** (`type: "video"`): on upload the master plays
  progressively from `src` and the item is marked `processing: true`. The backend
  runs AWS MediaConvert (see `docs/DEPLOY-MEDIACONVERT.md`) to produce:
  - **`media[].hls`** — the adaptive HLS manifest (`…/index.m3u8`). When present,
    players prefer it over `src` (native HLS on Safari/iOS, hls.js elsewhere,
    progressive `src` as fallback).
  - **`media[].poster`** — a server-generated JPEG thumbnail (replaces the old,
    unreliable browser-side frame grab; works for every codec including HEVC).
  - **`media[].processing`** — `true` only between submit and job completion;
    removed once `hls` + `poster` are filled in (or on transcode error).
- **`status: "hidden"`** — lets an admin pull a story from the public site
  without destroying the submission. The archive build skips hidden entries.

### Deliberately NOT in the archive

- **Email / contact info.** If the capture form collects an email (for "let me
  know when it's live" or moderation contact), it is kept in a *separate private
  store* — never written into these public JSON files. The Zod schema strips any
  unknown keys, so even an accidental `email` field won't reach the built site.
- **IP addresses, user agents, raw upload metadata.** Capture-time only.

## Media format rules (future-proofing)

The archive must still open in 20 years, so the freeze step normalizes media to
universal, non-proprietary formats:

| Kind  | Store as            | Notes                                              |
|-------|---------------------|----------------------------------------------------|
| Photo | JPEG (or PNG)       | Strip EXIF GPS; downscale huge phone shots.         |
| Audio | MP3                 | ~128–192 kbps is plenty for voice/memories.         |
| Video | MP4 (H.264 + AAC)   | **Transcode iPhone HEVC/.mov → MP4** so it plays everywhere. |

Always keep the **originals** in a separate `originals/` archive (off the public
site) in case you ever want to re-encode.
