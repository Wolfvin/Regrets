# stringutils.tcl — example Tcl module for the Tcl stack fixture.
#
# Pure functions that are easy to fingerprint: deterministic output for a given
# input, no side effects, no I/O.

# Slugify a string: lowercase, replace non-alphanumerics with hyphens,
# collapse consecutive hyphens, trim leading/trailing hyphens.
proc slugify {s} {
    set s [string tolower $s]
    regsub -all {[^a-z0-9]+} $s "-" s
    set s [string trim $s "-"]
    return $s
}

# Count vowels (a, e, i, o, u — case-insensitive) in a string.
proc count_vowels {s} {
    set n [regexp -all {[aeiouAEIOU]} $s]
    return $n
}

# Reverse a string.
proc reverse_str {s} {
    return [string reverse $s]
}

# Add two numbers (for multiArgs testing).
proc add {a b} {
    return [expr {$a + $b}]
}
