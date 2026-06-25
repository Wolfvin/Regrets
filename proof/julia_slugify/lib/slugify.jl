# proof/julia_slugify/lib/slugify.jl
#
# A small, realistic URL-slug generator. Pure functions — no I/O, no globals,
# no random. Ideal regret cluster: behavior is fully determined by the input
# string, so the captured fingerprint is stable across runs.
#
# Two top-level functions are exported:
#   slugify(text::String)::String
#   slugify_batch(texts::Vector{String})::Vector{String}
#
# This file is intentionally written in a "naive" first-pass style —
# readable, but with a couple of inlined character loops that can be extracted
# during a refactor without changing behavior. The .regret files in
# proof/julia_slugify/regrets/ are the golden contracts; any refactor that
# changes the output for the captured inputs will fail validate.
#
# Mirrors proof/nim_slugify/lib/slugify.nim so cross-stack fingerprint parity
# can be verified (both produce "hello-world" for "Hello, World!").

const SLUGIFY_HYPHEN = '-'

is_alphanum(c::Char) = ('a' <= c <= 'z') || ('0' <= c <= '9')

"""
    slugify(text::String)::String

Convert a string to a URL-safe slug.

Algorithm:
  1. Downcase the input.
  2. Replace every run of non-[a-z0-9] characters with a single hyphen.
  3. Strip leading and trailing hyphens.

Edge cases:
  - Empty input -> empty string.
  - Input with no alphanumeric chars (e.g. "!!!") -> empty string.
  - Unicode chars (é, 漢, emoji) are treated as non-alphanumeric and
    collapsed into hyphens, then stripped if at the boundary.
"""
function slugify(text::String)::String
    lowered = lowercase(text)
    out_chars = Char[]
    prev_hyphen = true  # treat start as if we just saw a hyphen (so we strip leading)
    for c in lowered
        if is_alphanum(c)
            push!(out_chars, c)
            prev_hyphen = false
        else
            if !prev_hyphen
                push!(out_chars, SLUGIFY_HYPHEN)
                prev_hyphen = true
            end
        end
    end
    # Strip trailing hyphen (if any)
    if !isempty(out_chars) && out_chars[end] == SLUGIFY_HYPHEN
        pop!(out_chars)
    end
    return String(out_chars)
end

"""
    slugify_batch(texts::Vector{String})::Vector{String}

Apply `slugify` to every string in a vector, preserving order and length.
Returns a new vector; the input vector is not mutated.
"""
function slugify_batch(texts::Vector{String})::Vector{String}
    return [slugify(t) for t in texts]
end
