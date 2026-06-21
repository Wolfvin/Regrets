#!/usr/bin/env bash
# lib/slugify.sh — real bash function for proof/bash_slugify/
#
# A real-world slugify function: lowercases, replaces non-alphanumerics with
# hyphens, collapses consecutive hyphens, and trims leading/trailing hyphens.
#
# This is intentionally a real function (not a stub) so the proof demonstrates
# that capture_bash.sh + validate_bash.sh work end-to-end on a non-trivial
# bash function with multiple inputs.

# slugify <string>
# Outputs the slugified version of the input string to stdout.
slugify() {
  local input="$1"
  local out

  # Lowercase
  out="${input,,}"

  # Replace any run of non-alphanumeric characters with a single hyphen
  # Using sed for portability (pure bash regex would also work but is slower)
  out=$(printf '%s' "$out" | sed -E 's/[^a-z0-9]+/-/g')

  # Trim leading hyphens
  out="${out#-}"
  # Trim trailing hyphens
  out="${out%-}"

  printf '%s' "$out"
}

# greet <name>
# Outputs "Hello, <name>!" — a simple function for single-input proof.
greet() {
  local name="$1"
  printf 'Hello, %s!' "$name"
}
