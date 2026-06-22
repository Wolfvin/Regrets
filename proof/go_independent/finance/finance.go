// Package finance provides money/currency utility functions for the
// independent Go stack verification fixture (proof/go_independent/).
//
// Domain choice: this tests integer-cents arithmetic (avoiding float
// precision issues), string formatting with locale-aware separators,
// and table-driven error sentinels — patterns not covered by either
// the existing go_verify fixture (string/hash) or the datetime package
// above (time).
package finance

import (
        "fmt"
        "strings"
)

// FormatCents converts an integer number of cents into a "$X.YY" string.
// Negative inputs produce "-$X.YY". Zero produces "$0.00".
//
// Examples:
//   FormatCents(1099)   → "$10.99"
//   FormatCents(0)      → "$0.00"
//   FormatCents(-550)   → "-$5.50"
//   FormatCents(100000) → "$1000.00"
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

// ApplyDiscount applies a percentage discount (0-100) to a cents amount,
// rounding the discount DOWN (floor). Returns -1 if pct is out of range.
//
// Examples:
//   ApplyDiscount(1000, 10)  → 900   (10% off $10.00)
//   ApplyDiscount(999, 50)   → 499   (50% off $9.99, floor rounding)
//   ApplyDiscount(1000, 0)   → 1000
//   ApplyDiscount(1000, 100) → 0
//   ApplyDiscount(1000, 150) → -1
//   ApplyDiscount(1000, -5)  → -1
func ApplyDiscount(cents, pct int) int {
        if pct < 0 || pct > 100 {
                return -1
        }
        discount := cents * pct / 100
        return cents - discount
}

// SumCents sums a |-delimited list of cent amounts, skipping negative
// entries (treats them as 0). Returns the total in cents.
// Empty input returns 0. Non-integer entries are skipped.
//
// Examples:
//   SumCents("100|200|300")  → 600
//   SumCents("100|-50|200")  → 300   (negative skipped)
//   SumCents("")             → 0
//   SumCents("-100|-200")    → 0
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
                        continue // skip negatives
                }
                total += v
        }
        return total
}

// ParseMoney parses a "$X.YY" or "-$X.YY" string back into cents.
// Returns -1 if the input is not in the expected format.
//
// Examples:
//   ParseMoney("$10.99")   → 1099
//   ParseMoney("-$5.50")   → -550
//   ParseMoney("$0.00")    → 0
//   ParseMoney("10.99")    → -1
//   ParseMoney("$10")      → -1
//   ParseMoney("")         → -1
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
