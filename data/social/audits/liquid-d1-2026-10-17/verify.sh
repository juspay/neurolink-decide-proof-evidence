#!/usr/bin/env bash
# verify.sh of audit liquid-d1-2026-10-17, written by `proof all`. Offline: no key, no network, writes nothing in this folder.
#   bash verify.sh        prints one line per check and a last VERDICT line; exit 0 only if every check passed
# Needs the decide-proof toolkit (DPROOF_TK, default: tools/decide-proof next to data/) and, for the facts, the rows files
# (DPROOF_VD, default ~/.cache/decide-proof, or the path the audit config names).
set -u
AD="$(cd "$(dirname "$0")" && pwd)"
TK="${DPROOF_TK:-$(cd "$AD/../../../../tools/decide-proof" 2>/dev/null && pwd)}"
VD="${DPROOF_VD:-$HOME/.cache/decide-proof}"
CONFIG="$AD/audit-config.json"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dproof-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
bad=0
ok() { echo "[ok]   $*"; }
no() { echo "[FAIL] $*"; bad=$((bad + 1)); }
[ -d "$TK" ] || { echo "VERDICT FAIL: toolkit not found (set DPROOF_TK)"; exit 1; }

# 1. every file is the one the manifest lists, and no other file is here
if (cd "$AD" && shasum -a 256 -c MANIFEST.sha256 >"$TMP/manifest.out" 2>&1); then ok "manifest: every file matches its sha256"; else no "manifest: $(grep -v ': OK$' "$TMP/manifest.out" | head -3 | tr '\n' ' ')"; fi
(cd "$AD" && find . -type f ! -name MANIFEST.sha256 ! -name .DS_Store ! -name '*.tmp' | sed 's|^\./||' | LC_ALL=C sort) >"$TMP/on-disk.txt"
sed 's|^[0-9a-f]*  ||' "$AD/MANIFEST.sha256" | LC_ALL=C sort >"$TMP/listed.txt"
if cmp -s "$TMP/on-disk.txt" "$TMP/listed.txt"; then ok "manifest: no file missing, none extra"; else no "manifest: files differ from the list: $(diff "$TMP/listed.txt" "$TMP/on-disk.txt" | head -3 | tr '\n' ' ')"; fi

# 2. both fact implementations, re-run into a temp folder, equal each other and facts/facts.json
SCAN=(); [ -f "$AD/scan/scan-result.json" ] && SCAN=(--scan "$AD/scan/scan-result.json")
if node "$TK/facts/facts.mjs" --audit "$CONFIG" --audit-dir "$AD" --vd "$VD" ${SCAN[@]+"${SCAN[@]}"} --out "$TMP/facts-node.json" >"$TMP/fn.out" 2>&1 \
   && python3 -I "$TK/facts/facts.py" --audit "$CONFIG" --ad "$AD" --vd "$VD" ${SCAN[@]+"${SCAN[@]}"} --out "$TMP/facts-py.json" >"$TMP/fp.out" 2>&1; then
  if cmp -s "$TMP/facts-node.json" "$TMP/facts-py.json" && cmp -s "$TMP/facts-node.json" "$AD/facts/facts.json"; then ok "facts: node = python = facts.json ($(shasum -a 256 "$AD/facts/facts.json" | cut -c1-12))"; else no "facts: a re-run differs from facts/facts.json"; fi
else no "facts: a fact engine refused: $(cat "$TMP/fn.out" "$TMP/fp.out" 2>/dev/null | tail -2 | tr '\n' ' ')"; fi

# 3. the text checker on every rendered text
check_text() {
  local name="$1" template="$2"
  if python3 -I "$TK/text/check_text.py" "$AD/text/$name.md" --provenance "$AD/text/$name.provenance.json" --facts "$AD/facts/facts.json" --template "$TK/$template" >"$TMP/text.out" 2>&1; then ok "text $name: every number is a fact or a literal"; else no "text $name: $(tail -1 "$TMP/text.out")"; fi
}
check_text 'bsky' 'audits/liquid-d1-2026-10-17/templates/bsky.txt.tmpl'
check_text 'linkedin' 'audits/liquid-d1-2026-10-17/templates/linkedin.txt.tmpl'
check_text 'x-reply' 'audits/liquid-d1-2026-10-17/templates/x-reply.txt.tmpl'

# 4. the secret scan over this folder: 0 hits (with no env files here only the planted control runs, and that is said)
node "$TK/lib/scan.mjs" --config "$CONFIG" --allow-empty --json "$TMP/scan.json" "$AD" >"$TMP/scan.out" 2>&1
code=$?
targets="$(sed -n 's/.*"targets": \([0-9]*\).*/\1/p' "$TMP/scan.json" 2>/dev/null | head -1)"
if [ "$code" = 0 ]; then ok "scan: 0 hits for ${targets:-0} secret values, control ok"; else no "scan: exit $code: $(grep -E '^HIT|scan:' "$TMP/scan.out" | head -3 | tr '\n' ' ')"; fi

if [ "$bad" = 0 ]; then echo "VERDICT PASS: liquid-d1-2026-10-17"; exit 0; fi
echo "VERDICT FAIL: $bad check(s) failed"
exit 1
