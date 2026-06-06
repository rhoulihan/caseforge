#!/usr/bin/env bash
# Build the SPA + the Go launcher and serve the whole app locally on 127.0.0.1.
# The launcher serves the built SPA and exposes the anonymize/deanonymize/health endpoints
# same-origin, so no Vite dev proxy is needed. Requires: pnpm, Node >=20, Go >=1.23.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"

echo "› Installing deps…"
pnpm install --frozen-lockfile

echo "› Building the SPA (dist/)…"
pnpm build

echo "› Building the launcher (launcher/bin/caseforge)…"
( cd launcher && go build -o bin/caseforge . )

echo "› Serving on http://127.0.0.1:${PORT} (Ctrl-C to stop)…"
exec ./launcher/bin/caseforge serve --app-dir dist --port "${PORT}"
