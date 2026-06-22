// Package collections provides collection utility functions for the
// independent Go stack verification fixture (proof/go_independent/).
//
// Domain choice: this exercises Go's slice + map idioms, plus early-return
// error sentinels. None of the existing go_verify functions return slices
// or maps as output — they all return primitives. This package tests the
// fingerprint pipeline's ability to serialize collections deterministically.
//
// Input convention: capture_go.sh's reflect-based invocation does not
// automatically convert []interface{} → []string or []int. So collection-
// taking functions here accept their input as a single string and split
// internally on a delimiter. This keeps the manifest input simple (a JSON
// string) while still exercising slice + map logic in the function body.
package collections

import (
	"sort"
	"strings"
)

// DedupeStrings removes duplicate strings from a |-delimited input,
// preserving first-occurrence order. Returns the deduped list joined by |.
// Empty input returns "".
//
// Examples:
//   DedupeStrings("a|b|a|c|b") → "a|b|c"
//   DedupeStrings("")         → ""
//   DedupeStrings("solo")     → "solo"
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

// SortAndJoin sorts a |-delimited input lexicographically and joins with
// the given separator. Returns "" for empty input.
//
// Examples:
//   SortAndJoin("banana|apple|cherry", ",") → "apple,banana,cherry"
//   SortAndJoin("", ",")                    → ""
//   SortAndJoin("solo", "-")                → "solo"
func SortAndJoin(input, sep string) string {
	if input == "" {
		return ""
	}
	parts := strings.Split(input, "|")
	sort.Strings(parts)
	return strings.Join(parts, sep)
}

// CountWords returns a map of word → count for the input string.
// Words are split on whitespace. Empty input returns an empty map.
//
// Examples:
//   CountWords("the quick brown fox the") → {"the":2, "quick":1, "brown":1, "fox":1}
//   CountWords("")                        → {}
//   CountWords("   ")                     → {}
func CountWords(s string) map[string]int {
	out := map[string]int{}
	for _, w := range strings.Fields(s) {
		out[w]++
	}
	return out
}

// Intersect returns the sorted intersection of two |-delimited lists.
// Each list is a |-separated string; the input is "listA|listB" where the
// two lists are separated by "||" (a double-pipe). Returns the intersection
// joined by "|".
//
// Examples:
//   Intersect("a|b|c||b|c|d") → "b|c"
//   Intersect("a|b||c|d")     → ""
//   Intersect("x|y|z||a|b|c|x") → "x"
func Intersect(input string) string {
	// Split into two halves on "||"
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

// Chunk splits a |-delimited list of integers into chunks of size n.
// Input format: "1|2|3|4|5|2" means xs=[1,2,3,4,5] n=2 (last element is n).
// Returns chunks joined by ";" and items within a chunk joined by ",".
// Returns "" for n <= 0 or empty input.
//
// Examples:
//   Chunk("1|2|3|4|5|2") → "1,2;3,4;5"
//   Chunk("1|2|3|5")     → "1,2,3,5"     (n=5, single chunk)
//   Chunk("1|2|3|0")     → ""            (n=0)
func Chunk(input string) string {
	if input == "" {
		return ""
	}
	parts := strings.Split(input, "|")
	if len(parts) < 2 {
		return ""
	}
	// Last part is n
	nStr := parts[len(parts)-1]
	parts = parts[:len(parts)-1]
	// Parse n
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
	// Parse integers
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
	// Chunk
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

// intToStr converts a non-negative int to its decimal string form without
// using fmt (keeps the dependency list minimal).
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
