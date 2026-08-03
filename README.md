# ocs-books-preview

Cloudflare Worker behind the **Outcome Convergence Systems** book landing page. One Worker serves the page at:

- `devinfo.dev/books` and `aimlds.org/books` (routes)
- `ocs-preview.devinfo.dev` (preview host — shows a staging banner)

It serves the page, the free First-Edition PDF (`/read`), a launch-notify signup, and a signed-copy order intake. `nrupalakolkar.com/books` is a **separate** native worker with its own capture — this repo is only the `.dev` / `aimlds` variant.

> Deploy model: the **live Worker is the source of truth** (deployed directly via the Cloudflare API — no Workers Builds CI on this repo). This repo is the backup + docs. After any change, redeploy the live Worker and commit the new `worker.js` + `metadata.json` here.

## Durability model (v2) — dual-write, mutually backing

Every submission is written **twice**, and the two copies back each other up:

1. **KV (copy 1, durable):** written to the `OCS_BOOKS` namespace *first*, awaited, before anything else. This is the source of truth.
2. **Apps Script forward (copy 2, delivery):** POSTed to a Google Apps Script Web App that appends a row to a Google Sheet (tab per type) **and emails Nrupal**.

Outcome rules:

- KV write succeeds -> the visitor immediately sees success; the forward + reconciliation run in the background (`ctx.waitUntil`).
- Forward is configured but fails -> the KV record is marked `status: "forward_failed"` **and** an alert is POSTed to `ALERT_WEBHOOK`. The lead is safe in KV; pull it from `/export`.
- KV write fails -> the forward is **awaited synchronously** as the fallback copy; you are alerted that KV failed. Success is shown only if the Sheet copy landed.
- Both fail -> the visitor sees an error and can retry (nothing is silently dropped).
- **Before secrets are set** the Worker is KV-only and raises **no** false failures (an unconfigured forward is `skipped`, not `failed`).

## Endpoints

| Method | Path (under `/books` on the `.dev`/`aimlds` routes) | Purpose |
| --- | --- | --- |
| GET  | `/` | the book landing page |
| GET  | `/read` | the free First-Edition PDF (KV, else redirect) |
| POST | `/signup` | launch-notify capture (`email`) |
| POST | `/order` | signed-copy intake (`name`, `email`, `address`, `format`, `qty`) |
| GET  | `/export?key=<EXPORT_KEY>` | secret-gated pull of all leads (JSON; `&format=csv` for CSV) |

`/export` returns a plain **404** whenever the key is absent or wrong — the endpoint is invisible to anyone without it. On the routes, prefix with `/books` (e.g. `https://devinfo.dev/books/export?key=...`).

## Bindings & secrets

| Name | Type | Required | Purpose |
| --- | --- | --- | --- |
| `OCS_BOOKS` | KV namespace | yes | durable capture (`signup:*`, `order:*`, plus `first-edition.pdf`) |
| `APPSCRIPT_URL` | secret | no | Apps Script `/exec` URL — enables the Sheet + email forward |
| `APPSCRIPT_SECRET` | secret | no | shared secret sent to Apps Script (must match `Code.gs`) |
| `EXPORT_KEY` | secret | no | gates `GET /export`; unset -> `/export` is a 404 |
| `ALERT_WEBHOOK` | secret | no | POST target for failure alerts (reuse the devinfo-monitor webhook) |

Secrets are set by Nrupal only (never through an assistant):

```
wrangler secret put APPSCRIPT_URL
wrangler secret put APPSCRIPT_SECRET
wrangler secret put EXPORT_KEY
wrangler secret put ALERT_WEBHOOK
```

> When redeploying `worker.js` via the API, preserve existing bindings/secrets (`keep_bindings` / inherit) so the KV binding and any secrets are not wiped.

## Apps Script setup

See `apps-script/Code.gs`. Create a Google Sheet, paste the file into its bound Apps Script, set `NOTIFY_EMAIL` + a long random `SHARED_SECRET`, deploy as a Web App (*Execute as: Me*, *Who has access: Anyone*), then set the Worker's `APPSCRIPT_URL` (the `/exec` URL) and `APPSCRIPT_SECRET` (the same secret). Keep the book's Sheet separate from the nrupalakolkar.com Sheet.

## Retrieving leads

```
# JSON
curl "https://devinfo.dev/books/export?key=$EXPORT_KEY"
# CSV
curl -L "https://devinfo.dev/books/export?key=$EXPORT_KEY&format=csv" -o leads.csv
```

Each record carries `type`, `ts`, `status` (`captured` | `delivered` | `forward_failed`), the fields, and `key`. A `forward_failed` record is a lead whose email/Sheet delivery failed — it is safe here and should be reconciled manually.
