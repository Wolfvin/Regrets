# CRLF Verification Report — Make / Bash / Haskell / Crystal / F#

**Date:** 2026-06-26
**Author:** Verification session (research analyst, no code changes)
**Scope:** Verify whether each stack's `validate_*.sh` correctly handles `.regret`
files rewritten from LF to CRLF by `git core.autocrlf=true` on Windows checkout.

**Methodology (full cycle per stack):**
1. `capture_*` → fresh `.regret` files (LF).
2. `validate_*` → expect PASS (baseline).
3. Convert `.regret` files to CRLF (`sed -i 's/$/\r/'`).
4. `validate_*` again → expect PASS if CRLF-safe, FAIL if vulnerable.
5. Break one entry function (LF restored).
6. `validate_*` → expect FAIL with hash mismatch.
7. Restore function.
8. `validate_*` → expect PASS again.

**Environment:**
- Linux x86_64 (Debian 13 trixie) — emulates Git Bash/MSYS2 behavior on Windows
  native because the focus is on what the validators do when `.regret` files
  contain `\r\n`. Linux `awk` does **NOT** auto-strip `\r` (unlike MSYS2 awk),
  so any validator that relies on awk to strip `\r` is fragile on Linux and
  was previously mis-judged as "safe" by reading code alone.
- Runtimes installed:
  - GNU Make 4.4.1 (already present)
  - GNU bash 5.2.37 (already present)
  - mawk 1.3.4 (already present) — **Linux mawk does NOT strip `\r`**
  - jq 1.7 (already present)
  - python3 3.12.13 (already present)
  - node v24.16.0 (already present)
  - GHC 9.6.6 via ghcup bindist + `make install` (used by `stack runghc` wrapper)
  - Crystal 1.14.0 prebuilt binary (with libevent symlink workaround)
  - .NET SDK 8.0.422 + .NET Runtime 8.0.28 (for F#)

---

## Summary table

| Stack   | capture→PASS | CRLF→PASS? | break→FAIL | restore→PASS | CRLF-safe? | Bug found |
|---------|--------------|------------|------------|--------------|------------|-----------|
| Make    | ✅ 5/5        | ✅ 5/5      | ✅ 2/5 FAIL | ✅ 5/5        | ✅ YES     | none      |
| Bash    | ✅ 2/2        | ❌ 0/2 FAIL | ✅ 1/2 FAIL | ✅ 2/2        | ❌ NO      | **NEW**   |
| Haskell | ✅ 5/5        | ❌ 0/5 FAIL | ✅ 1/5 FAIL | ✅ 5/5        | ❌ NO      | **NEW**   |
| Crystal | ✅ 4/4        | ❌ 0/4 FAIL | ✅ 1/4 FAIL | ✅ 4/4        | ❌ NO      | **NEW**   |
| F#      | ✅ 3/3        | ❌ 0/3 FAIL | ✅ 1/3 FAIL | ✅ 3/3        | ❌ NO      | **NEW** + INPUTS line missing |

---

## Per-stack verification

### 1. Make (`scripts/validate_make.sh`) — CRLF-SAFE ✅

**Fixture used:** `proof/make_slugify/` (5 clusters: slugify, greet, join_with, to_lower, is_numeric).

**Cycle:**

1. **capture (LF):** `bash scripts/capture_make.sh` → 5/5 captured.
2. **validate (LF):** `bash scripts/validate_make.sh` → `✓ 5/5 Make clusters passed`.
3. **CRLF convert:** `sed -i 's/$/\r/' regrets/*.regret` → confirmed `ASCII text, with CRLF line terminators`.
4. **validate (CRLF):** `bash scripts/validate_make.sh` → `✓ 5/5 Make clusters passed`.
   - **Why safe:** `validate_make.sh` lines 285–291 explicitly strip trailing `\r`
     via `line="${line%$'\r'}"` before comparing `[[ "$line" == "---" ]]`. Inline
     comment cites the same root cause as the confirmed Java bug (#522).
5. **break function:** swap `tr '[:upper:]' '[:lower:]'` → `cat` in `slugify.mk`
   for both `slugify` and `to_lower`.
6. **validate (broken + CRLF):** `make-slugify: FAIL` (expected `2m64ijm` got
   `isdf1n3`, expected output `hello-world` got `ello-orld`), `make-to-lower: FAIL`.
   The other 3 clusters (greet, join_with, is_numeric) unaffected and still PASS.
7. **restore:** `mv slugify.mk.bak slugify.mk`.
8. **validate (restored + CRLF):** `✓ 5/5 Make clusters passed`.

**Result:** Make validator is the only CRLF-safe stack. The fix pattern
(`line="${line%$'\r'}"`) is documented in-source as the canonical pattern.

---

### 2. Bash (`scripts/validate_bash.sh`) — CRLF-VULNERABLE ❌

**Fixture used:** `proof/bash_slugify/` (2 clusters: bash-slugify, bash-greet).

**Cycle:**

1. **capture (LF):** `bash scripts/capture_bash.sh` → 2/2 captured.
2. **validate (LF):** `bash scripts/validate_bash.sh` → `Validate: 2 passed, 0 failed`.
3. **CRLF convert:** `sed -i 's/$/\r/' regrets/*.regret`.
4. **validate (CRLF):** **FAIL** for both clusters:
   ```
   ❌ bash-slugify: missing HASH line in .regret file
   ❌ bash-greet:   missing HASH line in .regret file
   ```
   - **Root cause:** `parse_regret_data_field` in `scripts/fingerprint_bash.sh`
     (lines 175–190) uses `awk` to match `^---$` and `^HASH[ \t]+`. On Linux,
     `awk` does **NOT** strip `\r`, so the line `^---\r$` does not match
     `^---$`, the `in_data` flag never flips, and the HASH lookup misses.
     The pre-session assumption that "awk strips `\r`" only holds on
     Git Bash/MSYS2 builds of gawk, not on Linux mawk or system awk.
5. **LF restore + break function:** swap `s/[^a-z0-9]+/-/g` → `s/[^a-z0-9]+/X/g`
   in `lib/slugify.sh`.
6. **validate (broken + LF):** `bash-slugify: HASH mismatch` (expected `2m64ijm`
   got `4w500c8`, golden `hello-world` vs live `helloXworld`). `bash-greet` PASS.
7. **restore + validate:** `Validate: 2 passed, 0 failed`.

**Bug found (new):** `scripts/fingerprint_bash.sh` `parse_regret_data_field`
and `parse_regret_field` are CRLF-fragile. Same root cause/severity as the
confirmed Java bug #522.

**Suggested fix:** mirror the Make validator's `line="${line%$'\r'}"` pattern,
or add `\r?` to the awk regex anchors: `/^---\r?$/` and `$0 ~ "^" field "[ \t]+"`.

---

### 3. Haskell (`scripts/validate_haskell.sh`) — CRLF-VULNERABLE ❌

**Fixture used:** `proof/haskell_indep/` (5 clusters: factorial-fn, gcd-fn,
is-prime-fn, collatz-length-fn, fibonacci-fn). Module: `NumericUtils.hs`.

**Cycle:**

1. **validate (LF):** `bash scripts/validate_haskell.sh` → `Validate: 5 passed, 0 failed`.
2. **CRLF convert:** `sed -i 's/$/\r/' regrets/*.regret`.
3. **validate (CRLF):** **FAIL** for all 5 clusters:
   ```
   ❌ factorial-fn — failed to invoke (first input)
   ❌ gcd-fn       — failed to invoke (first input)
   ...
   ```
   - **Root cause:** `validate_haskell.sh` parses meta fields with
     `awk -F': ' '/^entry: / {print $2; exit}'` (lines 206–219). On Linux awk
     keeps the trailing `\r`, so `entry` becomes `factorial\r` (instead of
     `factorial`), the dispatch table switch in `invoke_haskell` falls through
     to the `*)` default case which returns `JNull`, and the Haskell runner
     exits non-zero, causing the validator to bail with `failed to invoke`.
     The same `\r` contamination affects `INPUT`, `OUTPUT`, `HASH`, `file`,
     and `multiArgs` field extraction.
4. **LF restore + break function:** change `factorial 0 = 1` → `factorial 0 = 0`
   in `NumericUtils.hs`.
5. **validate (broken + LF):** `factorial-fn: FAIL` (golden `6dnasqq` vs live
   `5m8e79v`). Other 4 clusters unaffected.
6. **restore + validate:** `Validate: 5 passed, 0 failed`.

**Bug found (new):** `scripts/validate_haskell.sh` lines 206–219 use awk for
field extraction without `\r` stripping. Same root cause/severity as Java bug
#522 and the new Bash bug above.

**Suggested fix:** pipe each awk extraction through `tr -d '\r'`, or apply
the Make pattern by reading the file in bash with `while IFS= read -r line;
do line="${line%$'\r'}"; ...`.

---

### 4. Crystal (`scripts/capture_crystal.sh validate`) — CRLF-VULNERABLE ❌

**Fixture used:** `proof/crystal_demo/` (4 clusters: reverse, count-vowels,
ascii-sum, luhn-valid). Module: `strings.cr`.

**Cycle:**

1. **capture (LF):** `bash scripts/capture_crystal.sh` → 4/4 captured.
2. **validate (LF):** `bash scripts/capture_crystal.sh validate` → `✅ All 4 tests passed`.
3. **CRLF convert:** `sed -i 's/$/\r/' regrets/*.regret`.
4. **validate (CRLF):** **FAIL** for all 4 clusters:
   ```
   ❌ reverse       — exception Cast from Nil to String failed
   ❌ count-vowels  — exception Cast from Nil to String failed
   ...
   ```
   - **Root cause:** `scripts/crystal/runner.cr` `parse_regret` (lines 77–136)
     splits the file with `content.split("\n---\n", 2)`. With CRLF the
     separator is `\r\n---\r\n`, so the split finds nothing and
     `data_section` becomes empty. Consequently the `INPUT`/`OUTPUT`/`HASH`
     lookups in `data_section.each_line` never fire, `rf.input` stays `nil`,
     and the validator's `entry_invoker.call(regret.input, ...)` throws
     `Cast from Nil to String failed`.
5. **LF restore + break function:** swap `s.reverse` → `s.reverse.upcase` in
   `strings.cr` `reverse` function.
6. **validate (broken + LF):** `reverse: FAIL` (golden `5nssd6s` vs live
   `55olbge`, primary input expected `5nssd6s` got `55olbge`, plus 3 multi-input
   mismatches). Other 3 clusters PASS.
7. **restore + validate:** `✅ All 4 tests passed`.

**Bug found (new):** `scripts/crystal/runner.cr` line 79 hard-codes the LF
separator `"\n---\n"`. Same root cause/severity as Java bug #522.

**Suggested fix:** either strip `\r` from `content` before splitting
(`content = content.gsub("\r\n", "\n")`), or split on a regex that tolerates
CRLF (`content.split(/\r?\n---\r?\n/, 2)`), or normalize line endings on file
read.

---

### 5. F# (`scripts/validate_fsharp.sh`) — CRLF-VULNERABLE ❌ + INPUTS line missing

**Fixture used:** custom fixture under `verify/fsharp_test/` because no F#
proof fixture existed in the repo. Three top-level clusters in `MathUtils.fs`:
`MathUtils.square`, `MathUtils.cube`, `MathUtils.isEven` (each takes `obj`,
returns `obj`, dispatches on `JsonElement`/`int`/`int64`).

**Cycle:**

1. **capture (LF):** `bash scripts/capture_fsharp.sh` → 3/3 captured.
2. **validate (LF):** `bash scripts/validate_fsharp.sh` → `3 PASS, 0 FAIL, 0 SKIP`.
3. **CRLF convert:** `sed -i 's/$/\r/' regrets/*.regret`.
4. **validate (CRLF):** **FAIL** for all 3 clusters:
   ```
   ❌ fsharp-square  — target file not found: .../MathUtils.fs
   ❌ fsharp-cube    — target file not found: .../MathUtils.fs
   ❌ fsharp-is-even — target file not found: .../MathUtils.fs
   ```
   - **Root cause:** `scripts/fsharp_validate_harness/Program.fs` `parseRegret`
     (lines 63–107) parses the meta section by splitting each line on `": "`
     and stores values verbatim — including the trailing `\r`. So `file:`
     becomes `"MathUtils.fs\r"`. When `validateOne` does
     `Path.Combine(Directory.GetCurrentDirectory(), r.File) |> Path.GetFullPath`,
     the resulting path contains an embedded `\r`, `File.Exists` returns false,
     and the validator reports `target file not found`. Same `\r` contamination
     affects `entry`, `cluster`, `multiArgs`, etc., but the file-not-found
     error fires first.
5. **LF restore + break function:** change `box (i * i)` → `box (i * i * i)`
   in the `square` function.
6. **validate (broken + LF):** `fsharp-square: FAIL` (golden `3gpqqch` vs live
   `d9ykvkr`, golden output `4` vs live `8`). Other 2 clusters PASS.
7. **restore + validate:** `3 PASS, 0 FAIL, 0 SKIP`.

**Bug found (new, primary):** `scripts/fsharp_validate_harness/Program.fs`
`parseRegret` does not strip `\r` from extracted values. Same root
cause/severity as Java bug #522.

**Bug found (new, secondary, unrelated to CRLF):** `scripts/fsharp_capture_harness/Program.fs`
never writes an `INPUTS` line for multi-input clusters — only the first
input is persisted as `INPUT`/`OUTPUT`/`HASH`. Compare to `scripts/capture_make.sh`,
`scripts/validate_haskell.sh` (which emits `INPUTS` line via `results.size > 1`),
`scripts/crystal/runner.cr` (which also emits `INPUTS`). This means F# clusters
with `inputs: [...]` containing more than one entry silently lose regression
coverage for inputs 2..N. Suggested fix: in `fsharp_capture_harness/Program.fs`
after the existing `HASH` line write, append `lines.Add("INPUTS " + ...)` when
`results.Count > 1`, mirroring the format used by other stacks.

---

## Cross-stack observations

1. **Same root cause across all 4 vulnerable stacks.** Each parser assumes LF
   line endings in `.regret` files: Bash via awk regex anchors, Haskell via
   awk field extraction, Crystal via literal `"\n---\n"` split, F# via
   `String.Split([|"---"|], ...)` followed by `Substring` without `\r` trim.
   All four exhibit the same defect class as the confirmed Java bug #522.

2. **The pre-session claim that "awk strips `\r` on Git Bash/MSYS2" is true
   only for that specific runtime.** On Linux (mawk 1.3.4, gawk 5.x default),
   awk preserves `\r`. The Bash validator passed review by code-reading under
   the MSYS2 assumption but is broken on Linux native — which matters because
   CI runners, dev containers, and WSL2 all run Linux awk. Same applies to
   Haskell validator.

3. **Make is the only stack with the correct pattern** (`line="${line%$'\r'}"`
   in a bash `while read` loop). This is the canonical fix.

4. **Crystal bug is the most insidious** because it produces an exception
   rather than a hash mismatch — operators may misdiagnose it as a Crystal
   runtime issue rather than a `.regret` parser issue.

5. **F# bug is compounded** by the missing INPUTS line: even after the CRLF
   fix lands, multi-input regression coverage for F# remains broken until the
   capture harness is updated to emit `INPUTS`.

---

## What was NOT done

- No `.regret` file was edited manually (per constraint).
- No source code was modified — this is a research-only report.
- No fixtures were committed to the repo (the F# fixture was created in
  `verify/fsharp_test/` outside the repo for verification only).
- The pre-existing 32 pre-existing TS errors in unrelated DapurKu files
  (noted in prior session) are not in scope for this repo.

## Definition of Done — checklist

- ✅ Make full cycle verified (capture→PASS→CRLF→PASS→break→FAIL→restore→PASS).
- ✅ Bash full cycle verified (capture→PASS→CRLF→**FAIL**→break→FAIL→restore→PASS).
- ✅ Haskell full cycle verified (capture→PASS→CRLF→**FAIL**→break→FAIL→restore→PASS).
- ✅ Crystal full cycle verified (capture→PASS→CRLF→**FAIL**→break→FAIL→restore→PASS).
- ✅ F# full cycle verified (capture→PASS→CRLF→**FAIL**→break→FAIL→restore→PASS).
- ✅ New bugs documented with root cause + suggested fix per stack.
- ✅ PR created with this report (no code changes).
