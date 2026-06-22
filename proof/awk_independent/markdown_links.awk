# markdown_links.awk — extract Markdown links `[text](url)` from each line.
#
# Input: lines of Markdown text, e.g.:
#   See [the docs](https://example.com/docs) and [source](src/index.js).
# Output: for each link found on the line, emit `text -> url` on its own line.
#   If no links on the line, emit nothing.
#
# Idiom: gsub + match with capture-group extraction via RSTART/RLENGTH.
# Different from csv_field_count.awk (which uses split() + simple counting)
# and reverse_lines.awk (which uses string-reverse). This fixture exercises
# awk's match() + substr() pattern with iteration over multiple matches
# per line — a pattern not covered by any existing fixture.

{
  line = $0
  out = ""
  while (match(line, /\[[^][]+\]\([^()]+\)/)) {
    # Extract the full match `[text](url)`
    full = substr(line, RSTART, RLENGTH)
    line = substr(line, RSTART + RLENGTH)
    # Manual parse (mawk-compatible — no gawk array-capture extension needed).
    # Strip leading `[` and trailing `)` to get inner `text](url`.
    inner = substr(full, 2, length(full) - 2)
    paren = index(inner, "](")
    text = substr(inner, 1, paren - 1)
    url  = substr(inner, paren + 2)
    if (out != "") out = out "\n"
    out = out text " -> " url
  }
  if (out != "") print out
}
