#!/usr/bin/env bash
# Runs INSIDE the evenhub-sim container (see sim/run.sh).
# Starts Vite + the Even Hub simulator on a virtual display, waits for the app
# to boot, optionally sends touchpad inputs, then saves screenshots + console.
# Everything binds to 127.0.0.1 inside the container; no ports are published.
set -euo pipefail

OUT=${OUT:-/app/sim/out}
WAIT=${WAIT:-8}               # seconds to wait after launch before snapshot
INPUTS=${INPUTS:-}            # e.g. "click down click"
API=http://127.0.0.1:9898
SIM=/app/node_modules/@evenrealities/sim-linux-x64/bin/evenhub-simulator
export PATH=/opt/node/bin:$PATH
mkdir -p "$OUT"

cleanup() { kill ${SIM_PID:-} ${VITE_PID:-} ${XVFB_PID:-} 2>/dev/null || true; }
trap cleanup EXIT

Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 & XVFB_PID=$!
export DISPLAY=:99

# Virtual microphone: a PulseAudio pipe source set as the default input.
# Whatever PCM (s16le 16 kHz mono) is written to the FIFO is what the app hears.
VMIC=/tmp/vmic.fifo
if [ -n "${AUDIO:-}" ]; then
  export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p $XDG_RUNTIME_DIR
  pulseaudio -D --exit-idle-time=-1 --disallow-exit -n \
    --load="module-native-protocol-unix" --load="module-null-sink sink_name=out" 2>"$OUT/pulse.log"
  sleep 1
  pactl load-module module-pipe-source source_name=vmic file=$VMIC format=s16le rate=16000 channels=1 >/dev/null
  pactl set-default-source vmic
  # keep the FIFO open with silence until the real audio is fed
  ( while :; do head -c 3200 /dev/zero; sleep 0.1; done ) > $VMIC & SILENCE_PID=$!
fi

cd /app
npx vite --host 127.0.0.1 --port 5173 --strictPort >"$OUT/vite.log" 2>&1 & VITE_PID=$!
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:5173 >/dev/null && break; sleep 0.25; done

QS="${TARGET:+target=$TARGET&}${SPEAKERS:+speakers=$SPEAKERS&}${MODE:+mode=$MODE&}"
RUST_LOG=${RUST_LOG:-info} "$SIM" "http://127.0.0.1:5173/${QS:+?${QS%&}}" --automation-port 9898 --no-aid \
  >"$OUT/simulator.log" 2>&1 & SIM_PID=$!
for _ in $(seq 1 60); do curl -sf $API/api/ping >/dev/null && break; sleep 0.25; done
curl -sf $API/api/ping >/dev/null || { echo "simulator did not start"; tail -30 "$OUT/simulator.log"; exit 1; }

sleep "$WAIT"
curl -sf $API/api/screenshot/glasses -o "$OUT/glasses-0-boot.png"
curl -sf $API/api/screenshot/webview -o "$OUT/webview-0-boot.png" || true
import -window root "$OUT/desktop-0-boot.png" 2>/dev/null || true

# CLICKS="747,139 500,600": click desktop coordinates (e.g. phone UI) in order.
c=0
for xy in ${CLICKS:-}; do
  c=$((c+1))
  if [ "$xy" = scroll ]; then xdotool mousemove 500 600 click --repeat 15 --delay 50 5   # wheel down
  else xdotool mousemove ${xy%,*} ${xy#*,} click 1; fi
  sleep 1.5
  import -window root "$OUT/desktop-c$c.png" 2>/dev/null || true
done

# Feed each WAV in real time (strip 44-byte header), screenshot midway + after.
n=0
for f in ${AUDIO:-}; do
  n=$((n+1)); tag=$(basename "$f" .wav)
  kill $SILENCE_PID 2>/dev/null || true
  chunks=$(( $(stat -c %s "$f") / 3200 + 1 )); secs=$(( chunks / 10 ))
  echo "feeding $f (${secs}s)"
  ( for ((i=0; i<chunks; i++)); do dd if="$f" bs=3200 skip=$i count=1 status=none; sleep 0.1; done ) > $VMIC &
  FEED_PID=$!
  sleep $(( secs / 2 )); curl -sf $API/api/screenshot/glasses -o "$OUT/glasses-a$n-$tag-mid.png"
  wait $FEED_PID 2>/dev/null || true
  ( while :; do head -c 3200 /dev/zero; sleep 0.1; done ) > $VMIC & SILENCE_PID=$!
  sleep 4; curl -sf $API/api/screenshot/glasses -o "$OUT/glasses-a$n-$tag-end.png"
  curl -sf $API/api/screenshot/webview -o "$OUT/webview-a$n-$tag-end.png" || true
  import -window root "$OUT/desktop-a$n-$tag-end.png" 2>/dev/null || true
done

i=1
for a in $INPUTS; do
  curl -sf -X POST $API/api/input -H 'Content-Type: application/json' --data "{\"action\":\"$a\"}" >/dev/null
  sleep 1.5
  curl -sf $API/api/screenshot/glasses -o "$OUT/glasses-$i-$a.png"
  i=$((i+1))
done

# POST_CLICKS: like CLICKS, but after the audio has been fed (e.g. open 履歴).
c=0
for xy in ${POST_CLICKS:-}; do
  c=$((c+1))
  if [ "$xy" = scroll ]; then xdotool mousemove 500 600 click --repeat 15 --delay 50 5
  else xdotool mousemove ${xy%,*} ${xy#*,} click 1; fi
  sleep 2
  import -window root "$OUT/desktop-p$c.png" 2>/dev/null || true
done

curl -sf "$API/api/console" -o "$OUT/console.json"
import -window root "$OUT/desktop.png" 2>/dev/null || true
echo "OK: outputs in $OUT"; ls -1 "$OUT"
