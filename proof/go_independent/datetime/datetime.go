// Package datetime provides date/time utility functions for the independent
// Go stack verification fixture (proof/go_independent/).
//
// Domain choice: this is intentionally DIFFERENT from proof/go_verify/
// (which exercises string + hash + IP validation). The datetime domain
// tests:
//   - Struct return values (not just primitives)
//   - Multiple return values (Go idiom)
//   - Error return paths
//   - Time.Format() — Go's unique reference-date layout
//   - Edge cases: invalid input → error sentinel
package datetime

import (
	"fmt"
	"time"
)

// ParseISO8601 parses a strict ISO 8601 date-time string (RFC 3339) and
// returns the time in UTC. Returns an error if the input is not parseable
// as RFC 3339.
//
// Examples:
//   ParseISO8601("2026-06-22T15:04:05Z") → 2026-06-22 15:04:05 +0000 UTC, nil
//   ParseISO8601("not-a-date")           → zero time, error
func ParseISO8601(input string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, input)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid ISO 8601: %w", err)
	}
	return t.UTC(), nil
}

// FormatDuration converts a duration in seconds into a human-readable
// "Xh Ym Zs" string. Negative inputs are clamped to 0.
//
// Examples:
//   FormatDuration(3661) → "1h 1m 1s"
//   FormatDuration(45)   → "0h 0m 45s"
//   FormatDuration(-5)   → "0h 0m 0s"
func FormatDuration(seconds int) string {
	if seconds < 0 {
		seconds = 0
	}
	h := seconds / 3600
	m := (seconds % 3600) / 60
	s := seconds % 60
	return fmt.Sprintf("%dh %dm %ds", h, m, s)
}

// WeekdayName returns the English weekday name for the given ISO 8601
// date string. Returns "INVALID" for unparseable input.
//
// Examples:
//   WeekdayName("2026-06-22") → "Monday"     (2026-06-22 is a Monday)
//   WeekdayName("garbage")    → "INVALID"
func WeekdayName(isoDate string) string {
	t, err := time.Parse("2006-01-02", isoDate)
	if err != nil {
		return "INVALID"
	}
	return t.Weekday().String()
}

// DaysBetween computes the absolute number of days between two ISO 8601
// date strings. Returns -1 if either input is unparseable.
//
// Examples:
//   DaysBetween("2026-01-01", "2026-01-10") → 9
//   DaysBetween("2026-01-10", "2026-01-01") → 9   (absolute)
//   DaysBetween("garbage", "2026-01-01")    → -1
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

// AddBusinessDays adds N business days (Mon-Fri) to an ISO 8601 date,
// returning the resulting date in YYYY-MM-DD format. Skips weekends.
// Returns "INVALID" for unparseable input or n < 0.
//
// Examples:
//   AddBusinessDays("2026-06-22", 5)  → "2026-06-29"   (Mon + 5 biz = next Mon)
//   AddBusinessDays("2026-06-22", 0)  → "2026-06-22"
//   AddBusinessDays("garbage", 5)     → "INVALID"
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
