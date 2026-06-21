# word_count.awk — count words in input (whitespace-separated tokens).
#
# Input: text (e.g., "the quick brown fox\njumps over\n")
# Output: word count (e.g., "6")
#
# Uses awk's NF (number of fields) on the default whitespace FS.

{ count += NF }
END { print count }
