# indent_prefix.awk — prefix each line with N spaces (parameter via -v indent=N).
#
# Invocation: awk -v indent=4 -f indent_prefix.awk
# Input: any text lines.
# Output: each line prefixed with `indent` spaces (default 2 if not set).
#
# Idiom: reads `-v` variable, uses sprintf() to build the prefix string.
# Different from existing fixtures which never use -v variables. This
# fixture exercises the `-v` parameter path through capture_awk.mjs's
# `cluster.args` mechanism — verifying that extra args are passed through
# correctly (an issue found in some other stacks historically).

BEGIN {
  if (indent == "") indent = 2
  prefix = sprintf("%*s", indent, "")
}

{
  print prefix $0
}
