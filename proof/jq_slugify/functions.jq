# functions.jq — Example jq functions for Regrets regression testing
#
# These are jq `def` functions that can be called via `jq 'include "functions"; funcname'`.
# Each function takes input via `.` (the piped JSON value) or via explicit arguments.

# greet: Return a greeting message.
# Input: . = name (string)
# Returns: "Hello, <name>!"
def greet:
  "Hello, " + . + "!";

# slugify: Convert a string to a URL-friendly slug.
# Input: . = input string
# Returns: lowercase string with spaces replaced by hyphens, non-alphanumeric chars removed
def slugify:
  ascii_downcase | gsub("[^a-z0-9 ]"; "") | gsub(" "; "-");

# to_lower: Convert a string to lowercase.
# Input: . = input string
# Returns: lowercase string
def to_lower:
  ascii_downcase;

# addtwice: Add the first argument to itself, then add the second argument.
# Args: a (number), b (number)
# Returns: a + a + b
def addtwice(a; b):
  a + a + b;

# is_numeric: Check if a value is a number.
# Input: . = any JSON value
# Returns: true if . is a number, false otherwise
def is_numeric:
  type == "number";

# count_vowels: Count the number of vowels (a, e, i, o, u) in a string.
# Input: . = input string
# Returns: integer count of vowels
def count_vowels:
  ascii_downcase | [scan("[aeiou]")] | length;
