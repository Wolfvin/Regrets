# slugify.mk — Example Make functions for Regrets regression testing
#
# These are GNU Make `define` functions that can be called via `$(call ...)`.
# Each function takes arguments and returns a string result.

# space helper
space := $(empty) $(empty)

# slugify: Convert a string to a URL-friendly slug.
# Args: $1 = input string
# Returns: lowercase string with spaces replaced by hyphens, non-alphanumeric chars removed
define slugify
$(shell printf '%s' '$1' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 ]//g' | tr ' ' '-')
endef

# greet: Return a greeting message.
# Args: $1 = name
# Returns: "Hello, <name>!"
define greet
Hello, $1!
endef

# join_with: Join a space-separated list with a separator.
# Args: $1 = separator, $2 = space-separated words
# Returns: words joined by separator
define join_with
$(strip $(subst $(space),$1,$(strip $2)))
endef

# to_lower: Convert a string to lowercase.
# Args: $1 = input string
# Returns: lowercase string
define to_lower
$(shell printf '%s' '$1' | tr '[:upper:]' '[:lower:]')
endef

# is_numeric: Check if a string is a valid integer 0-100.
# Args: $1 = input string
# Returns: "true" or "false"
define is_numeric
$(if $(filter $1,0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95 96 97 98 99 100),true,false)
endef
