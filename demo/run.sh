#!/bin/bash
# Boot the cerber cockpit against fixture data, with no GitHub and no Anthropic
# API involved. See README.md in this directory.
#
#   demo/run.sh [port]      # default 4830
#
# Idempotent: the scratch home is wiped and the five reviews are re-drafted on
# every run, so a recording always starts from the same screen.
set -euo pipefail

PORT="${1:-4830}"
DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEMO_DIR/.." && pwd)"
TSX="$REPO_DIR/node_modules/.bin/tsx"

if [ ! -x "$TSX" ]; then
  echo "demo: $TSX is missing — run \`pnpm install\` in $REPO_DIR first." >&2
  exit 1
fi

# The whole trick: cerber shells out to `gh` and `claude`, and these come first.
export PATH="$DEMO_DIR/bin:$PATH"
export CERBER_HOME="$DEMO_DIR/home"
export CERBER_DEMO_FIXTURES="$DEMO_DIR/fixtures"

# Every run starts identical. The scratch home holds nothing but demo output.
rm -rf "$CERBER_HOME"
mkdir -p "$CERBER_HOME/reviews"

cd "$REPO_DIR"

cerber() { "$TSX" "$REPO_DIR/src/cli/index.ts" "$@"; }

# The cockpit is a static build served by the API process; without it cerber
# answers on /api but has no UI to record.
if [ ! -f "$REPO_DIR/web/dist/index.html" ]; then
  echo "→ building the cockpit (one-off)…"
  pnpm build
fi

echo "→ gh:          $(command -v gh)"
echo "→ claude:      $(command -v claude)"
echo "→ CERBER_HOME: $CERBER_HOME"
echo

# --no-source: the fixtures are diffs, not repositories, so there is nothing to
# check out. It also keeps `git` out of the loop — the third program cerber
# shells out to, and the only one still real here.
#
# The narration pause is for the camera, and a five-review batch is not the
# camera's business: draft at full speed, narrate at reading speed once serving.
echo "→ drafting five reviews through cerber's own pipeline…"
CERBER_DEMO_STEP_MS=0 cerber review \
  --no-source \
  --parallel 5 \
  https://github.com/northwind/checkout/pull/812 \
  https://github.com/northwind/checkout/pull/809 \
  https://github.com/northwind/web/pull/1440 \
  https://github.com/northwind/checkout/pull/805 \
  https://github.com/northwind/billing/pull/231

echo
echo "→ cockpit on http://127.0.0.1:${PORT} — five reviews in the inbox tab."
echo "  Send is wired: it writes the payload to \$CERBER_HOME/sent/ instead of GitHub."
echo

# --no-poll: nothing here should reach for GitHub on a timer. The queue is
# exactly the five reviews drafted above, and stays that way on camera.
export CERBER_DEMO_STEP_MS="${CERBER_DEMO_STEP_MS:-350}"
exec "$TSX" "$REPO_DIR/src/cli/index.ts" serve --no-poll --port "$PORT"
