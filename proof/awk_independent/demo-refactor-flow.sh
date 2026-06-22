#!/usr/bin/env bash
# demo-refactor-flow.sh — independent end-to-end verification of the Awk
# stack on main (Issue #403 worker-session review).
#
# For each of the 5 fresh-fixture clusters in proof/awk_independent/:
#   1. capture (regenerate .regret files from current code)
#   2. validate baseline (expect PASS)
#   3. apply a VALID refactor (preserve observable output)
#   4. validate (expect PASS — output preserved, hash unchanged)
#   5. apply a BREAKING refactor (change observable output)
#   6. validate (expect FAIL — exit non-zero, hash mismatch)
#   7. restore original
#
# This script is intentionally analogous to the existing
# proof/awk/demo-refactor-flow.sh but uses DIFFERENT fixtures + DIFFERENT
# refactor patterns, to break confirmation bias per CONTEXT.md's Lesson
# Learned: "JALANKAN test nyata dengan pattern yang berbeda dari yang dipakai
# untuk implementasi".

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROOF_DIR="${ROOT}/proof/awk_independent"
CAPTURE="node ${ROOT}/scripts/capture_awk.mjs"
VALIDATE="node ${ROOT}/scripts/validate_awk.mjs"

# ─── Helpers ────────────────────────────────────────────────────────────────

pass_count=0
fail_count=0
step_count=0

step() {
  step_count=$((step_count + 1))
  echo ""
  echo "═══ Step ${step_count}: $* ═══"
}

# Backup all .awk files in the fixture dir
backup_dir="$(mktemp -d)"
trap 'rm -rf "${backup_dir}"; for f in "${PROOF_DIR}"/*.awk; do [ -f "${backup_dir}/$(basename "${f}")" ] && cp "${backup_dir}/$(basename "${f}")" "${f}"; done' EXIT
for f in "${PROOF_DIR}"/*.awk; do
  cp "${f}" "${backup_dir}/$(basename "${f}")"
done

# Run capture, suppress output except on failure
capture_quiet() {
  local out rc
  out="$(cd "${PROOF_DIR}" && ${CAPTURE} 2>&1)" && rc=0 || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "${out}"
    return "${rc}"
  fi
}

# Run validate, suppress output except on failure
validate_quiet() {
  local out rc
  out="$(cd "${PROOF_DIR}" && ${VALIDATE} --quiet 2>&1)" && rc=0 || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "${out}"
    return "${rc}"
  fi
}

expect_pass() {
  local label="$1" rc="$2"
  if [ "${rc}" -eq 0 ]; then
    echo "   ✅ PASS  — ${label}"
    pass_count=$((pass_count + 1))
  else
    echo "   ❌ FAIL — ${label} (expected PASS, got exit ${rc})"
    fail_count=$((fail_count + 1))
  fi
}

expect_fail() {
  local label="$1" rc="$2"
  if [ "${rc}" -ne 0 ]; then
    echo "   ✅ FAIL (expected) — ${label} (exit ${rc})"
    pass_count=$((pass_count + 1))
  else
    echo "   ❌ PASS — ${label} (expected FAIL, got exit 0)"
    fail_count=$((fail_count + 1))
  fi
}

restore_all() {
  for f in "${PROOF_DIR}"/*.awk; do
    cp "${backup_dir}/$(basename "${f}")" "${f}"
  done
}

# ─── Step 1: Capture baseline ──────────────────────────────────────────────
step "Capture (regenerate .regret from current code)"
capture_quiet
echo "   ✅ 5 clusters captured"

# ─── Step 2: Validate baseline (expect PASS) ───────────────────────────────
step "Validate baseline (expect 5 PASS)"
set +e; validate_quiet; rc=$?; set -e
expect_pass "baseline validate" "${rc}"

# ─── Step 3: VALID refactor — apache_status_class (regex tighten, same output) ──
step "VALID refactor — apache_status_class.awk (regex tighten: ^[1-5][0-9]{2}$ → ^[1-5][0-9][0-9]\$)"
cat > "${PROOF_DIR}/apache_status_class.awk" << 'AWKEOF'
# apache_status_class.awk — REFACTORED: tightened regex (same observable output).
{
  s = $9
  if (s ~ /^[1-5][0-9][0-9]$/) {
    cls = substr(s, 1, 1) "xx"
    print cls
  } else {
    print "INVALID"
  }
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (regex tighten)" "${rc}"
restore_all

# ─── Step 4: BREAKING refactor — apache_status_class (off-by-one class boundary) ──
step "BREAKING refactor — apache_status_class.awk (200 → 3xx instead of 2xx)"
cat > "${PROOF_DIR}/apache_status_class.awk" << 'AWKEOF'
# apache_status_class.awk — BREAKING: 2xx mapped to 3xx (changes output).
{
  s = $9
  if (s ~ /^[1-5][0-9][0-9]$/) {
    cls = substr(s, 1, 1) "xx"
    # BUG: 2xx → 3xx (off-by-one)
    if (cls == "2xx") cls = "3xx"
    print cls
  } else {
    print "INVALID"
  }
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (2xx→3xx)" "${rc}"
restore_all

# ─── Step 5: VALID refactor — markdown_links (preserve match, change var names) ──
step "VALID refactor — markdown_links.awk (rename vars, same observable output)"
cat > "${PROOF_DIR}/markdown_links.awk" << 'AWKEOF'
# markdown_links.awk — REFACTORED: renamed vars (same observable output).
{
  remaining = $0
  acc = ""
  while (match(remaining, /\[[^][]+\]\([^()]+\)/)) {
    m = substr(remaining, RSTART, RLENGTH)
    remaining = substr(remaining, RSTART + RLENGTH)
    inner = substr(m, 2, length(m) - 2)
    p = index(inner, "](")
    t = substr(inner, 1, p - 1)
    u = substr(inner, p + 2)
    if (acc != "") acc = acc "\n"
    acc = acc t " -> " u
  }
  if (acc != "") print acc
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (rename vars)" "${rc}"
restore_all

# ─── Step 6: BREAKING refactor — markdown_links (drop the URL part) ──
step "BREAKING refactor — markdown_links.awk (emit text only, drop ' -> url')"
cat > "${PROOF_DIR}/markdown_links.awk" << 'AWKEOF'
# markdown_links.awk — BREAKING: only emit link text (drops URL).
{
  line = $0
  out = ""
  while (match(line, /\[[^][]+\]\([^()]+\)/)) {
    full = substr(line, RSTART, RLENGTH)
    line = substr(line, RSTART + RLENGTH)
    inner = substr(full, 2, length(full) - 2)
    paren = index(inner, "](")
    text = substr(inner, 1, paren - 1)
    if (out != "") out = out "\n"
    out = out text   # BREAKING: drops " -> " url
  }
  if (out != "") print out
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (drop URL)" "${rc}"
restore_all

# ─── Step 7: VALID refactor — dedupe_lines (use !(k in a) instead of !a[k]) ──
step "VALID refactor — dedupe_lines.awk (swap order: skip if already in seen)"
cat > "${PROOF_DIR}/dedupe_lines.awk" << 'AWKEOF'
# dedupe_lines.awk — REFACTORED: cleaner idiom (same output).
{
  line = $0
  if (!(line in seen)) {
    seen[line] = 1
    order[NR] = line
  }
}

END {
  for (i = 1; i <= NR; i++) {
    if (i in order) print order[i]
  }
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (cleaner idiom)" "${rc}"
restore_all

# ─── Step 8: BREAKING refactor — dedupe_lines (sort instead of preserve order) ──
step "BREAKING refactor — dedupe_lines.awk (output sorted, not first-occurrence)"
cat > "${PROOF_DIR}/dedupe_lines.awk" << 'AWKEOF'
# dedupe_lines.awk — BREAKING: emit dedup'd lines in sorted order.
{
  line = $0
  seen[line] = 1
}

END {
  n = 0
  for (k in seen) { n++; sorted[n] = k }
  # simple insertion sort
  for (i = 2; i <= n; i++) {
    key = sorted[i]
    j = i - 1
    while (j >= 1 && sorted[j] > key) {
      sorted[j + 1] = sorted[j]
      j--
    }
    sorted[j + 1] = key
  }
  for (i = 1; i <= n; i++) print sorted[i]
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (sorted, not first-occurrence)" "${rc}"
restore_all

# ─── Step 9: VALID refactor — indent_prefix (use sprintf %*s, same output) ──
step "VALID refactor — indent_prefix.awk (use sprintf %*s directly)"
cat > "${PROOF_DIR}/indent_prefix.awk" << 'AWKEOF'
# indent_prefix.awk — REFACTORED: inline sprintf (same output).
BEGIN {
  if (indent == "") indent = 2
}

{
  print sprintf("%*s", indent, "") $0
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (inline sprintf)" "${rc}"
restore_all

# ─── Step 10: BREAKING refactor — indent_prefix (always 5 spaces, ignore -v) ──
step "BREAKING refactor — indent_prefix.awk (always 5 spaces, ignore -v indent=3)"
cat > "${PROOF_DIR}/indent_prefix.awk" << 'AWKEOF'
# indent_prefix.awk — BREAKING: ignore 'indent' var entirely, always use 5.
BEGIN {
  prefix = "     "   # always 5 spaces — ignores -v indent=3
}

{
  print prefix $0
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (always 5 spaces, ignores -v)" "${rc}"
restore_all

# ─── Step 11: VALID refactor — transpose_matrix (use ternary instead of if) ──
step "VALID refactor — transpose_matrix.awk (ternary for missing val)"
cat > "${PROOF_DIR}/transpose_matrix.awk" << 'AWKEOF'
# transpose_matrix.awk — REFACTORED: ternary for missing-cell default.
{
  n = split($0, fields, "\t")
  if (n > maxCols) maxCols = n
  for (j = 1; j <= n; j++) {
    matrix[NR, j] = fields[j]
  }
  maxRows = NR
}

END {
  for (j = 1; j <= maxCols; j++) {
    out = ""
    for (i = 1; i <= maxRows; i++) {
      val = (matrix[i, j] != "") ? matrix[i, j] : "0"
      if (i > 1) out = out "\t"
      out = out val
    }
    print out
  }
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (ternary)" "${rc}"
restore_all

# ─── Step 12: BREAKING refactor — transpose_matrix (emit rows, not cols) ──
step "BREAKING refactor — transpose_matrix.awk (no transpose: emit rows as-is)"
cat > "${PROOF_DIR}/transpose_matrix.awk" << 'AWKEOF'
# transpose_matrix.awk — BREAKING: emit original rows instead of transposed.
{
  print $0
}
AWKEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (no transpose)" "${rc}"
restore_all

# ─── Step 13: Multi-input contract check (Issue #315) ──────────────────────
step "Issue #315 multi-input contract — markdown-links has INPUTS line"
MARKDOWN_REGRET="${PROOF_DIR}/regrets/markdown-links.regret"
if [ -f "${MARKDOWN_REGRET}" ] && grep -q '^INPUTS ' "${MARKDOWN_REGRET}"; then
  echo "   ✅ markdown-links.regret has INPUTS line:"
  grep '^INPUTS ' "${MARKDOWN_REGRET}" | head -1 | sed 's/^/      /'
  pass_count=$((pass_count + 1))
else
  echo "   ❌ markdown-links.regret missing INPUTS line"
  fail_count=$((fail_count + 1))
fi

# ─── Step 14: cluster.args pass-through check (indent-prefix) ──────────────
step "cluster.args pass-through — indent-prefix used '-v indent=3'"
# indent-prefix output captured into .regret should have 3-space prefix
# (because cluster.args = ["-v","indent=3"]). If cluster.args was NOT
# honored, output would have 2-space prefix (the default).
INDENT_REGRET="${PROOF_DIR}/regrets/indent-prefix.regret"
# Match: OUTPUT "   one   (3 spaces between " and one)
if grep -E '^OUTPUT "   one' "${INDENT_REGRET}" >/dev/null; then
  echo "   ✅ -v indent=3 was applied (output has 3-space prefix)"
  pass_count=$((pass_count + 1))
else
  echo "   ❌ -v indent=3 was NOT applied (check capture_awk.mjs cluster.args path)"
  grep '^OUTPUT ' "${INDENT_REGRET}" | sed 's/^/      /'
  fail_count=$((fail_count + 1))
fi

# ─── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "═══ Summary ═══"
echo "   Passed: ${pass_count}"
echo "   Failed: ${fail_count}"
echo ""
if [ "${fail_count}" -eq 0 ]; then
  echo "✅ All checks PASS — Awk stack on main is independently verified with fresh fixtures."
  exit 0
else
  echo "❌ Some checks FAILed — see output above."
  exit 1
fi
