# Remembering Kristin

A place for friends and family to share stories, memories, and reflections —
in words, photos, audio, and video.

> Working title / directory name — rename freely.

## How it's built

Two phases, on purpose:

1. **Capture** (temporary) — an invite-only form where people submit memories.
   Big media (photos/audio/video) uploads straight to object storage; each
   submission is saved as one JSON file. See [`capture/`](capture/).
2. **Archive** (permanent, future-proof) — a static site generated from those
   JSON files. Plain HTML + media, no database, no server. Hosts on Cloudflare
   Pages / Netlify / S3+CloudFront. Almost nothing to hack.

The bridge between them is the **data model**: one submission = one JSON file.
Read [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) first — everything keys off it.

## Project layout

```
remembering-kristin/
├── docs/DATA-MODEL.md        # the spec everything keys off
├── src/
│   ├── content.config.ts     # Zod schema = the enforced data model
│   ├── content/entries/      # one JSON file per submission (source of truth)
│   ├── layouts/Base.astro    # shared page shell + styling
│   ├── components/Media.astro # renders an image/audio/video attachment
│   └── pages/
│       ├── index.astro       # the memorial — lists all stories
│       ├── entry/[id].astro  # one full story per page
│       └── share.astro       # the capture form (Phase 1 UI)
├── public/media/             # photos/audio/video, organized by entry id
└── capture/                  # serverless upload + submit handlers (Phase 1)
```

## Running it

```bash
npm install
npm run dev        # local preview at http://localhost:4321
npm run build      # builds the static archive into ./dist
npm run preview    # serve the built archive locally
```

## Freezing it (Phase 1 → Phase 2)

When capture is done:

1. Download all media from object storage into `public/media/<entry-id>/`.
2. Rewrite each entry's `media[].src` to the local path.
3. Transcode video to MP4/H.264, audio to MP3 (see DATA-MODEL.md).
4. `npm run build`, commit `dist/` (or deploy it), and take the capture form down.

The git repo — JSON + media + templates — *is* the durable backup.
