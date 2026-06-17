# Email intake (SES inbound)

Let people contribute by email. Send to **celebrate@kristinallen.com**:

- A **fresh email** → a new memory. Subject becomes the title; body becomes the
  text; photo/audio/video attachments become media.
- A **reply to a notification** → a reflection on that memory. Notifications
  carry a `[ref:<id>]` tag in the subject and set `Reply-To: celebrate@…`, so
  replying routes the message back to the right memory.

Spam/virus mail (per SES's scan) is dropped. An optional `AllowSenders`
allowlist can restrict who may contribute.

## How it works

```
celebrate@kristinallen.com
   │  (MX → SES inbound)
   ▼
SES receipt rule  ──►  S3 (raw email, private, auto-expires 90d)
   │                        │
   └──► invokes ───────────►  EmailFn (Lambda, capture/email/)
                                 parse (mailparser) → route by [ref:] →
                                 write entry / reflection + media to S3
```

It writes to the **same S3 layout** as the web form, so emailed memories and
reflections appear on the site exactly like web ones.

## ⚠️ DNS decision — read first

Adding an MX record for `kristinallen.com` sends **all** email for that domain
to SES. SES only acts on addresses your rule matches (`celebrate@`); mail to any
**other** `@kristinallen.com` address is dropped/bounced.

- If `kristinallen.com` is **not** used for any other email → safe to put the MX
  on the apex.
- If it **is** (you have other @kristinallen.com mailboxes) → **do not** use the
  apex. Use a dedicated subdomain instead: set the address to
  `celebrate@mail.kristinallen.com`, verify that subdomain in SES, and put the
  MX on `mail.kristinallen.com`. (Change the `EmailAddress` param accordingly.)

## One-time setup

All in **us-east-1** (SES inbound is region-specific; this matches the rest).

**1. Verify the domain in SES** (same identity used for outbound notifications).
If you set up notification emails already, this is done. Otherwise: SES →
Verified identities → create the domain identity, publish DKIM to Route 53.

**2. Deploy the backend.** `mailparser` is a real dependency now, so you must
`sam build` before deploy:
```bash
read -r ADMIN_TOKEN
sam build
sam deploy --stack-name celebrate-kristin-backend --region us-east-1 --resolve-s3 \
  --capabilities=CAPABILITY_IAM \
  --parameter-overrides \
    SiteBucketName=celebrate-kristinallen-com \
    AllowOrigin=https://celebrate.kristinallen.com \
    "AdminToken=$ADMIN_TOKEN" \
    NotifyFrom=celebrate@kristinallen.com \
    SiteUrl=https://celebrate.kristinallen.com \
    EmailAddress=celebrate@kristinallen.com
```
This creates the inbound bucket, the email Lambda, and the receipt rule set/rule.

**3. Activate the receipt rule set** (CloudFormation can't do this):
```bash
aws ses set-active-receipt-rule-set --rule-set-name celebrate-kristin --region us-east-1
```
(Only one rule set is active per account/region — this replaces any existing one.)

**4. Add the MX record** (see the DNS decision above). For the apex in Route 53:
- Name: `kristinallen.com` (or your subdomain), Type: `MX`,
  Value: `10 inbound-smtp.us-east-1.amazonaws.com`

**5. Production access.** Receiving works in the SES sandbox, but *sending*
notifications to arbitrary contributors needs SES production access (the same
request as for outbound notifications).

## Test

- Email celebrate@kristinallen.com with a subject + a photo → the memory should
  appear within a few seconds. (Watch CloudWatch logs for `celebrate-kristin-email`.)
- Reply to a reflection-notification email → a reflection should appear on that
  memory.

## Notes / limitations (first cut)

- **No image optimization** on the email path (the browser-canvas optimizer only
  runs for web uploads). Emailed photos are stored as sent. Add `sharp` to the
  email Lambda later if needed.
- **No per-contributor edit token** for emailed content — there's no browser
  cookie. Admin can still edit/delete anything via the admin token.
- Tiny inline images (< 8 KB, e.g. signature logos) are skipped.
- Reply quoting and signatures are trimmed heuristically; odd clients may leave
  a stray quoted line.
