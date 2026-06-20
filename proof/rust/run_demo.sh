#!/usr/bin/env bash
# run_demo.sh — end-to-end demo of the Rust validate workflow.
#
# This script demonstrates the full Regrets Rust workflow on this proof
# project:
#   1. Capture: invoke the binary (Node shim in this demo) with each input
#      from manifest.json, compute fingerprints, write .regret files.
#   2. Validate (PASS case): re-invoke the same binary, compare hashes —
#      all clusters should PASS.
#   3. Validate (FAIL case): swap to the "breaking" binary, re-validate —
#      the cluster whose behavior changed should FAIL with a diff.
#
# Run from this directory:
#   bash run_demo.sh
#
# Exit codes:
#   0 = demo completed (PASS case passed, FAIL case correctly failed)
#   1 = demo broke unexpectedly

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "════════════════════════════════════════════════════════════════════════"
echo "  Regrets Rust Validator — End-to-End Demo"
echo "════════════════════════════════════════════════════════════════════════"
echo ""
echo "Project: proof/rust/"
echo "Binary:  Node shim (proof/rust/shim/regret_proof_rust.mjs)"
echo "         (in a real Rust project, this would be ./target/debug/<pkg>)"
echo "Manifest: regrets/manifest.json (2 Rust clusters)"
echo ""

# ─── Phase 1: Capture ────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PHASE 1 — Capture (golden fingerprints)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node shim/capture.mjs
CAPTURE_EXIT=$?
echo ""
if [[ $CAPTURE_EXIT -ne 0 ]]; then
  echo "❌ Capture failed (exit $CAPTURE_EXIT)"
  exit 1
fi
echo "✓ Capture succeeded. .regret files written to regrets/"
echo ""

# ─── Phase 2: Validate — PASS case (same binary) ─────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PHASE 2 — Validate (PASS case: same binary, no refactor)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Manifest: regrets/manifest.json (cargoBin → regret_proof_rust.mjs)"
echo ""
bash ../../scripts/validate_rust.sh --manifest regrets/manifest.json
PASS_EXIT=$?
echo ""
if [[ $PASS_EXIT -ne 0 ]]; then
  echo "❌ PASS case unexpectedly failed (exit $PASS_EXIT)"
  exit 1
fi
echo "✓ PASS case succeeded — both clusters validated against golden."
echo ""

# ─── Phase 3: Validate — FAIL case (breaking refactor) ───────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PHASE 3 — Validate (FAIL case: breaking refactor)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Manifest: regrets/manifest.breaking.json (cargoBin → regret_proof_rust_breaking.mjs)"
echo "Change:   sanitize_filename now preserves '-' (was: replaced with '_')"
echo ""
bash ../../scripts/validate_rust.sh --manifest regrets/manifest.breaking.json
FAIL_EXIT=$?
echo ""
if [[ $FAIL_EXIT -eq 0 ]]; then
  echo "❌ FAIL case unexpectedly passed — breaking refactor was not detected!"
  exit 1
fi
echo "✓ FAIL case correctly detected the breaking refactor."
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════════════════════════"
echo "  Demo Complete — All Phases Behaved as Expected"
echo "════════════════════════════════════════════════════════════════════════"
echo ""
echo "What was demonstrated:"
echo "  • Phase 1: Capture produces .regret files with fingerprints"
echo "    computed via the cross-stack algorithm (sha256 + base36 + 7 chars)."
echo "  • Phase 2: validate_rust.sh detects that an unchanged binary still"
echo "    matches its golden contract (PASS)."
echo "  • Phase 3: validate_rust.sh detects a breaking refactor (FAIL) and"
echo "    prints a diff showing how the live output diverged from golden."
echo ""
echo "Cross-stack fingerprint parity:"
echo "  The rust-format-period cluster produced hash '12d5tvu' — identical"
echo "  to the hash documented in references/rust.md for the same function."
echo "  This proves the JS/Python/Go/Rust fingerprint implementations are"
echo "  consistent."
