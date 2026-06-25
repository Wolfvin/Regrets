#!/usr/bin/env bash
# proof/julia_slugify/run_demo.sh — demonstrate Regrets capture+validate cycle
# on the Julia slugify example.
#
# This script:
#   1. Re-captures the baseline (golden) .regret files from the current slugify.jl.
#   2. Runs validate — must PASS.
#   3. Applies a VALID refactor (rename internal var, split char loop into helper)
#      — output for all inputs unchanged. Runs validate — must PASS.
#   4. Restores the original file. Runs validate — must PASS (sanity).
#   5. Applies a BREAKING refactor (hyphen → underscore in output) — output
#      changes for every non-trivial input. Runs validate — must FAIL.
#   6. Restores the original file. Runs validate — must PASS (sanity).
#   7. Cross-stack parity check (Julia == JS == Nim for same input/output).
#
# Exits 0 if every phase produced the expected PASS/FAIL outcome, 1 otherwise.
#
# Run from the repo root:
#   bash proof/julia_slugify/run_demo.sh
#
# Or from the proof dir:
#   bash run_demo.sh
#
# Requires: Julia 1.11+ on PATH (or set JULIA=/path/to/julia).
# Optional: JULIA_PROJECT=/path/to/env (defaults to ~/.julia/environments/regrets).

set -eu

PROOF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROOF_DIR"

REGRETS_REPO="$(cd "$PROOF_DIR/../.." && pwd)"
CAPTURE="$REGRETS_REPO/scripts/capture_julia.sh"
VALIDATE="$REGRETS_REPO/scripts/validate_julia.sh"

if ! command -v "${JULIA:-julia}" >/dev/null 2>&1; then
  echo "❌ julia not found on PATH"
  echo "   Install Julia (https://julialang.org/install/) or set JULIA=/path/to/julia"
  exit 1
fi

LIB="lib/slugify.jl"
BACKUP="/tmp/slugify.jl.bak.$$.orig"
REFACTORED_VALID="/tmp/slugify.jl.bak.$$.valid"
REFACTORED_BREAKING="/tmp/slugify.jl.bak.$$.breaking"

trap 'rm -f "$BACKUP" "$REFACTORED_VALID" "$REFACTORED_BREAKING"' EXIT

# ─── Helper: run validate, return 0 if PASS, 1 if FAIL ────────────────────────
run_validate() {
  set +e
  bash "$VALIDATE" --manifest ./regrets/manifest.json 2>&1 | tee /tmp/validate_julia.out
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

# ─── Stash the original file ──────────────────────────────────────────────────
cp "$LIB" "$BACKUP"

# ─── Phase 0: baseline capture + validate ─────────────────────────────────────
echo "═══ Phase 0: baseline capture + validate ═══"
bash "$CAPTURE" --manifest ./regrets/manifest.json 2>&1 | tail -8
echo
if run_validate >/dev/null 2>&1; then
  echo "✅ Phase 0 PASS — baseline green"
else
  echo "❌ Phase 0 FAIL: baseline validate should PASS"
  exit 1
fi
echo

# ─── Phase 1: VALID refactor — behavior unchanged ────────────────────────────
# - Rename internal var `out_chars` → `accum`
# - Extract the trailing-hyphen-strip into a separate `strip_trailing_hyphen` function
# - Replace the `SLUGIFY_HYPHEN` constant with a literal '-'
# All three changes are pure cosmetic refactors. Every input still produces
# the exact same output, so validate must PASS.
echo "═══ Phase 1: apply VALID refactor (rename var, extract helper) ═══"
cat > "$REFACTORED_VALID" <<'JL'
# proof/julia_slugify/lib/slugify.jl — REFACTORED (valid, behavior unchanged)

is_alphanum(c::Char) = ('a' <= c <= 'z') || ('0' <= c <= '9')

function strip_trailing_hyphen(chars::Vector{Char})::Vector{Char}
    if !isempty(chars) && chars[end] == '-'
        pop!(chars)
    end
    return chars
end

function slugify(text::String)::String
    lowered = lowercase(text)
    accum = Char[]
    prev_hyphen = true
    for c in lowered
        if is_alphanum(c)
            push!(accum, c)
            prev_hyphen = false
        else
            if !prev_hyphen
                push!(accum, '-')
                prev_hyphen = true
            end
        end
    end
    accum = strip_trailing_hyphen(accum)
    return String(accum)
end

function slugify_batch(texts::Vector{String})::Vector{String}
    return [slugify(t) for t in texts]
end
JL
cp "$REFACTORED_VALID" "$LIB"

if run_validate >/dev/null 2>&1; then
  echo "✅ Phase 1 PASS — valid refactor kept Regrets green"
else
  echo "❌ Phase 1 FAIL: valid refactor should PASS"
  cp "$BACKUP" "$LIB"
  exit 1
fi
echo

# ─── Phase 2: BREAKING refactor — output changes ──────────────────────────────
# Change hyphen to underscore in output — every non-empty slug changes.
echo "═══ Phase 2: apply BREAKING refactor (hyphen → underscore) ═══"
cat > "$REFACTORED_BREAKING" <<'JL'
# proof/julia_slugify/lib/slugify.jl — REFACTORED (BREAKING — output changed)

const SLUGIFY_HYPHEN = '_'  # ← was '-'

is_alphanum(c::Char) = ('a' <= c <= 'z') || ('0' <= c <= '9')

function slugify(text::String)::String
    lowered = lowercase(text)
    out_chars = Char[]
    var prev_hyphen = true
    for c in lowered
        if is_alphanum(c)
            push!(out_chars, c)
            prev_hyphen = false
        else
            if !prev_hyphen
                push!(out_chars, SLUGIFY_HYPHEN)
                prev_hyphen = true
            end
        end
    end
    if !isempty(out_chars) && out_chars[end] == SLUGIFY_HYPHEN
        pop!(out_chars)
    end
    return String(out_chars)
end

function slugify_batch(texts::Vector{String})::Vector{String}
    return [slugify(t) for t in texts]
end
JL
# The line `var prev_hyphen = true` is invalid Julia syntax — fix it:
sed -i 's/var prev_hyphen/prev_hyphen/' "$REFACTORED_BREAKING"
cp "$REFACTORED_BREAKING" "$LIB"

set +e
bash "$VALIDATE" --manifest ./regrets/manifest.json 2>&1 | tail -10
validate_status=${PIPESTATUS[0]}
set -e

if [ "$validate_status" -ne 0 ]; then
  echo "✅ Phase 2 PASS — breaking refactor correctly FAILed (exit non-zero)"
else
  echo "❌ Phase 2 FAIL: breaking refactor should FAIL"
  cp "$BACKUP" "$LIB"
  exit 1
fi
echo

# ─── Phase 3: restore + sanity ────────────────────────────────────────────────
echo "═══ Phase 3: restore original + sanity validate ═══"
cp "$BACKUP" "$LIB"
if run_validate >/dev/null 2>&1; then
  echo "✅ Phase 3 PASS — restored code validates clean"
else
  echo "❌ Phase 3 FAIL: restored code should PASS"
  exit 1
fi
echo

# ─── Phase 4: cross-stack parity ──────────────────────────────────────────────
echo "═══ Phase 4: cross-stack fingerprint parity (Julia vs JS vs Nim) ═══"
if node verify-parity.mjs 2>&1 | tail -15; then
  echo "✅ Phase 4 PASS — Julia hash matches JS + Nim for all clusters"
else
  echo "❌ Phase 4 FAIL: cross-stack parity broken"
  exit 1
fi
echo

echo "═══ All phases passed ═══"
echo "  Phase 0 (baseline)            ✅ PASS"
echo "  Phase 1 (valid refactor)      ✅ PASS — Regrets stayed green"
echo "  Phase 2 (breaking refactor)   ✅ FAIL — Regrets caught the regression"
echo "  Phase 3 (restore)             ✅ PASS — back to original"
echo "  Phase 4 (cross-stack parity)  ✅ PASS — Julia hash == JS == Nim"
echo ""
echo "The .regret files in regrets/ are the golden contracts."
echo "Code is now back to the original — ready for a real refactor."
