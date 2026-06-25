// StringUtils.swift — example Swift module for the Swift stack fixture.
//
// Pure functions that are easy to fingerprint: deterministic output for a given
// input, no side effects, no I/O.
//
// The capture/validate runner generates a Main.swift that calls these functions
// and prints results as JSON.

import Foundation

/// Slugify a string: lowercase, replace non-alphanumerics with hyphens,
/// collapse consecutive hyphens, trim leading/trailing hyphens.
func slugify(_ s: String) -> String {
    let lowered = s.lowercased()
    let converted = lowered.map { c -> Character in
        c.isLetter || c.isNumber ? c : "-"
    }
    var result = String(converted)
    // Collapse consecutive hyphens
    while result.contains("--") {
        result = result.replacingOccurrences(of: "--", with: "-")
    }
    // Trim leading/trailing hyphens
    result = result.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return result
}

/// Count vowels (a, e, i, o, u — case-insensitive) in a string.
func countVowels(_ s: String) -> Int {
    return s.lowercased().filter { "aeiou".contains($0) }.count
}

/// Reverse a string.
func reverseStr(_ s: String) -> String {
    return String(s.reversed())
}

/// Add two numbers (for multiArgs testing).
func add(_ a: Int, _ b: Int) -> Int {
    return a + b
}
