#!/usr/bin/env python3
"""Deploy the ocs-books-preview Worker to Cloudflare — SIGNED ONLY.

Standing rule (2026-10-05): every ocs-books-preview deploy goes through the
site-integrity signed-deploy wrapper. There is no unsigned path in this repo:
this script hands the upload to deploy_signed.py, which carries forward
non-secret bindings (the OCS_BOOKS KV namespace), preserves server-side
secrets (APPSCRIPT_URL, APPSCRIPT_SECRET, EXPORT_KEY, ALERT_WEBHOOK),
re-hashes the deployed bytes, and mints a signed ledger certificate.
The integrity watcher treats any deploy without a ledger certificate
as unauthorized.

Usage:
  cf_upload_ocs_books.py [worker_file] [--note TEXT]

The worker file defaults to this repo's worker.js. The live Worker is the
source of truth; after any change, commit the new worker.js + metadata.json
here (see README). Emergency manual restore (unsigned, documented fallback)
is in metadata.json "restore".
"""
from __future__ import annotations
import subprocess
import sys
from pathlib import Path

DEPLOY_SIGNED = "/home/hatch/workspace/site-integrity/deploy_signed.py"
WORKER_NAME = "ocs-books-preview"
DEFAULT_MODULE = str(Path(__file__).resolve().parent.parent / "worker.js")


def main() -> None:
    args = sys.argv[1:]
    module = DEFAULT_MODULE
    note = "ocs-books-preview deploy via signed wrapper"
    i = 0
    while i < len(args):
        if args[i] == "--note" and i + 1 < len(args):
            note = args[i + 1]
            i += 2
        elif not args[i].startswith("--"):
            module = args[i]
            i += 1
        else:
            i += 1

    r = subprocess.run(
        [sys.executable, DEPLOY_SIGNED, WORKER_NAME, module,
         "--main-module", "worker.js", "--note", note])
    if r.returncode != 0:
        raise SystemExit(f"signed deploy failed (exit {r.returncode})")
    print("ocs-books-preview SIGNED DEPLOY OK")


if __name__ == "__main__":
    main()
