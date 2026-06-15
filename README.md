# Celebrating Kristin

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
celebrating-kristin/
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

### Testing the full capture loop offline (no AWS)

Open two terminals:

```bash
npm run capture    # local mock backend (capture/dev-server.mjs) on :8787
npm run dev        # the site on :4321
```

Go to http://localhost:4321/share, write a memory, attach a photo/audio/video,
and submit. It writes a real entry to `src/content/entries/`, saves media to
`public/media/`, and the dev site hot-reloads to show it. No cloud, no account,
nothing to install — the mock uses only Node built-ins.

## For Tai 👋

Hey Tai — this is the bones of a place for everyone to leave their stories and
memories of Kristin. Peter set the front end up; the capture backend is yours if
you want it, and it's built to land right in your wheelhouse (Node / serverless
/ AWS).

The form already speaks a tiny two-endpoint contract, and there's a working
**reference implementation** of it in [`capture/dev-server.mjs`](capture/dev-server.mjs)
(the local mock). The AWS version just needs to honor the same shapes:

| Endpoint        | Does                                              | Natural AWS shape                         |
|-----------------|---------------------------------------------------|-------------------------------------------|
| `POST /presign` | returns `{ url, key }` for one file upload        | Lambda → S3 `createPresignedPost`/PUT URL |
| `PUT  <url>`    | the browser uploads bytes **directly** to storage | S3 (never through the Lambda)             |
| `POST /submit`  | saves one entry (`{ author, title, body, media }`) | Lambda → writes the entry JSON            |

Notes that'll save you time:

- **The data model is law** — see [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) and
  the Zod schema in [`src/content.config.ts`](src/content.config.ts). The build
  validates every entry against it, so `/submit` just has to produce that shape.
- **Big videos go straight to S3** via the presigned URL — they never pass
  through the function, so size/timeout limits aren't a concern.
- **Email stays private.** `/submit` receives an optional `email` but it must
  *not* go into the public entry JSON (the mock stashes it in `capture/private/`,
  gitignored). Keep that split in the AWS version.
- **iPhone video is HEVC/.mov** — worth an S3-triggered transcode to MP4/H.264 so
  it plays everywhere (see DATA-MODEL.md).
- **Wiring it up:** the form picks endpoints from `PUBLIC_PRESIGN_API` /
  `PUBLIC_SUBMIT_API` (falling back to the local mock in `npm run dev`). Set
  those to your deployed URLs and nothing else changes.

Thank you for any time you put into this. 🤍

## Freezing it (Phase 1 → Phase 2)

When capture is done:

1. Download all media from object storage into `public/media/<entry-id>/`.
2. Rewrite each entry's `media[].src` to the local path.
3. Transcode video to MP4/H.264, audio to MP3 (see DATA-MODEL.md).
4. `npm run build`, commit `dist/` (or deploy it), and take the capture form down.

The git repo — JSON + media + templates — *is* the durable backup.
