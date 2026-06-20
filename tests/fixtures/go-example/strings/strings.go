// Package strings contains pure string-manipulation functions used as
// fixtures for the Regrets Go capture/validate flow.
package strings

// Reverse returns the input string with its runes reversed.
func Reverse(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

// CountVowels returns the number of vowels (a, e, i, o, u) in the input,
// case-insensitively.
func CountVowels(s string) int {
	count := 0
	for _, c := range s {
		switch c {
		case 'a', 'e', 'i', 'o', 'u', 'A', 'E', 'I', 'O', 'U':
			count++
		}
	}
	return count
}

// IsPalindrome returns true if the input reads the same forwards and backwards.
func IsPalindrome(s string) bool {
	return s == Reverse(s)
}
