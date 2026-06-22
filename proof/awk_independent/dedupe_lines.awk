# dedupe_lines.awk — remove duplicate lines, preserve first-occurrence order.
#
# Input: any text lines.
# Output: input with duplicate lines removed, in original first-occurrence order.
#
# Idiom: associative array `seen[]` for dedup + array `order[]` for sequence.
# Different from existing fixtures which don't use associative arrays at all.
# This fixture exercises the most idiomatic awk pattern (hash-table dedup)
# which is core to awk's reason for existing.

{
  line = $0
  if (!(line in seen)) {
    seen[line] = 1
    order[NR] = line
  }
}

END {
  for (i = 1; i <= NR; i++) {
    if (i in order) {
      print order[i]
    }
  }
}
