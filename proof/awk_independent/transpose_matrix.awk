# transpose_matrix.awk — transpose a tab-separated numeric matrix.
#
# Input: rows of tab-separated numbers, e.g.:
#   1\t2\t3
#   4\t5\t6
# Output: transposed matrix (rows become columns), tab-separated:
#   1\t4
#   2\t5
#   3\t6
#
# Idiom: nested loop with split() + 2D-array indexing via composite key "i,j".
# Different from existing math fixtures (sum_column, max_value) which only
# do single-pass reduction. This fixture exercises split() + nested loops
# + 2D-array emulation — a non-trivial algorithmic pattern that tests
# awk's looping and array semantics comprehensively.

{
  n = split($0, fields, "\t")
  if (n > maxCols) maxCols = n
  for (j = 1; j <= n; j++) {
    matrix[NR, j] = fields[j]
  }
  maxRows = NR
}

END {
  for (j = 1; j <= maxCols; j++) {
    out = ""
    for (i = 1; i <= maxRows; i++) {
      val = matrix[i, j]
      if (val == "") val = "0"
      if (i > 1) out = out "\t"
      out = out val
    }
    print out
  }
}
