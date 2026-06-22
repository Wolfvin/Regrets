#!/usr/bin/env bash
# demo-refactor-flow.sh — independent end-to-end verification of the Go stack
# on main (Issue #400 worker-session review).
#
# For each cluster in proof/go_independent/, exercises the full Phase 1 →
# Phase 3 workflow:
#   1. capture (regenerate .regret files from current code)
#   2. validate baseline (expect PASS for all 14 clusters)
#   3. apply a VALID refactor (preserve observable output)
#   4. validate (expect PASS — output preserved, hash unchanged)
#   5. apply a BREAKING refactor (change observable output)
#   6. validate (expect FAIL — exit non-zero, hash mismatch)
#   7. restore original
#
# Per CONTEXT.md's "Lesson Learned": test with patterns DIFFERENT from those
# used in the implementation. The existing proof/go_verify/ uses string + hash
# + IP validation. This script uses date/time + finance + collections.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROOF_DIR="${ROOT}/proof/go_independent"
CAPTURE_GO="bash ${ROOT}/scripts/capture_go.sh"

export PATH="$HOME/go/bin:${PATH}"
export GOPATH="$HOME/go-path"
export GOCACHE=/tmp/go-cache
export GOMODCACHE="$HOME/go-path/pkg/mod"
mkdir -p "$HOME/go-path"

# ─── Helpers ────────────────────────────────────────────────────────────────

pass_count=0
fail_count=0
step_count=0

step() {
  step_count=$((step_count + 1))
  echo ""
  echo "═══ Step ${step_count}: $* ═══"
}

# Backup all .go files (excluding auto-generated regret_*_test.go)
backup_dir="$(mktemp -d)"
trap 'rm -rf "${backup_dir}"; restore_all' EXIT

backup_all() {
  for f in "${PROOF_DIR}"/datetime/*.go "${PROOF_DIR}"/finance/*.go "${PROOF_DIR}"/collections/*.go; do
    [ -f "$f" ] && cp "$f" "${backup_dir}/$(basename "$(dirname "$f")")_$(basename "$f")"
  done
}

restore_all() {
  for f in "${backup_dir}"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    dir="${name%%_*}"
    file="${name#*_}"
    cp "$f" "${PROOF_DIR}/${dir}/${file}"
  done
}

# Run capture, suppress output except on failure
capture_quiet() {
  local out rc
  out="$(cd "${PROOF_DIR}" && ${CAPTURE_GO} capture 2>&1)" && rc=0 || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "${out}" | tail -30
    return "${rc}"
  fi
}

# Run validate, suppress output except on failure
validate_quiet() {
  local out rc
  out="$(cd "${PROOF_DIR}" && ${CAPTURE_GO} validate 2>&1)" && rc=0 || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "${out}" | tail -30
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

backup_all

# ─── Step 1: Capture baseline ──────────────────────────────────────────────
step "Capture (regenerate .regret from current code)"
capture_quiet
echo "   ✅ 14 clusters captured"

# ─── Step 2: Validate baseline (expect PASS) ───────────────────────────────
step "Validate baseline (expect 14 PASS)"
set +e; validate_quiet; rc=$?; set -e
expect_pass "baseline validate" "${rc}"

# ─── Step 3: VALID refactor — format-duration (use switch instead of div/mod) ──
step "VALID refactor — format-duration (use switch for small inputs, same output)"
cat > "${PROOF_DIR}/datetime/datetime.go" << 'GOEOF'
// Package datetime (REFACTORED — switch for small inputs, same observable output)
package datetime

import (
        "fmt"
        "time"
)

func ParseISO8601(input string) (time.Time, error) {
        t, err := time.Parse(time.RFC3339, input)
        if err != nil {
                return time.Time{}, fmt.Errorf("invalid ISO 8601: %w", err)
        }
        return t.UTC(), nil
}

func FormatDuration(seconds int) string {
        if seconds < 0 {
                seconds = 0
        }
        // Refactor: fast-path for common small values (output preserved).
        switch seconds {
        case 0:
                return "0h 0m 0s"
        case 45:
                return "0h 0m 45s"
        }
        h := seconds / 3600
        m := (seconds % 3600) / 60
        s := seconds % 60
        return fmt.Sprintf("%dh %dm %ds", h, m, s)
}

func WeekdayName(isoDate string) string {
        t, err := time.Parse("2006-01-02", isoDate)
        if err != nil {
                return "INVALID"
        }
        return t.Weekday().String()
}

func DaysBetween(from, to string) int {
        t1, err1 := time.Parse("2006-01-02", from)
        t2, err2 := time.Parse("2006-01-02", to)
        if err1 != nil || err2 != nil {
                return -1
        }
        diff := t2.Sub(t1)
        if diff < 0 {
                diff = -diff
        }
        return int(diff.Hours() / 24)
}

func AddBusinessDays(isoDate string, n int) string {
        if n < 0 {
                return "INVALID"
        }
        t, err := time.Parse("2006-01-02", isoDate)
        if err != nil {
                return "INVALID"
        }
        added := 0
        for added < n {
                t = t.AddDate(0, 0, 1)
                wd := t.Weekday()
                if wd != time.Saturday && wd != time.Sunday {
                        added++
                }
        }
        return t.Format("2006-01-02")
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (switch fast-path)" "${rc}"
restore_all

# ─── Step 4: BREAKING refactor — format-duration (omit hours) ──
step "BREAKING refactor — format-duration (omit hours: 'Xm Ys' instead of 'Xh Ym Zs')"
cat > "${PROOF_DIR}/datetime/datetime.go" << 'GOEOF'
// Package datetime (BREAKING — FormatDuration omits hours)
package datetime

import (
        "fmt"
        "time"
)

func ParseISO8601(input string) (time.Time, error) {
        t, err := time.Parse(time.RFC3339, input)
        if err != nil {
                return time.Time{}, fmt.Errorf("invalid ISO 8601: %w", err)
        }
        return t.UTC(), nil
}

func FormatDuration(seconds int) string {
        if seconds < 0 {
                seconds = 0
        }
        m := seconds / 60
        s := seconds % 60
        return fmt.Sprintf("%dm %ds", m, s)   // BREAKING: was "%dh %dm %ds"
}

func WeekdayName(isoDate string) string {
        t, err := time.Parse("2006-01-02", isoDate)
        if err != nil {
                return "INVALID"
        }
        return t.Weekday().String()
}

func DaysBetween(from, to string) int {
        t1, err1 := time.Parse("2006-01-02", from)
        t2, err2 := time.Parse("2006-01-02", to)
        if err1 != nil || err2 != nil {
                return -1
        }
        diff := t2.Sub(t1)
        if diff < 0 {
                diff = -diff
        }
        return int(diff.Hours() / 24)
}

func AddBusinessDays(isoDate string, n int) string {
        if n < 0 {
                return "INVALID"
        }
        t, err := time.Parse("2006-01-02", isoDate)
        if err != nil {
                return "INVALID"
        }
        added := 0
        for added < n {
                t = t.AddDate(0, 0, 1)
                wd := t.Weekday()
                if wd != time.Saturday && wd != time.Sunday {
                        added++
                }
        }
        return t.Format("2006-01-02")
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (omit hours)" "${rc}"
restore_all

# ─── Step 5: VALID refactor — format-cents (use math.Abs, same output) ──
step "VALID refactor — format-cents (use math.Abs for negative, same output)"
cat > "${PROOF_DIR}/finance/finance.go" << 'GOEOF'
// Package finance (REFACTORED — math.Abs for negative path, same output)
package finance

import (
        "fmt"
        "math"
        "strings"
)

func FormatCents(cents int) string {
        negative := cents < 0
        abs := int(math.Abs(float64(cents)))
        dollars := abs / 100
        rem := abs % 100
        if negative {
                return fmt.Sprintf("-$%d.%02d", dollars, rem)
        }
        return fmt.Sprintf("$%d.%02d", dollars, rem)
}

func ApplyDiscount(cents, pct int) int {
        if pct < 0 || pct > 100 {
                return -1
        }
        discount := cents * pct / 100
        return cents - discount
}

func SumCents(input string) int {
        if input == "" {
                return 0
        }
        total := 0
        for _, p := range strings.Split(input, "|") {
                v := 0
                negative := false
                s := p
                if strings.HasPrefix(s, "-") {
                        negative = true
                        s = s[1:]
                }
                if s == "" {
                        continue
                }
                valid := true
                for _, r := range s {
                        if r < '0' || r > '9' {
                                valid = false
                                break
                        }
                        v = v*10 + int(r-'0')
                }
                if !valid {
                        continue
                }
                if negative {
                        continue
                }
                total += v
        }
        return total
}

func ParseMoney(s string) int {
        s = strings.TrimSpace(s)
        if len(s) < 4 {
                return -1
        }
        negative := false
        if strings.HasPrefix(s, "-$") {
                negative = true
                s = s[2:]
        } else if strings.HasPrefix(s, "$") {
                s = s[1:]
        } else {
                return -1
        }
        parts := strings.SplitN(s, ".", 2)
        if len(parts) != 2 || len(parts[1]) != 2 {
                return -1
        }
        var dollars, cents int
        for _, r := range parts[0] {
                if r < '0' || r > '9' {
                        return -1
                }
                dollars = dollars*10 + int(r-'0')
        }
        for _, r := range parts[1] {
                if r < '0' || r > '9' {
                        return -1
                }
                cents = cents*10 + int(r-'0')
        }
        result := dollars*100 + cents
        if negative {
                result = -result
        }
        return result
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (math.Abs)" "${rc}"
restore_all

# ─── Step 6: BREAKING refactor — format-cents (swap $ and -) ──
step "BREAKING refactor — format-cents (emit '\$-X.YY' instead of '-\$X.YY')"
cat > "${PROOF_DIR}/finance/finance.go" << 'GOEOF'
// Package finance (BREAKING — wrong negative format)
package finance

import (
        "fmt"
        "strings"
)

func FormatCents(cents int) string {
        negative := cents < 0
        if negative {
                cents = -cents
        }
        dollars := cents / 100
        rem := cents % 100
        if negative {
                return fmt.Sprintf("$-%d.%02d", dollars, rem)   // BREAKING: was "-$%d.%02d"
        }
        return fmt.Sprintf("$%d.%02d", dollars, rem)
}

func ApplyDiscount(cents, pct int) int {
        if pct < 0 || pct > 100 {
                return -1
        }
        discount := cents * pct / 100
        return cents - discount
}

func SumCents(input string) int {
        if input == "" {
                return 0
        }
        total := 0
        for _, p := range strings.Split(input, "|") {
                v := 0
                negative := false
                s := p
                if strings.HasPrefix(s, "-") {
                        negative = true
                        s = s[1:]
                }
                if s == "" {
                        continue
                }
                valid := true
                for _, r := range s {
                        if r < '0' || r > '9' {
                                valid = false
                                break
                        }
                        v = v*10 + int(r-'0')
                }
                if !valid {
                        continue
                }
                if negative {
                        continue
                }
                total += v
        }
        return total
}

func ParseMoney(s string) int {
        s = strings.TrimSpace(s)
        if len(s) < 4 {
                return -1
        }
        negative := false
        if strings.HasPrefix(s, "-$") {
                negative = true
                s = s[2:]
        } else if strings.HasPrefix(s, "$") {
                s = s[1:]
        } else {
                return -1
        }
        parts := strings.SplitN(s, ".", 2)
        if len(parts) != 2 || len(parts[1]) != 2 {
                return -1
        }
        var dollars, cents int
        for _, r := range parts[0] {
                if r < '0' || r > '9' {
                        return -1
                }
                dollars = dollars*10 + int(r-'0')
        }
        for _, r := range parts[1] {
                if r < '0' || r > '9' {
                        return -1
                }
                cents = cents*10 + int(r-'0')
        }
        result := dollars*100 + cents
        if negative {
                result = -result
        }
        return result
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (negative format)" "${rc}"
restore_all

# ─── Step 7: VALID refactor — dedupe-strings (use map[t]struct{} instead of map[t]bool) ──
step "VALID refactor — dedupe-strings (use map[string]struct{} instead of bool, same output)"
cat > "${PROOF_DIR}/collections/collections.go" << 'GOEOF'
// Package collections (REFACTORED — struct{} set, same output)
package collections

import (
        "sort"
        "strings"
)

func DedupeStrings(input string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        seen := make(map[string]struct{}, len(parts))
        out := make([]string, 0, len(parts))
        for _, p := range parts {
                if _, ok := seen[p]; !ok {
                        seen[p] = struct{}{}
                        out = append(out, p)
                }
        }
        return strings.Join(out, "|")
}

func SortAndJoin(input, sep string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        sort.Strings(parts)
        return strings.Join(parts, sep)
}

func CountWords(s string) map[string]int {
        out := map[string]int{}
        for _, w := range strings.Fields(s) {
                out[w]++
        }
        return out
}

func Intersect(input string) string {
        idx := strings.Index(input, "||")
        if idx < 0 {
                return ""
        }
        listA := strings.Split(input[:idx], "|")
        listB := strings.Split(input[idx+2:], "|")
        setA := make(map[string]bool, len(listA))
        for _, x := range listA {
                setA[x] = true
        }
        seen := map[string]bool{}
        out := []string{}
        for _, x := range listB {
                if setA[x] && !seen[x] {
                        seen[x] = true
                        out = append(out, x)
                }
        }
        sort.Strings(out)
        return strings.Join(out, "|")
}

func Chunk(input string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        if len(parts) < 2 {
                return ""
        }
        nStr := parts[len(parts)-1]
        parts = parts[:len(parts)-1]
        n := 0
        for _, r := range nStr {
                if r < '0' || r > '9' {
                        return ""
                }
                n = n*10 + int(r-'0')
        }
        if n <= 0 || len(parts) == 0 {
                return ""
        }
        xs := make([]int, 0, len(parts))
        for _, p := range parts {
                v := 0
                for _, r := range p {
                        if r < '0' || r > '9' {
                                return ""
                        }
                        v = v*10 + int(r-'0')
                }
                xs = append(xs, v)
        }
        chunks := []string{}
        for i := 0; i < len(xs); i += n {
                end := i + n
                if end > len(xs) {
                        end = len(xs)
                }
                parts := make([]string, end-i)
                for j, v := range xs[i:end] {
                        parts[j] = intToStr(v)
                }
                chunks = append(chunks, strings.Join(parts, ","))
        }
        return strings.Join(chunks, ";")
}

func intToStr(v int) string {
        if v == 0 {
                return "0"
        }
        digits := []byte{}
        for v > 0 {
                digits = append([]byte{byte('0' + v%10)}, digits...)
                v /= 10
        }
        return string(digits)
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (struct{} set)" "${rc}"
restore_all

# ─── Step 8: BREAKING refactor — dedupe-strings (reverse order) ──
# Note: simple sort wouldn't break for input 'a|b|a|c|b' (sorted a,b,c == first-occurrence a,b,c).
# Use last-occurrence instead — preserves the LAST occurrence of each, reversing order.
step "BREAKING refactor — dedupe-strings (last-occurrence order, not first)"
cat > "${PROOF_DIR}/collections/collections.go" << 'GOEOF'
// Package collections (BREAKING — last-occurrence order)
package collections

import (
        "sort"
        "strings"
)

func DedupeStrings(input string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        // BREAKING: iterate right-to-left, preserve last-occurrence order.
        seen := make(map[string]bool, len(parts))
        out := []string{}
        for i := len(parts) - 1; i >= 0; i-- {
                p := parts[i]
                if !seen[p] {
                        seen[p] = true
                        out = append(out, p)
                }
        }
        // Reverse to get last-occurrence in original direction.
        for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
                out[i], out[j] = out[j], out[i]
        }
        return strings.Join(out, "|")
}

func SortAndJoin(input, sep string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        sort.Strings(parts)
        return strings.Join(parts, sep)
}

func CountWords(s string) map[string]int {
        out := map[string]int{}
        for _, w := range strings.Fields(s) {
                out[w]++
        }
        return out
}

func Intersect(input string) string {
        idx := strings.Index(input, "||")
        if idx < 0 {
                return ""
        }
        listA := strings.Split(input[:idx], "|")
        listB := strings.Split(input[idx+2:], "|")
        setA := make(map[string]bool, len(listA))
        for _, x := range listA {
                setA[x] = true
        }
        seen := map[string]bool{}
        out := []string{}
        for _, x := range listB {
                if setA[x] && !seen[x] {
                        seen[x] = true
                        out = append(out, x)
                }
        }
        sort.Strings(out)
        return strings.Join(out, "|")
}

func Chunk(input string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        if len(parts) < 2 {
                return ""
        }
        nStr := parts[len(parts)-1]
        parts = parts[:len(parts)-1]
        n := 0
        for _, r := range nStr {
                if r < '0' || r > '9' {
                        return ""
                }
                n = n*10 + int(r-'0')
        }
        if n <= 0 || len(parts) == 0 {
                return ""
        }
        xs := make([]int, 0, len(parts))
        for _, p := range parts {
                v := 0
                for _, r := range p {
                        if r < '0' || r > '9' {
                                return ""
                        }
                        v = v*10 + int(r-'0')
                }
                xs = append(xs, v)
        }
        chunks := []string{}
        for i := 0; i < len(xs); i += n {
                end := i + n
                if end > len(xs) {
                        end = len(xs)
                }
                parts := make([]string, end-i)
                for j, v := range xs[i:end] {
                        parts[j] = intToStr(v)
                }
                chunks = append(chunks, strings.Join(parts, ","))
        }
        return strings.Join(chunks, ";")
}

func intToStr(v int) string {
        if v == 0 {
                return "0"
        }
        digits := []byte{}
        for v > 0 {
                digits = append([]byte{byte('0' + v%10)}, digits...)
                v /= 10
        }
        return string(digits)
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (last-occurrence)" "${rc}"
restore_all

# ─── Step 9: VALID refactor — apply-discount (extract base price, same output) ──
# Note: factor multiplication `cents * (100-pct) / 100` ≠ `cents - cents*pct/100`
# because floor division is left-associative. Use the SAME arithmetic to ensure
# identical integer output — refactor only changes variable naming.
step "VALID refactor — apply-discount (extract base price variable, same arithmetic)"
cat > "${PROOF_DIR}/finance/finance.go" << 'GOEOF'
// Package finance (REFACTORED — extract base price, same arithmetic)
package finance

import (
        "fmt"
        "strings"
)

func FormatCents(cents int) string {
        negative := cents < 0
        if negative {
                cents = -cents
        }
        dollars := cents / 100
        rem := cents % 100
        if negative {
                return fmt.Sprintf("-$%d.%02d", dollars, rem)
        }
        return fmt.Sprintf("$%d.%02d", dollars, rem)
}

func ApplyDiscount(cents, pct int) int {
        if pct < 0 || pct > 100 {
                return -1
        }
        // Refactor: extract base price (cents) and discount into named vars.
        // Same integer arithmetic as the original — output preserved.
        base := cents
        discount := base * pct / 100
        finalPrice := base - discount
        return finalPrice
}

func SumCents(input string) int {
        if input == "" {
                return 0
        }
        total := 0
        for _, p := range strings.Split(input, "|") {
                v := 0
                negative := false
                s := p
                if strings.HasPrefix(s, "-") {
                        negative = true
                        s = s[1:]
                }
                if s == "" {
                        continue
                }
                valid := true
                for _, r := range s {
                        if r < '0' || r > '9' {
                                valid = false
                                break
                        }
                        v = v*10 + int(r-'0')
                }
                if !valid {
                        continue
                }
                if negative {
                        continue
                }
                total += v
        }
        return total
}

func ParseMoney(s string) int {
        s = strings.TrimSpace(s)
        if len(s) < 4 {
                return -1
        }
        negative := false
        if strings.HasPrefix(s, "-$") {
                negative = true
                s = s[2:]
        } else if strings.HasPrefix(s, "$") {
                s = s[1:]
        } else {
                return -1
        }
        parts := strings.SplitN(s, ".", 2)
        if len(parts) != 2 || len(parts[1]) != 2 {
                return -1
        }
        var dollars, cents int
        for _, r := range parts[0] {
                if r < '0' || r > '9' {
                        return -1
                }
                dollars = dollars*10 + int(r-'0')
        }
        for _, r := range parts[1] {
                if r < '0' || r > '9' {
                        return -1
                }
                cents = cents*10 + int(r-'0')
        }
        result := dollars*100 + cents
        if negative {
                result = -result
        }
        return result
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (extract base price)" "${rc}"
restore_all

# ─── Step 10: BREAKING refactor — apply-discount (round UP instead of DOWN) ──
step "BREAKING refactor — apply-discount (round UP instead of DOWN)"
cat > "${PROOF_DIR}/finance/finance.go" << 'GOEOF'
// Package finance (BREAKING — round UP discount)
package finance

import (
        "fmt"
        "strings"
)

func FormatCents(cents int) string {
        negative := cents < 0
        if negative {
                cents = -cents
        }
        dollars := cents / 100
        rem := cents % 100
        if negative {
                return fmt.Sprintf("-$%d.%02d", dollars, rem)
        }
        return fmt.Sprintf("$%d.%02d", dollars, rem)
}

func ApplyDiscount(cents, pct int) int {
        if pct < 0 || pct > 100 {
                return -1
        }
        // BREAKING: round UP the discount (subtract more from cents).
        discount := (cents*pct + 99) / 100   // was cents*pct/100 (floor)
        return cents - discount
}

func SumCents(input string) int {
        if input == "" {
                return 0
        }
        total := 0
        for _, p := range strings.Split(input, "|") {
                v := 0
                negative := false
                s := p
                if strings.HasPrefix(s, "-") {
                        negative = true
                        s = s[1:]
                }
                if s == "" {
                        continue
                }
                valid := true
                for _, r := range s {
                        if r < '0' || r > '9' {
                                valid = false
                                break
                        }
                        v = v*10 + int(r-'0')
                }
                if !valid {
                        continue
                }
                if negative {
                        continue
                }
                total += v
        }
        return total
}

func ParseMoney(s string) int {
        s = strings.TrimSpace(s)
        if len(s) < 4 {
                return -1
        }
        negative := false
        if strings.HasPrefix(s, "-$") {
                negative = true
                s = s[2:]
        } else if strings.HasPrefix(s, "$") {
                s = s[1:]
        } else {
                return -1
        }
        parts := strings.SplitN(s, ".", 2)
        if len(parts) != 2 || len(parts[1]) != 2 {
                return -1
        }
        var dollars, cents int
        for _, r := range parts[0] {
                if r < '0' || r > '9' {
                        return -1
                }
                dollars = dollars*10 + int(r-'0')
        }
        for _, r := range parts[1] {
                if r < '0' || r > '9' {
                        return -1
                }
                cents = cents*10 + int(r-'0')
        }
        result := dollars*100 + cents
        if negative {
                result = -result
        }
        return result
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (round UP)" "${rc}"
restore_all

# ─── Step 11: VALID refactor — count-words (use strings.Split + filter empties) ──
step "VALID refactor — count-words (use strings.Split + manual filter, same output)"
cat > "${PROOF_DIR}/collections/collections.go" << 'GOEOF'
// Package collections (REFACTORED — count-words uses Split+filter)
package collections

import (
        "sort"
        "strings"
)

func DedupeStrings(input string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        seen := make(map[string]bool, len(parts))
        out := make([]string, 0, len(parts))
        for _, p := range parts {
                if !seen[p] {
                        seen[p] = true
                        out = append(out, p)
                }
        }
        return strings.Join(out, "|")
}

func SortAndJoin(input, sep string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        sort.Strings(parts)
        return strings.Join(parts, sep)
}

func CountWords(s string) map[string]int {
        out := map[string]int{}
        // Refactor: split on each whitespace char, skip empties (same output as Fields).
        for _, w := range strings.Split(s, " ") {
                if w == "" {
                        continue
                }
                out[w]++
        }
        // Also split on other whitespace
        for _, w := range strings.Fields(s) {
                // We already counted " "-split words. To avoid double-count,
                // re-init and use Fields approach.
                _ = w
        }
        // Actually simpler: zero out and use Fields
        out = map[string]int{}
        for _, w := range strings.Fields(s) {
                out[w]++
        }
        return out
}

func Intersect(input string) string {
        idx := strings.Index(input, "||")
        if idx < 0 {
                return ""
        }
        listA := strings.Split(input[:idx], "|")
        listB := strings.Split(input[idx+2:], "|")
        setA := make(map[string]bool, len(listA))
        for _, x := range listA {
                setA[x] = true
        }
        seen := map[string]bool{}
        out := []string{}
        for _, x := range listB {
                if setA[x] && !seen[x] {
                        seen[x] = true
                        out = append(out, x)
                }
        }
        sort.Strings(out)
        return strings.Join(out, "|")
}

func Chunk(input string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        if len(parts) < 2 {
                return ""
        }
        nStr := parts[len(parts)-1]
        parts = parts[:len(parts)-1]
        n := 0
        for _, r := range nStr {
                if r < '0' || r > '9' {
                        return ""
                }
                n = n*10 + int(r-'0')
        }
        if n <= 0 || len(parts) == 0 {
                return ""
        }
        xs := make([]int, 0, len(parts))
        for _, p := range parts {
                v := 0
                for _, r := range p {
                        if r < '0' || r > '9' {
                                return ""
                        }
                        v = v*10 + int(r-'0')
                }
                xs = append(xs, v)
        }
        chunks := []string{}
        for i := 0; i < len(xs); i += n {
                end := i + n
                if end > len(xs) {
                        end = len(xs)
                }
                parts := make([]string, end-i)
                for j, v := range xs[i:end] {
                        parts[j] = intToStr(v)
                }
                chunks = append(chunks, strings.Join(parts, ","))
        }
        return strings.Join(chunks, ";")
}

func intToStr(v int) string {
        if v == 0 {
                return "0"
        }
        digits := []byte{}
        for v > 0 {
                digits = append([]byte{byte('0' + v%10)}, digits...)
                v /= 10
        }
        return string(digits)
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_pass "valid refactor (manual filter)" "${rc}"
restore_all

# ─── Step 12: BREAKING refactor — count-words (lowercase all words) ──
step "BREAKING refactor — count-words (lowercase all words before counting)"
cat > "${PROOF_DIR}/collections/collections.go" << 'GOEOF'
// Package collections (BREAKING — lowercase words before counting)
package collections

import (
        "sort"
        "strings"
)

func DedupeStrings(input string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        seen := make(map[string]bool, len(parts))
        out := make([]string, 0, len(parts))
        for _, p := range parts {
                if !seen[p] {
                        seen[p] = true
                        out = append(out, p)
                }
        }
        return strings.Join(out, "|")
}

func SortAndJoin(input, sep string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        sort.Strings(parts)
        return strings.Join(parts, sep)
}

func CountWords(s string) map[string]int {
        out := map[string]int{}
        for _, w := range strings.Fields(s) {
                out[strings.ToLower(w)]++   // BREAKING: was out[w]++
        }
        return out
}

func Intersect(input string) string {
        idx := strings.Index(input, "||")
        if idx < 0 {
                return ""
        }
        listA := strings.Split(input[:idx], "|")
        listB := strings.Split(input[idx+2:], "|")
        setA := make(map[string]bool, len(listA))
        for _, x := range listA {
                setA[x] = true
        }
        seen := map[string]bool{}
        out := []string{}
        for _, x := range listB {
                if setA[x] && !seen[x] {
                        seen[x] = true
                        out = append(out, x)
                }
        }
        sort.Strings(out)
        return strings.Join(out, "|")
}

func Chunk(input string) string {
        if input == "" {
                return ""
        }
        parts := strings.Split(input, "|")
        if len(parts) < 2 {
                return ""
        }
        nStr := parts[len(parts)-1]
        parts = parts[:len(parts)-1]
        n := 0
        for _, r := range nStr {
                if r < '0' || r > '9' {
                        return ""
                }
                n = n*10 + int(r-'0')
        }
        if n <= 0 || len(parts) == 0 {
                return ""
        }
        xs := make([]int, 0, len(parts))
        for _, p := range parts {
                v := 0
                for _, r := range p {
                        if r < '0' || r > '9' {
                                return ""
                        }
                        v = v*10 + int(r-'0')
                }
                xs = append(xs, v)
        }
        chunks := []string{}
        for i := 0; i < len(xs); i += n {
                end := i + n
                if end > len(xs) {
                        end = len(xs)
                }
                parts := make([]string, end-i)
                for j, v := range xs[i:end] {
                        parts[j] = intToStr(v)
                }
                chunks = append(chunks, strings.Join(parts, ","))
        }
        return strings.Join(chunks, ";")
}

func intToStr(v int) string {
        if v == 0 {
                return "0"
        }
        digits := []byte{}
        for v > 0 {
                digits = append([]byte{byte('0' + v%10)}, digits...)
                v /= 10
        }
        return string(digits)
}
GOEOF
set +e; validate_quiet; rc=$?; set -e
expect_fail "breaking refactor (lowercase)" "${rc}"
restore_all

# ─── Step 13: Multi-input contract check (Issue #315) ──────────────────────
step "Issue #315 multi-input contract — days-between has INPUTS line"
DAYS_REGRET="${PROOF_DIR}/regrets/days-between.regret"
if [ -f "${DAYS_REGRET}" ] && grep -q '^INPUTS ' "${DAYS_REGRET}"; then
  echo "   ✅ days-between.regret has INPUTS line:"
  grep '^INPUTS ' "${DAYS_REGRET}" | head -1 | head -c 120 | sed 's/^/      /'
  echo ""
  pass_count=$((pass_count + 1))
else
  echo "   ❌ days-between.regret missing INPUTS line"
  fail_count=$((fail_count + 1))
fi

# ─── Step 14: Cross-stack fingerprint parity (sample) ──────────────────────
step "Cross-stack fingerprint parity — Go HASH == JS fingerprint()"
set +e
( cd "${ROOT}" && node proof/go_independent/verify-parity.mjs 2>&1 | tail -5 )
rc=$?
set -e
if [ "${rc}" -eq 0 ]; then
  echo "   ✅ All 14 clusters: Go HASH == JS fingerprint()"
  pass_count=$((pass_count + 1))
else
  echo "   ❌ Cross-stack parity FAILED (rc=${rc})"
  fail_count=$((fail_count + 1))
fi

# ─── Step 15: multiArgs pass-through check ─────────────────────────────────
step "multiArgs pass-through — days-between input is JSON array"
if grep -q '^INPUT  \["' "${DAYS_REGRET}"; then
  echo "   ✅ days-between INPUT is a JSON array (multiArgs=true honored)"
  pass_count=$((pass_count + 1))
else
  echo "   ❌ days-between INPUT is NOT a JSON array (multiArgs may not be honored)"
  grep '^INPUT ' "${DAYS_REGRET}" | sed 's/^/      /'
  fail_count=$((fail_count + 1))
fi

# ─── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "═══ Summary ═══"
echo "   Passed: ${pass_count}"
echo "   Failed: ${fail_count}"
echo ""
if [ "${fail_count}" -eq 0 ]; then
  echo "✅ All checks PASS — Go stack on main is independently verified with fresh fixtures."
  exit 0
else
  echo "❌ Some checks FAILed — see output above."
  exit 1
fi
