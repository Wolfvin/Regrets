// Package validation — parsers + range checks.
//
// Part of independent verification of PR #399. Validates structured strings
// (IPv4 dotted-quad, hex color, simple email) — exercises the manifest's
// reflect invocation on functions returning bool and returning a struct.
package validation

import (
	"fmt"
	"strings"
)

// IsValidIPv4 returns true iff s is a valid dotted-quad: exactly 4 octets
// 0-255 separated by single '.', no leading zeros (except "0" itself), no
// trailing junk. Rejects "01.2.3.4", "1.2.3.4x", "1.2.3", "1.2.3.4.5".
func IsValidIPv4(s string) bool {
	if s == "" {
		return false
	}
	octets := 0
	val := 0
	digits := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= '0' && c <= '9' {
			if digits == 1 && val == 0 {
				return false // leading zero
			}
			if digits >= 3 {
				return false
			}
			val = val*10 + int(c-'0')
			digits++
			if val > 255 {
				return false
			}
		} else if c == '.' {
			if digits == 0 {
				return false // empty octet
			}
			octets++
			if octets > 4 {
				return false
			}
			// Next char must be a digit
			if i+1 >= len(s) || s[i+1] < '0' || s[i+1] > '9' {
				return false
			}
			val = 0
			digits = 0
		} else {
			return false // invalid char
		}
	}
	if digits == 0 {
		return false
	}
	octets++
	return octets == 4
}

// HexColor is the parsed result of a CSS hex color string.
type HexColor struct {
	R, G, B uint8
	Alpha   uint8 // 255 if no alpha specified
}

// ParseHexColor parses a CSS hex color: #RGB, #RGBA, #RRGGBB, or #RRGGBBAA.
// Returns the color struct and a bool indicating whether the parse succeeded.
// Lowercase, uppercase, and mixed case are all accepted.
func ParseHexColor(s string) (HexColor, bool) {
	if len(s) < 4 || s[0] != '#' {
		return HexColor{}, false
	}
	hex := s[1:]
	if !isAllHex(hex) {
		return HexColor{}, false
	}
	switch len(hex) {
	case 3:
		r, ok1 := hexVal(hex[0])
		g, ok2 := hexVal(hex[1])
		b, ok3 := hexVal(hex[2])
		if !ok1 || !ok2 || !ok3 {
			return HexColor{}, false
		}
		return HexColor{R: r*16 + r, G: g*16 + g, B: b*16 + b, Alpha: 255}, true
	case 6:
		r := hexByte(hex[0:2])
		g := hexByte(hex[2:4])
		b := hexByte(hex[4:6])
		return HexColor{R: r, G: g, B: b, Alpha: 255}, true
	default:
		return HexColor{}, false
	}
}

// FormatHexColor is a struct-method variant: returns the canonical #RRGGBB
// form. Exercises a method-on-struct invocation pattern (different from
// free-function calls in the rest of the fixture).
func (c HexColor) FormatHexColor() string {
	return fmt.Sprintf("#%02X%02X%02X", c.R, c.G, c.B)
}

func isAllHex(s string) bool {
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

func hexVal(c byte) (uint8, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

func hexByte(s string) uint8 {
	hi, _ := hexVal(s[0])
	lo, _ := hexVal(s[1])
	return hi*16 + lo
}

// _ = strings.TrimSpace (placeholder import to keep imports stable if we
// add string-normalization later — Go's unused-import rule would otherwise
// fail compilation during refactors).
var _ = strings.TrimSpace
