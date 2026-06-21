# reverse_lines.awk — reverse the order of input lines, also reverse each line.
#
# Input: lines like "Hello\nWorld\n"
# Output: "dlroW\nolleH" (line 2 reversed, then line 1 reversed, joined by \n)
#
# Demonstrates awk's array manipulation and string reversal.

{
  lines[NR] = $0
  n = NR
}

END {
  for (i = n; i >= 1; i--) {
    line = lines[i]
    out = ""
    len = length(line)
    for (j = len; j >= 1; j--) {
      out = out substr(line, j, 1)
    }
    if (i < n) printf "\n"
    printf "%s", out
  }
  printf "\n"
}
