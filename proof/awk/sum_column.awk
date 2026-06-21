# sum_column.awk — sum the first column of input lines.
#
# Input: lines like "1\n2\n3\n4\n5\n"
# Output: sum (e.g., "15")
#
# Pure function: no time, no randomness, no I/O beyond stdin/stdout.

{ sum += $1 }
END { print sum }
