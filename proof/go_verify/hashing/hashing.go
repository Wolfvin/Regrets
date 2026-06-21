// Package hashing — table-driven checksums.
//
// Part of independent verification of PR #399. Uses table-driven algorithm
// (CRC32, FNV1a) to exercise the manifest's reflect invocation on functions
// that take a string input and return a uint32.
//
// NOTE: takes a string (not []byte) so the regret harness can pass a JSON
// string input directly. See proof/go_verify/README.md for a finding about
// the harness's []byte limitation.
package hashing

// CRC32 computes the standard zip/zlib CRC32 (poly 0xEDB88320, initial
// 0xFFFFFFFF, final XOR 0xFFFFFFFF) of the input string's bytes.
// Implemented from scratch (not using hash/crc32) to exercise unsigned
// arithmetic + table initialization.
func CRC32(s string) uint32 {
	data := []byte(s)
	var table [256]uint32
	for i := 0; i < 256; i++ {
		c := uint32(i)
		for k := 0; k < 8; k++ {
			if c&1 == 1 {
				c = 0xEDB88320 ^ (c >> 1)
			} else {
				c = c >> 1
			}
		}
		table[i] = c
	}
	crc := uint32(0xFFFFFFFF)
	for _, b := range data {
		crc = table[(crc^uint32(b))&0xFF] ^ (crc >> 8)
	}
	return crc ^ 0xFFFFFFFF
}

// FNV1a computes the 32-bit FNV-1a hash of the input string's bytes.
// Different algorithm than CRC32 — exercises a different bit-manipulation
// pattern (multiply + XOR per byte).
func FNV1a(s string) uint32 {
	data := []byte(s)
	const offsetBasis uint32 = 2166136261
	const prime uint32 = 16777619
	h := offsetBasis
	for _, b := range data {
		h ^= uint32(b)
		h *= prime
	}
	return h
}
