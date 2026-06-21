# frozen_string_literal: true
# proof/ruby_slugify/lib/slugify.rb
# A small, realistic URL-slug generator. Pure function — no I/O, no globals,
# no random. Ideal regret cluster: behavior is fully determined by the input
# string, so the captured fingerprint is stable across runs.
#
# Two top-level functions are exported:
#   slugify(text)        — single-string slug
#   slugify_batch(texts) — array of strings → array of slugs
#
# This file is intentionally written in a "naive" first-pass style —
# readable, but with a couple of inlined regexes that can be extracted
# during a refactor without changing behavior. The .regret files in
# proof/ruby_slugify/ are the golden contracts; any refactor that
# changes the output for the captured inputs will fail validate.

SLUGIFY_HYPHEN = '-'.freeze

# Convert a string to a URL-safe slug.
#
# Algorithm:
#   1. Downcase the input.
#   2. Replace every run of non-[a-z0-9] characters with a single hyphen.
#   3. Strip leading and trailing hyphens.
#
# Edge cases:
#   - Empty input → empty string.
#   - Input with no alphanumeric chars (e.g. "!!!") → empty string.
#   - Unicode chars (é, 漢, emoji) are treated as non-alphanumeric and
#     collapsed into hyphens, then stripped if at the boundary.
def slugify(text)
  s = text.to_s.downcase
  s = s.gsub(/[^a-z0-9]+/, SLUGIFY_HYPHEN)
  s = s.gsub(/\A-+|-+\z/, '')
  s
end

# Apply `slugify` to every string in an array, preserving order and length.
# Returns a new array; the input array is not mutated.
def slugify_batch(texts)
  texts.map { |t| slugify(t) }
end
