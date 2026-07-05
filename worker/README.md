# brc-send — emails estimate PDFs from binghamresearch@usu.edu

Cloudflare Worker behind the calculator's **Send from BRC** button. Receives
`{passcode, to, filename, quoteNo, total, pdfBase64}`, checks the staff
passcode, and sends the PDF via Microsoft Graph as binghamresearch@usu.edu
(copy lands in the mailbox's Sent Items). No secrets live in this repo.

## One-time setup

Prereqs (browser):
1. Entra app registration `BRC Print Calculator Sender` (single tenant,
   platform Web) with delegated `Mail.Send` + `offline_access` and a client
   secret (value goes in the team password manager only). Record the tenant
   ID and client ID. Register under any staff account (the portal requires
   MFA, which the shared mailbox account lacks — that's fine; the mailbox
   never opens the portal, it only signs in once at the authorize link).

Deploy (needs a free Cloudflare account, `wrangler login`):
```
cd worker
npx wrangler kv namespace create TOKENS     # paste id into wrangler.jsonc
# fill MS_TENANT_ID / MS_CLIENT_ID in wrangler.jsonc
npx wrangler secret put MS_CLIENT_SECRET
npx wrangler secret put SEND_PASSCODE       # the staff passcode
npx wrangler secret put SETUP_KEY           # any long random string
npx wrangler deploy
```
Then in Entra, set the app's Web redirect URI to
`https://<worker-url>/setup/callback`, and set `WORKER_URL` in ../index.html
to the deployed URL.

Authorize the mailbox (mints the refresh token; password/MFA are typed only
into Microsoft pages):
1. Open `https://<worker-url>/setup/start?key=<SETUP_KEY>`.
2. Sign in as binghamresearch@usu.edu, accept the consent screen.
3. On "Authorized — estimate sending is live", done. Optionally rotate
   SETUP_KEY afterward (`npx wrangler secret put SETUP_KEY`).

A daily cron refreshes the token so it never hits its 90-day expiry.

## When sending breaks

| Symptom | Cause | Fix |
|---|---|---|
| UI says "needs re-authorization" | token revoked (admin password reset, revoke-sessions, long outage) | re-run the authorize steps above |
| Sends fail, logs show `invalid_client` | client secret expired (24-month max) | new secret in Entra → `npx wrangler secret put MS_CLIENT_SECRET` |
| "Wrong passcode" for staff | passcode rotated | share the new one; rotate via `npx wrangler secret put SEND_PASSCODE` |
| 429 daily_cap | >40 sends in a day | raise `DAILY_SEND_CAP` in src/index.js or wait |

Logs: `npx wrangler tail brc-send`.
