#!/usr/bin/env bash
# run-verify.sh — end-to-end independent verification of the C stack.
#
# Walks the full Regrets contract:
#   1. Capture (fresh) — regenerate all 5 .regret files
#   2. Validate baseline — expect 5 PASS
#   3. Cross-stack parity (C hash == JS hash) — expect 15/15 match
#   4. BREAKING refactor — expect FAIL (non-zero exit)
#   5. Restore + VALID refactor — expect PASS with hash UNCHANGED
#   6. Multi-input #315 parity — confirm INPUTS line present + correct
#
# This script is INTENTIONALLY written by a DIFFERENT worker than the one
# who wrote capture_c.sh / validate_c.sh / regret_harness.c (PR #419).
# Per CONTEXT.md's "Lesson Learned":
#   "Test count tinggi TIDAK menjamin fitur benar-benar bekerja — red team
#    menemukan callee wrapping GAGAL untuk pattern paling umum meski semua
#    unit test pass, karena test ditulis dengan pattern yang sama dengan
#    implementasi (confirmation bias)."
#
# The fixture functions here (slugify / base64_encode / crc32 / fnv1a_32 /
# is_valid_ipv4) use C idioms DIFFERENT from those in proof/c/ (which uses
# add / fibonacci / reverse / parse_csv_line / format_bytes).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROOF_DIR="${ROOT}/proof/c_independent"
DEMO_SRC="${PROOF_DIR}/text_utils.c"
BACKUP="$(mktemp)"
LIBJSONC_OK=1

cleanup() {
  if [ -f "${BACKUP}" ]; then
    cp "${BACKUP}" "${DEMO_SRC}"
    rm -f "${BACKUP}"
  fi
}
trap cleanup EXIT

# Helper: run capture in the proof dir
capture() {
  ( cd "${PROOF_DIR}" && C_SOURCES="$(pwd)/text_utils.c:$(pwd)/regret_adapter.c" \
        C_INCLUDE="$(pwd)" \
        bash "${ROOT}/scripts/capture_c.sh" 2>&1 )
}

validate() {
  ( cd "${PROOF_DIR}" && C_SOURCES="$(pwd)/text_utils.c:$(pwd)/regret_adapter.c" \
        C_INCLUDE="$(pwd)" \
        bash "${ROOT}/scripts/validate_c.sh" 2>&1 )
}

# ─── Step 0: backup ──────────────────────────────────────────────────────────
cp "${DEMO_SRC}" "${BACKUP}"
echo "📁 Backed up text_utils.c → ${BACKUP}"
echo ""

# ─── Step 1: fresh capture ───────────────────────────────────────────────────
echo "═══ Step 1: Fresh capture (5 clusters, multi-input) ═══"
capture | tail -10
echo ""

# ─── Step 2: baseline validate — expect 5 PASS ───────────────────────────────
echo "═══ Step 2: Validate baseline (expect 5 PASS) ═══"
set +e
validate | tail -15
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Baseline validate failed (exit ${RC}) — fresh fixture should PASS"
  exit 1
fi
echo "✅ Baseline PASS (5/5 clusters, 15/15 input hashes)"
echo ""

# ─── Step 3: cross-stack parity (C hash == JS hash) ─────────────────────────
echo "═══ Step 3: Cross-stack parity (C == JS) ═══"
set +e
( cd "${ROOT}" && node "${PROOF_DIR}/verify-parity.mjs" 2>&1 | tail -20 )
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Cross-stack parity FAILED"
  exit 1
fi
echo ""

# ─── Step 4: BREAKING refactor — expect FAIL ─────────────────────────────────
# Change slugify to NOT collapse consecutive hyphens — output changes for
# the "ABC---DEF???GHI" input (would produce "abc---def-ghi" instead of "abc-def-ghi").
echo "═══ Step 4: Apply BREAKING refactor — slugify no longer collapses hyphens ═══"
DEMO_SRC="${DEMO_SRC}" python3 << 'PYEOF'
import os
path = os.environ['DEMO_SRC']
src = open(path).read()
old = """        if (!prev_was_hyphen) {
                out[j++] = '-';
                prev_was_hyphen = 1;
            }"""
new = """        // BREAKING: always emit '-' (no collapse) — output changes for "ABC---DEF???GHI"
                out[j++] = '-';
                prev_was_hyphen = 1;"""
assert old in src, "Original slugify body not found"
open(path, 'w').write(src.replace(old, new))
print("   ✅ slugify: collapsed → non-collapsed (output CHANGED for ABC---DEF???GHI: abc-def-ghi → abc---def-ghi)")
PYEOF
echo ""

echo "═══ Step 5: Validate after breaking refactor (expect FAIL) ═══"
set +e
validate | tail -15
RC=$?
set -e
if [ "${RC}" -eq 0 ]; then
  echo "❌ Breaking refactor PASSed (exit 0) — should have FAILED"
  exit 1
fi
echo "✅ Breaking refactor correctly FAILed (exit ${RC})"
echo ""

# ─── Step 6: restore + VALID refactor — expect PASS, hash unchanged ──────────
cp "${BACKUP}" "${DEMO_SRC}"
echo "═══ Step 6: Apply VALID refactor — crc32: refactor init loop to use lookup-precompute helper ═══"
DEMO_SRC="${DEMO_SRC}" python3 << 'PYEOF'
import os
path = os.environ['DEMO_SRC']
src = open(path).read()

# Replace the inner table-building loop body with a semantically-equivalent
# formulation that yields the same table values.  This is a "valid refactor"
# because the OUTPUT (and therefore the HASH) is unchanged for every input.
old = """    for (unsigned int i = 0; i < 256; i++) {
        unsigned int c = i;
        for (int k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        crc32_table[i] = c;
    }"""
new = """    for (unsigned int i = 0; i < 256; i++) {
        unsigned int c = i;
        /* VALID refactor: unroll the per-bit loop into a helper expression.
           Same 8-iteration mix, same table values, same OUTPUT for all inputs. */
        for (int k = 0; k < 8; k++) {
            unsigned int mask = -(c & 1u);          /* 0xFFFFFFFF if odd, else 0 */
            c = (0xEDB88320u & mask) ^ (c >> 1);
        }
        crc32_table[i] = c;
    }"""
assert old in src, "Original crc32 table-init body not found"
open(path, 'w').write(src.replace(old, new))
print("   ✅ crc32: branching mix → branchless mask-based mix (same OUTPUT, same HASH)")
PYEOF
echo ""

echo "═══ Step 7: Validate after valid refactor (expect PASS, hash unchanged) ═══"
set +e
validate | tail -15
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Valid refactor FAILED validate (exit ${RC}) — should have PASSED"
  exit 1
fi
echo "✅ Valid refactor PASS (hash unchanged — output preserved)"
echo ""

# ─── Step 8: verify INPUTS line present for multi-input clusters (#315) ─────
echo "═══ Step 8: Multi-input #315 parity — INPUTS line present + correct ═══"
DEMO_SRC="${PROOF_DIR}" python3 << 'PYEOF'
import json, os, re
from pathlib import Path
proof = Path(os.environ['DEMO_SRC'])
regret_dir = proof / 'regrets'

# Expected number of additional INPUTS entries per cluster
expected_inputs_count = {
    'slugify':       3,  # 1 top + 2 in INPUTS
    'base64-encode': 3,
    'crc32':         2,
    'fnv1a-32':      2,
    'is-valid-ipv4': 5,
}

all_ok = True
for cid, total_count in expected_inputs_count.items():
    p = regret_dir / f'{cid}.regret'
    content = p.read_text()
    has_inputs_line = bool(re.search(r'^INPUTS\s+\[', content, re.MULTILINE))
    expected_extra = total_count - 1
    if expected_extra == 0:
        if has_inputs_line:
            print(f'  ❌ {cid}: expected NO INPUTS line (single-input cluster), but found one')
            all_ok = False
        else:
            print(f'  ✅ {cid}: no INPUTS line (single-input cluster, correct)')
    else:
        if not has_inputs_line:
            print(f'  ❌ {cid}: expected INPUTS line with {expected_extra} entries, but none found')
            all_ok = False
        else:
            m = re.search(r'^INPUTS\s+(\[.*\])\s*$', content, re.MULTILINE)
            entries = json.loads(m.group(1))
            if len(entries) != expected_extra:
                print(f'  ❌ {cid}: expected {expected_extra} INPUTS entries, got {len(entries)}')
                all_ok = False
            else:
                # Verify each entry has input/output/hash fields
                for i, e in enumerate(entries):
                    if not all(k in e for k in ('input', 'output', 'hash')):
                        print(f'  ❌ {cid} INPUTS[{i}]: missing fields (got {list(e.keys())})')
                        all_ok = False
                else:
                    print(f'  ✅ {cid}: {len(entries)} INPUTS entries, all with input/output/hash')

if not all_ok:
    print('\n❌ Multi-input #315 parity FAILED')
    exit(1)
print('\n✅ Multi-input #315 parity verified — INPUTS line present + correct')
PYEOF
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "═══ Summary ═══"
echo "✅ capture writes .regret files in the standard format (cluster/version/fingerprint/captured/INPUT/OUTPUT/HASH)"
echo "✅ validate PASSes for fresh fixture (5/5 clusters, 15/15 input hashes)"
echo "✅ cross-stack parity: C hash == JS hash for all 15 (input, output) pairs"
echo "✅ validate FAILs (non-zero exit) for breaking refactor (slugify no longer collapses hyphens)"
echo "✅ validate PASSes for valid refactor (crc32 branchless mix — hash unchanged)"
echo "✅ multi-input #315 parity: INPUTS line present + correct for multi-input clusters"
echo ""
echo "Original text_utils.c restored."
