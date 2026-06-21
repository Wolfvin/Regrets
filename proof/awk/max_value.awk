# max_value.awk — find the maximum value in the first column of input.
#
# Input: lines like "3\n1\n4\n1\n5\n9\n2\n6\n"
# Output: max value (e.g., "9")
#
# Demonstrates awk's stateful processing (BEGIN/END pattern).

{ if (NR == 1 || $1 > max) max = $1 }
END { print max }
