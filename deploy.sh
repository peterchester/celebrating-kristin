#!/usr/bin/env bash
#
# Deploy the static site to S3 + CloudFront.
#
#   ./deploy.sh
#
# What it does, in order:
#   1. Builds the site locally (npm run build → ./dist) — bakes in whatever
#      memories currently exist on THIS machine (src/content/entries + media).
#   2. Uploads ./dist to your S3 bucket (long-cache for hashed assets,
#      no-cache for HTML so updates show immediately).
#   3. Invalidates the CloudFront cache so the edge serves the new build.
#
# Config lives in .deploy.env (gitignored). Copy .deploy.env.example to
# .deploy.env and fill in your bucket + distribution id. You can also pass them
# as environment variables: BUCKET=... DISTRIBUTION_ID=... ./deploy.sh
#
# This script only UPDATES an already-provisioned bucket/distribution. The
# one-time setup (create bucket, ACM cert, CloudFront, DNS) is separate.

# Note: deliberately NOT using `set -u` — macOS bash 3.2 has a nounset bug that
# falsely flags set variables as unbound. Variables are defaulted with ${VAR:-}.
set -eo pipefail
cd "$(dirname "$0")"

# ── Load config ──────────────────────────────────────────────────────────────
if [ -f .deploy.env ]; then
  set -a; . ./.deploy.env; set +a
fi

BUCKET="${BUCKET:-}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:-}"

# ── Sanity checks ────────────────────────────────────────────────────────────
command -v aws >/dev/null 2>&1 || {
  echo "✗ AWS CLI not found. Install it first:  brew install awscli" >&2
  exit 1
}

if [ -z "$BUCKET" ]; then
  echo "✗ BUCKET is not set." >&2
  echo "  Copy .deploy.env.example to .deploy.env and fill it in, or run:" >&2
  echo "    BUCKET=your-bucket-name ./deploy.sh" >&2
  exit 1
fi

aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "✗ Not authenticated to AWS. Run:  aws configure" >&2
  exit 1
}

# ── 1. Build ─────────────────────────────────────────────────────────────────
echo "→ Building site..."
npm run build

if [ ! -d dist ] || [ -z "$(ls -A dist 2>/dev/null)" ]; then
  echo "✗ Build produced no ./dist output — aborting." >&2
  exit 1
fi

# Friendly heads-up if the build still contains fake seed data. seed-fake.mjs
# records the ids it created in this manifest; if it (and the entries) still
# exist, the fakes would be published.
SEED_MANIFEST="public/media/fake/seed-entries.json"
if [ -f "$SEED_MANIFEST" ] && ls src/content/entries/*.json >/dev/null 2>&1; then
  echo "⚠  Heads up: fake seed data appears to still be present ($SEED_MANIFEST)."
  echo "   Run  node scripts/seed-fake.mjs --clean  if you didn't mean to publish it."
fi

# ── 2. Upload ────────────────────────────────────────────────────────────────
# Hashed, content-addressed assets in _astro/ never change → cache forever.
echo "→ Uploading immutable assets (_astro/)..."
if [ -d dist/_astro ]; then
  aws s3 sync dist/_astro "s3://$BUCKET/_astro" \
    --delete \
    --cache-control "public, max-age=31536000, immutable"
fi

# Everything else (HTML, media, json) → no-cache so a redeploy shows up at once.
# (CloudFront is invalidated below regardless; this controls the browser.)
#
# CRITICAL: --delete removes bucket objects not present in dist/. The capture
# backend writes submitted memories (entries/, data/) and uploaded media
# (media/u/) straight to S3 — they are NOT part of the build — so they MUST be
# excluded here, or every deploy would delete everyone's submissions.
echo "→ Uploading pages + media..."
aws s3 sync dist "s3://$BUCKET" \
  --delete \
  --exclude "_astro/*" \
  --exclude "entries/*" \
  --exclude "comments/*" \
  --exclude "data/*" \
  --exclude "media/u/*" \
  --cache-control "public, max-age=0, must-revalidate"

# ── 3. Invalidate CloudFront ─────────────────────────────────────────────────
if [ -n "$DISTRIBUTION_ID" ]; then
  echo "→ Invalidating CloudFront cache..."
  ID=$(aws cloudfront create-invalidation \
        --distribution-id "$DISTRIBUTION_ID" \
        --paths "/*" \
        --query 'Invalidation.Id' --output text)
  echo "  invalidation $ID created (takes a minute or two to complete)"
else
  echo "ℹ DISTRIBUTION_ID not set — skipping CloudFront invalidation."
  echo "  (Fine if you're S3-only for now; set it once CloudFront exists.)"
fi

echo "✓ Deployed."
