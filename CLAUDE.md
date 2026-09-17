# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Local dev (Astro site only — gallery shows if public/data/index.json exists)
npm run dev          # http://localhost:4321

# Full capture loop offline (two terminals)
npm run capture      # local mock backend on :8787 (Node built-ins only, no installs)
npm run dev          # site on :4321 — submit at /share, hot-reloads to show entry

# Build / preview
npm run build        # static archive → ./dist
npm run preview      # serve ./dist locally

# Deploy
./deploy.sh                    # build + S3 sync + CloudFront invalidate (reads .deploy.env)
npm run deploy-backend         # SAM deploy of the Lambda (reads .deploy.env for SAM params)
node scripts/seed-fake.mjs     # generate fake entries for testing
node scripts/seed-fake.mjs --clean  # remove seed entries before deploying
```

Node version is pinned in `.nvmrc` — run `nvm use` before installing packages.

## Architecture

### Two-phase design

**Phase 1 — Capture**: An invite-only share form (`/share`) accepts text, photos, audio, and video. Big media uploads directly to S3 via presigned URLs (never through Lambda). Each submission becomes one JSON file stored in S3 (`entries/<id>.json`).

**Phase 2 — Archive (freeze)**: When capture closes, download all S3 media into `public/media/`, rewrite `src` paths in each entry JSON, transcode HEVC/MOV → MP4, then `npm run build`. The resulting `./dist` is a self-contained static site that needs nothing to run.

### Data flow: the two runtimes

The site mixes build-time and runtime data fetching:

| Path | Written by | Read by |
|------|-----------|---------|
| `src/content/entries/*.json` | dev hand-edits / freeze step | Astro build (Zod-validated) |
| `public/entries/<id>.json` | Lambda / dev-server | browser JS (`fetchEntry`) |
| `public/data/index.json` | Lambda / dev-server | browser JS (gallery + nav) |
| `public/comments/<id>.json` | Lambda / dev-server | browser JS (reflections) |

During dev, `npm run capture` (dev-server.mjs) writes to `public/` which the Astro dev server serves live. In production, Lambda writes to the S3 site bucket and sets `Cache-Control: no-cache` so new memories appear immediately.

### Routing trick

`src/pages/memory/index.astro` is a single static page that serves **all** `/memory/<slug>` routes. In production this works via a CloudFront function/rule that rewrites those paths to `/memory/`. In local dev, `astro.config.mjs` installs a Vite middleware that does the same rewrite. The page reads the slug from `window.location.pathname` in browser JS and fetches `/entries/<id>.json`.

### Key files

- **`src/content.config.ts`** — Zod schema for entries. This is the law; `docs/DATA-MODEL.md` is the prose explanation. Zod strips unknown keys, so private fields (email, IP) can never leak into a built site even if they land in a JSON file. The two must stay in sync.
- **`src/lib/render.ts`** — client-side HTML builders that produce the same markup as the Astro components. Every user string goes through `esc()`. The gallery and post page are fully client-rendered from JSON; there are no server-rendered memory pages.
- **`src/lib/upload.ts`** — handles the presign → PUT flow. Images get web-optimized (max 2000px, JPEG @0.85, EXIF stripped via canvas) and uploaded to `media/u/`; the untouched original goes to `media/originals/`. Audio/video get a single upload, no optimization.
- **`capture/dev-server.mjs`** — local mock (Node built-ins only). Mirrors every endpoint the Lambda exposes: `/presign`, `/submit`, `/update`, `/delete`, `/comment`, `/comment-delete`. Ground truth for the API contract.
- **`capture/lambda.mjs`** — production Lambda. Same logic as dev-server but reads/writes S3 instead of the local filesystem.
- **`template.yaml`** — AWS SAM definition for the Lambda + private S3 bucket. Lambda requires `SITE_BUCKET`, `PRIVATE_BUCKET`, and optionally `ADMIN_TOKEN`, `TURNSTILE_SECRET`, `NOTIFY_FROM`, `SITE_URL`.

### Environment variables

Configured in `.deploy.env` (gitignored; copy from `.deploy.env.example`):

| Var | Purpose |
|-----|---------|
| `BUCKET` | Public S3 bucket for site + entries + media |
| `DISTRIBUTION_ID` | CloudFront distribution (for cache invalidation in deploy.sh) |
| `PUBLIC_PRESIGN_API` | Lambda URL + `/presign` (baked into build by deploy.sh) |
| `PUBLIC_SUBMIT_API` | Lambda URL + `/submit` (baked into build) |
| `PUBLIC_API_BASE` | Overrides API root for update/delete/comment (derived from SUBMIT_API if absent) |
| `PUBLIC_TURNSTILE_SITE_KEY` | Cloudflare Turnstile public key (dev defaults to always-pass test key) |

In `npm run dev` without a running `npm run capture`, the form runs in "preview mode" — it logs the submission JSON to the console but doesn't save anything.

### Security constraints

- **Email is private**: `/submit` receives `email` but it must never be written to the public entry JSON. Both dev-server and Lambda strip it into a private store (`capture/private/contacts.jsonl` locally; private S3 bucket in production).
- **Edit tokens**: each submission issues a random 16-byte hex token stored only in the contributor's browser (`rk_owner` cookie, 90 days). Only the SHA-256 hash is stored server-side. The admin token (`rk_admin` cookie / `ADMIN_TOKEN` env) overrides ownership checks.
- **deploy.sh** excludes `entries/*`, `comments/*`, `data/*`, `media/u/*`, `media/originals/*` from `--delete` sync, so deploying a new build never wipes user submissions already in S3.
- **Entry IDs** are slugs of the title (fallback: author name), assigned once at creation and never changed. Collisions get `-2`, `-3` suffixes. The URL is stable even if the title is later edited.
