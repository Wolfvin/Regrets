# text_format.mk — Task 7 independent fixture for Make stack verification
#
# This fixture is intentionally DIFFERENT from:
#   - proof/make_slugify/slugify.mk  (slugify, greet, join_with, to_lower, is_numeric)
#   - proof/make_independent/string_utils.mk (reverse, repeat, pad_left, count_chars, upper)
#
# Patterns newly exercised here (NOT covered by either prior fixture):
#   - `cut` for character slicing (truncate)
#   - `tr -d` for character-class deletion (sanitize)
#   - `fold` for line wrapping (wrap)
#   - `wc -w` for word counting (count_words)
#   - `awk` for per-word capitalization (title_case)

# truncate: Truncate a string to N characters and append ellipsis if shortened.
# Args: $1 = input string, $2 = max length (digits only, no ellipsis counted)
# Returns: first $2 chars of $1, with "..." appended if string was longer than $2
define truncate
$(shell printf '%s' '$1' | cut -c1-$(2))$(if $(shell [ $$(printf '%s' '$1' | wc -c) -gt $(2) ] && echo yes),...)
endef

# sanitize: Remove all non-printable/non-ASCII chars from a string.
# Args: $1 = input string
# Returns: input with control chars and non-ASCII bytes deleted
define sanitize
$(shell printf '%s' '$1' | tr -d '[:cntrl:]' | tr -cd '[:print:]')
endef

# wrap: Wrap a string at the specified width using fold.
# Args: $1 = input string, $2 = max line width
# Returns: string with newlines inserted every $2 chars
define wrap
$(shell printf '%s' '$1' | fold -w $(2))
endef

# count_words: Count the number of whitespace-separated words in a string.
# Args: $1 = input string
# Returns: integer count of words
define count_words
$(shell printf '%s' '$1' | wc -w)
endef

# title_case: Capitalize the first letter of each whitespace-separated word.
# Args: $1 = input string
# Returns: input with each word's first letter uppercased, rest lowercased
define title_case
$(shell printf '%s' '$1' | awk '{for(i=1;i<=NF;i++) printf "%s%s%s", toupper(substr($$i,1,1)), tolower(substr($$i,2)), (i==NF?"\n":" ")}')
endef
