#!/usr/bin/env bash
#
# One-time AWS provisioning for the static site.
#
#   ./setup-aws.sh
#
# Stands up everything the site needs, via a single CloudFormation stack:
#   • private S3 bucket
#   • CloudFront distribution (HTTPS, custom domain, locked to the bucket)
#   • ACM TLS certificate (validated automatically through Route 53)
#   • Route 53 A/AAAA alias records for your subdomain
#
# Re-running it is safe — CloudFormation updates the existing stack in place.
# To tear everything down later:  aws cloudformation delete-stack \
#   --region us-east-1 --stack-name "$STACK_NAME"  (then empty the bucket first).
#
# Reads BUCKET / SITE_DOMAIN / ROOT_DOMAIN from .deploy.env, then writes the
# resulting DISTRIBUTION_ID back into .deploy.env so ./deploy.sh just works.

# Note: deliberately NOT using `set -u`. macOS ships bash 3.2 (2007), whose
# nounset has a bug that falsely flags set variables as unbound. We default
# every variable with ${VAR:-} anyway, so nounset buys us nothing here.
set -eo pipefail
cd "$(dirname "$0")"

if [ -f .deploy.env ]; then
  set -a; . ./.deploy.env; set +a
fi

BUCKET="${BUCKET:-}"
SITE_DOMAIN="${SITE_DOMAIN:-}"
ROOT_DOMAIN="${ROOT_DOMAIN:-}"
STACK_NAME="${STACK_NAME:-celebrate-kristin-site}"
REGION="us-east-1"   # CloudFront's cert must live here; keep the whole stack in it.

# ── Sanity checks ────────────────────────────────────────────────────────────
command -v aws >/dev/null 2>&1 || {
  echo "✗ AWS CLI not found. Install it first:  brew install awscli" >&2
  exit 1
}

missing=""
[ -z "$BUCKET" ]      && missing="$missing BUCKET"
[ -z "$SITE_DOMAIN" ] && missing="$missing SITE_DOMAIN"
[ -z "$ROOT_DOMAIN" ] && missing="$missing ROOT_DOMAIN"
if [ -n "$missing" ]; then
  echo "✗ Missing config:$missing" >&2
  echo "  Copy .deploy.env.example to .deploy.env and fill it in." >&2
  exit 1
fi

aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "✗ Not authenticated to AWS. Run:  aws configure" >&2
  exit 1
}

# ── Find the Route 53 hosted zone for the root domain ────────────────────────
echo "→ Looking up Route 53 hosted zone for $ROOT_DOMAIN..."
ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "${ROOT_DOMAIN}." \
  --query "HostedZones[?Name=='${ROOT_DOMAIN}.'].Id | [0]" --output text)
if [ -z "$ZONE_ID" ] || [ "$ZONE_ID" = "None" ]; then
  echo "✗ No Route 53 hosted zone found for $ROOT_DOMAIN." >&2
  echo "  Check ROOT_DOMAIN, or confirm the domain is hosted in this AWS account." >&2
  exit 1
fi
ZONE_ID="${ZONE_ID#/hostedzone/}"
echo "  hosted zone: $ZONE_ID"

# ── Deploy the stack ─────────────────────────────────────────────────────────
echo "→ Deploying CloudFormation stack '$STACK_NAME' in $REGION..."
echo "  Provisions S3 + CloudFront + ACM + DNS, and waits for the TLS cert to"
echo "  validate and CloudFront to roll out. This typically takes 5–25 minutes."
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file infra/site.yml \
  --parameter-overrides \
      BucketName="$BUCKET" \
      SiteDomain="$SITE_DOMAIN" \
      HostedZoneId="$ZONE_ID" \
  --no-fail-on-empty-changeset

# ── Read outputs + save DISTRIBUTION_ID back into .deploy.env ────────────────
DIST_ID=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue | [0]" --output text)

update_env() {
  local key="$1" val="$2" file=".deploy.env"
  touch "$file"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    grep -v "^${key}=" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$file"
}

if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
  update_env DISTRIBUTION_ID "$DIST_ID"
  echo "  saved DISTRIBUTION_ID=$DIST_ID to .deploy.env"
fi

echo "✓ Infrastructure ready  →  https://$SITE_DOMAIN"
echo "  Next:  ./deploy.sh   (builds and publishes the site)"
echo "  Note: a brand-new domain can take a little while to resolve everywhere."
