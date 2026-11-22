#!/usr/bin/env bash
# Headless simulator test on a Linux host without a display.
#   sim/run.sh                       # boot + screenshot
#   INPUTS="click down" sim/run.sh   # also send touchpad inputs
#   AUDIO=/app/test-audio/ja.wav sim/run.sh             # feed WAV via virtual mic
#   AUDIO=/app/test-audio/en.wav TARGET=ja sim/run.sh   # + translate to Japanese (dev only)
#   AUDIO="/app/test-audio/dialog.wav" SPEAKERS=1 sim/run.sh   # + speaker labels (dev only)
# Requires: docker, Node at $NODE_DIR (glibc-217 build is fine), npm install done.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE_DIR=${NODE_DIR:-$HOME/.local/opt/node}
docker image inspect evenhub-sim >/dev/null 2>&1 || docker build -t evenhub-sim "$ROOT/sim"
rm -rf "$ROOT/sim/out"
docker run --rm --init \
  -v "$ROOT":/app -v "$(readlink -f "$NODE_DIR")":/opt/node:ro \
  -e WAIT -e INPUTS -e RUST_LOG -e AUDIO -e TARGET -e SPEAKERS -e CLICKS -e POST_CLICKS -e MODE \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  evenhub-sim bash /app/sim/smoke.sh
