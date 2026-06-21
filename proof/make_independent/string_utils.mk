# string_utils.mk — Independent fixture for Make stack verification
#
# This fixture is intentionally DIFFERENT from proof/make_slugify/slugify.mk
# to exercise Make patterns the PR author's fixture does not cover:
#   - `$(shell ...)` with rev, wc, printf, seq
#   - String reverse via pipeline (rev)
#   - String repeat via printf + seq loop
#   - Left-pad via printf '%*s' (POSIX width spec)
#   - Character count via wc -c
#
# Used by tests/make-stack.test.js and proof/make_independent/run-demo.sh.

# reverse: Reverse a string character-by-character.
# Args: $1 = input string
# Returns: reversed string
define reverse
$(shell printf '%s' '$1' | rev)
endef

# repeat: Repeat a string N times.
# Args: $1 = string to repeat, $2 = count
# Returns: $1 concatenated $2 times
define repeat
$(shell printf '%.0s$(1)' $$(seq 1 $(2)))
endef

# pad_left: Left-pad a string with spaces to a given width.
# Args: $1 = input string, $2 = target width
# Returns: string right-justified in a field of width $2
define pad_left
$(shell printf '%*s' '$2' '$1')
endef

# count_chars: Count the number of characters in a string (excluding newline).
# Args: $1 = input string
# Returns: integer character count
define count_chars
$(shell printf '%s' '$1' | wc -c | tr -d ' ')
endef

# upper: Convert a string to uppercase (uses tr, different from slugify.mk's to_lower).
# Args: $1 = input string
# Returns: uppercase string
define upper
$(shell printf '%s' '$1' | tr '[:lower:]' '[:upper:]')
endef
