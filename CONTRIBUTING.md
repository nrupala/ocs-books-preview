# Contributing to ocs-books-preview

## PR flow (certification discipline)

1. All work happens on a branch — **never push directly to `main`**.
2. Open a **draft PR** early; mark it ready only when the change is verified.
3. This repo has no test suite (a 4-file Worker + Apps Script project); verification
   is by reading the Worker source and the `metadata.json` deploy contract.
4. Every PR adds a `CHANGELOG.md` entry under `## [Unreleased]`. This repo has no
   version file — do not invent one.
5. The owner merges. Merge commits reference the PR number; releases are
   tagged `vX.Y.Z`.

## Deploy

Production is a live Cloudflare Worker (`ocs-books-preview`). Deploy ONLY via
`deploy/cf_upload_ocs_books.py`, which routes through the site-integrity
signed-deploy wrapper so every deploy mints a ledger certificate. There is no
unsigned deploy path. After any change, commit the new `worker.js` +
`metadata.json` here (the live Worker is the source of truth). Production
deploys need the owner's per-deploy approval.

## License

No `LICENSE` file exists in this repo yet — the license is the owner's
selection. Do not add a license or license headers without his explicit choice.
