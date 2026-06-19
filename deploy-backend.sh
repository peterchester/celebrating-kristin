#!/usr/bin/env bash
#
# Deploy the capture Lambda to AWS via SAM.
#
#   ./deploy-backend.sh
#
# Config lives in .deploy.env (gitignored). Copy .deploy.env.example to
# .deploy.env and fill in the backend section. You can also pass variables
# as environment variables: ADMIN_TOKEN=... ./deploy-backend.sh

set -eo pipefail
cd "$(dirname "$0")"

if [ -f .deploy.env ]; then
  set -a; . ./.deploy.env; set +a
fi

STACK="${STACK_NAME:-celebrate-kristin-backend}"
SITE_BUCKET="${BUCKET:-}"
ALLOW_ORIGIN="${ALLOW_ORIGIN:-https://celebrate.kristinallen.com}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
TURNSTILE_SECRET="${TURNSTILE_SECRET:-}"
NOTIFY_FROM="${NOTIFY_FROM:-}"
EMAIL_ADDRESS="${EMAIL_ADDRESS:-}"
SITE_URL="${SITE_URL:-}"

command -v sam >/dev/null 2>&1 || {
  echo "✗ AWS SAM CLI not found. Install it: brew install aws-sam-cli" >&2
  exit 1
}

if [ -z "$SITE_BUCKET" ]; then
  echo "✗ BUCKET is not set — check your .deploy.env." >&2
  exit 1
fi

aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "✗ Not authenticated to AWS. Run: aws configure" >&2
  exit 1
}

# Build the --parameter-overrides string. Omit optional params when empty so
# SAM uses the template defaults instead of rejecting an empty value.
OVERRIDES="SiteBucketName=${SITE_BUCKET} AllowOrigin=${ALLOW_ORIGIN}"
[ -n "$ADMIN_TOKEN" ]      && OVERRIDES="$OVERRIDES AdminToken=${ADMIN_TOKEN}"
[ -n "$TURNSTILE_SECRET" ] && OVERRIDES="$OVERRIDES TurnstileSecret=${TURNSTILE_SECRET}"
[ -n "$NOTIFY_FROM" ]      && OVERRIDES="$OVERRIDES NotifyFrom=${NOTIFY_FROM}"
[ -n "$EMAIL_ADDRESS" ]    && OVERRIDES="$OVERRIDES EmailAddress=${EMAIL_ADDRESS}"
[ -n "$SITE_URL" ]         && OVERRIDES="$OVERRIDES SiteUrl=${SITE_URL}"

echo "→ Deploying Lambda stack '${STACK}'..."
sam deploy \
  --stack-name "$STACK" \
  --region us-east-1 \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides $OVERRIDES

echo "✓ Backend deployed."
