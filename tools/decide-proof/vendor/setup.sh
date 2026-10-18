#!/usr/bin/env bash
# Builds the durable vendor folder of decide-proof (CONTRACT.md, VD = ~/.cache/decide-proof) and refuses on any hash mismatch.
#
#   bash vendor/setup.sh           build or complete VD, verify everything (idempotent; only public GETs to PyPI and npm)
#   bash vendor/setup.sh --check   verify only: no network, nothing written, exit 1 on the first problem
#
#   VD/kit/                git clone of the scratchpad kit checkout, detached at the pinned commit, runner.py hash checked
#   VD/venv/               Python venv with the kit installed editable from VD/kit (so the pinned checkout is what runs)
#   VD/bench/              @juspay/neurolink at the pinned version from npm (version and registry integrity checked)
#   VD/rows/               the two selected-rows files, sha256 checked before and after the copy
#
# Existing files are never overwritten or deleted when they do not match a pin: the script stops and says which one.
# Steps are ordered so the offline checks (rows, kit) run before anything touches the network.
# Overrides for tests: DPROOF_VD, DPROOF_KIT_SRC, DPROOF_ROWS_SRC_BANKING77, DPROOF_ROWS_SRC_CLINC, DPROOF_PYTHON.
set -euo pipefail

SCRATCH=~/scratchpad
KIT_COMMIT=87d4650b42b377c0291a89c1f1a879f9b31082bf
RUNNER_SHA256=f4c9f36c4c557f537f1d8184db7bf00c5a84d9f4f0aa67f8c06198cead25818d
NEUROLINK_VERSION=12.47.0
B77_SHA256=1629c6fbd0e2f60c9d5cfa1a67a9370af651b52e45b167ad15b08becba81782a
CLINC_SHA256=a0fbb6a532983860df2d782b54756d9294fe3267433401fb498b239173273435

VD="${DPROOF_VD:-$HOME/.cache/decide-proof}"
KIT_SRC="${DPROOF_KIT_SRC:-$SCRATCH/decision-index/kit}"
B77_SRC="${DPROOF_ROWS_SRC_BANKING77:-$SCRATCH/decision-index/work/artifacts/benchmark-suite/release-v1-rebuilt/selected-rows.jsonl}"
CLINC_SRC="${DPROOF_ROWS_SRC_CLINC:-$SCRATCH/decision-index/work-clinc/artifacts/benchmark-suite/release-v1-rebuilt/selected-rows.jsonl}"

CHECK=0
case "${1:-}" in
  "") ;;
  --check) CHECK=1 ;;
  *) echo "usage: setup.sh [--check]" >&2; exit 2 ;;
esac

die() { echo "setup: REFUSED: $*" >&2; exit 1; }
say() { echo "setup: $*"; }
sha() { shasum -a 256 "$1" | awk '{print $1}'; }

# ---- rows ----
rows_file() { # name, source, pin
  local name="$1" src="$2" pin="$3" dst="$VD/rows/$1"
  if [ -e "$dst" ]; then
    [ "$(sha "$dst")" = "$pin" ] || die "$dst exists but its sha256 is not the pinned $pin; not touching it"
    say "rows/$name ok ($pin)"
    return
  fi
  [ "$CHECK" = 0 ] || die "$dst is missing"
  [ -f "$src" ] || die "source rows file not found: $src"
  [ "$(sha "$src")" = "$pin" ] || die "source $src has a different sha256 than the pinned $pin"
  mkdir -p "$VD/rows"
  cp "$src" "$dst.tmp.$$"
  if [ "$(sha "$dst.tmp.$$")" != "$pin" ]; then rm -f "$dst.tmp.$$"; die "copy of $name does not match the pin"; fi
  mv "$dst.tmp.$$" "$dst"
  say "rows/$name copied ($pin)"
}

# ---- kit ----
kit_verify() {
  local head
  head="$(git -C "$VD/kit" rev-parse HEAD)" || die "$VD/kit is not a git checkout"
  [ "$head" = "$KIT_COMMIT" ] || die "kit HEAD is $head, the pin is $KIT_COMMIT"
  [ "$(sha "$VD/kit/decision_index/runner.py")" = "$RUNNER_SHA256" ] || die "kit decision_index/runner.py does not hash to the pinned $RUNNER_SHA256"
  [ -z "$(git -C "$VD/kit" status --porcelain --untracked-files=no)" ] || die "kit checkout has modified tracked files"
}
kit_setup() {
  if [ -d "$VD/kit/.git" ]; then
    kit_verify
    say "kit ok ($KIT_COMMIT, runner.py $RUNNER_SHA256)"
    return
  fi
  [ ! -e "$VD/kit" ] || die "$VD/kit exists but is not a git checkout; not touching it"
  [ "$CHECK" = 0 ] || die "$VD/kit is missing"
  [ -d "$KIT_SRC/.git" ] || die "kit source checkout not found: $KIT_SRC"
  local upstream tmp="$VD/kit.tmp.$$"
  upstream="$(git -C "$KIT_SRC" remote get-url origin 2>/dev/null || true)"
  mkdir -p "$VD"
  git clone --quiet --no-hardlinks --no-checkout "$KIT_SRC" "$tmp"
  if ! git -C "$tmp" -c advice.detachedHead=false checkout --quiet --detach "$KIT_COMMIT" 2>/dev/null; then
    rm -rf "$tmp"
    die "kit source $KIT_SRC does not contain the pinned commit $KIT_COMMIT"
  fi
  [ -z "$upstream" ] || git -C "$tmp" remote set-url origin "$upstream"
  mv "$tmp" "$VD/kit"
  kit_verify
  say "kit cloned from the local checkout and verified ($KIT_COMMIT)"
}

# ---- venv ----
venv_ok() {
  [ -x "$VD/venv/bin/python" ] || return 1
  "$VD/venv/bin/python" -I -c "
import importlib.util, os, sys
spec = importlib.util.find_spec('decision_index.runner')
import httpx
sys.exit(0 if spec and os.path.realpath(spec.origin) == os.path.realpath('$VD/kit/decision_index/runner.py') else 1)" 2>/dev/null
}
venv_setup() {
  if venv_ok; then
    say "venv ok ($("$VD/venv/bin/python" --version 2>&1), decision_index imported from $VD/kit)"
    return
  fi
  [ "$CHECK" = 0 ] || die "$VD/venv is missing or does not import the kit from $VD/kit"
  [ ! -e "$VD/venv" ] || die "$VD/venv exists but is not usable (does not import the kit from $VD/kit); move it away and run again"
  local py="${DPROOF_PYTHON:-}"
  if [ -z "$py" ]; then py="$(command -v python3.12 || command -v python3 || true)"; fi
  [ -n "$py" ] || die "no python3 found"
  "$py" -m venv "$VD/venv"
  PYTHONDONTWRITEBYTECODE=1 "$VD/venv/bin/python" -m pip install --quiet --disable-pip-version-check -e "$VD/kit"
  venv_ok || die "the kit installed into the venv does not import from $VD/kit"
  "$VD/venv/bin/python" -m pip freeze --disable-pip-version-check > "$VD/venv-freeze.txt"
  say "venv built ($("$VD/venv/bin/python" --version 2>&1)), kit installed editable from $VD/kit"
}

# ---- bench (NeuroLink from npm) ----
bench_version() { node -e 'try{process.stdout.write(require(process.argv[1]+"/node_modules/@juspay/neurolink/package.json").version)}catch{}' "$VD/bench"; }
bench_verify() {
  local v
  v="$(bench_version)"
  [ "$v" = "$NEUROLINK_VERSION" ] || die "bench has @juspay/neurolink '${v:-none}', the pin is $NEUROLINK_VERSION"
  [ ! -e "$VD/bench/.env" ] || die "$VD/bench/.env exists; NeuroLink would load it"
  node --input-type=module -e 'import { createRequire } from "node:module"; const r = createRequire(process.argv[1] + "/package.json"); await import(r.resolve("@juspay/neurolink"));' "$VD/bench" >/dev/null 2>&1 || die "@juspay/neurolink in $VD/bench cannot be imported"
}
bench_setup() {
  if [ "$(bench_version)" = "$NEUROLINK_VERSION" ]; then
    bench_verify
    say "bench ok (@juspay/neurolink $NEUROLINK_VERSION)"
    return
  fi
  [ "$CHECK" = 0 ] || die "$VD/bench has no @juspay/neurolink $NEUROLINK_VERSION"
  mkdir -p "$VD/bench"
  if [ ! -e "$VD/bench/package.json" ]; then
    printf '{\n  "name": "decide-proof-bench",\n  "private": true,\n  "version": "0.0.0",\n  "dependencies": {\n    "@juspay/neurolink": "%s"\n  }\n}\n' "$NEUROLINK_VERSION" > "$VD/bench/package.json"
  fi
  (cd "$VD/bench" && npm install --no-audit --no-fund --ignore-scripts --loglevel=error >/dev/null)
  bench_verify
  local want have
  want="$(npm view "@juspay/neurolink@$NEUROLINK_VERSION" dist.integrity)"
  have="$(node -e 'const l=require(process.argv[1]+"/package-lock.json");process.stdout.write(l.packages["node_modules/@juspay/neurolink"].integrity)' "$VD/bench")"
  [ -n "$want" ] && [ "$want" = "$have" ] || die "installed @juspay/neurolink integrity differs from the registry's"
  say "bench built (@juspay/neurolink $NEUROLINK_VERSION, integrity matches the registry)"
}

[ "$CHECK" = 1 ] || mkdir -p "$VD"
rows_file banking77-selected-rows.jsonl "$B77_SRC" "$B77_SHA256"
rows_file clinc-selected-rows.jsonl "$CLINC_SRC" "$CLINC_SHA256"
kit_setup
venv_setup
bench_setup
say "all pins verified in $VD"
