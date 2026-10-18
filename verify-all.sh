#!/usr/bin/env bash
# Runs verify.sh of every audit folder in this repository, from the repository root, offline.
#   bash verify-all.sh
# DPROOF_TK (default: tools/decide-proof) and DPROOF_VD (default: decide-proof-vd) can be set to other copies.
# The script does the cd to the repository root, because an audit folder may name its inputs relative to it.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1
export DPROOF_TK="${DPROOF_TK:-$ROOT/tools/decide-proof}"
export DPROOF_VD="${DPROOF_VD:-$ROOT/decide-proof-vd}"
rc=0
found=0
for dir in data/social/audits/*/; do
  a="$(basename "$dir")"
  [ -f "$dir/verify.sh" ] || continue
  found=$((found + 1))
  echo "== $a"
  bash "$dir/verify.sh" || rc=1
done
[ "$found" -gt 0 ] || { echo "no audit folder found under data/social/audits"; exit 1; }
exit "$rc"
