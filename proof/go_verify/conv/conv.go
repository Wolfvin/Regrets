// Package conv — string transformations.
//
// This file is part of the independent verification of feat/go-validate-consolidated
// (PR #399). The functions here are DELIBERATELY DIFFERENT from the ones in
// tests/fixtures/go-example/ (Add, Multiply, Reverse, CountVowels, IsPalindrome)
// to avoid the confirmation-bias trap documented in CONTEXT.md "Lesson Learned":
// "test ditulis dengan pattern yang sama dengan implementasi".
package conv

import (
	"strings"
	"unicode"
)

// Slugify lowercases ASCII alphanumerics, replaces non-alnum runs with '-',
// and trims leading/trailing '-'. Returns "" for empty input.
func Slugify(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	lastSep := true // start as sep so leading '-' is trimmed
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(unicode.ToLower(r))
			lastSep = false
		} else {
			if !lastSep {
				b.WriteByte('-')
				lastSep = true
			}
		}
	}
	out := b.String()
	out = strings.TrimRight(out, "-")
	return out
}

// Base64Encode encodes a string's bytes using standard base64 alphabet with
// '=' padding. Empty input returns "". Implemented from scratch (not using
// encoding/base64) to exercise bit manipulation code paths.
//
// NOTE: takes a string (not []byte) so the regret harness can pass a JSON
// string input directly — see verification comment in proof/go_verify/README.md
// about a separate finding where the harness cannot pass []byte inputs.
func Base64Encode(s string) string {
	data := []byte(s)
	if len(data) == 0 {
		return ""
	}
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var b strings.Builder
	b.Grow(((len(data) + 2) / 3) * 4)
	for i := 0; i < len(data); i += 3 {
		var triple uint32
		triple = uint32(data[i]) << 16
		pad := 0
		if i+1 < len(data) {
			triple |= uint32(data[i+1]) << 8
		} else {
			pad = 2
		}
		if i+2 < len(data) {
			triple |= uint32(data[i+2])
		} else if pad == 0 {
			pad = 1
		}
		b.WriteByte(alphabet[(triple>>18)&0x3F])
		b.WriteByte(alphabet[(triple>>12)&0x3F])
		if pad < 2 {
			b.WriteByte(alphabet[(triple>>6)&0x3F])
		} else {
			b.WriteByte('=')
		}
		if pad < 1 {
			b.WriteByte(alphabet[triple&0x3F])
		} else {
			b.WriteByte('=')
		}
	}
	return b.String()
}
