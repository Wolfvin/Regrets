#!/usr/bin/env bash
# lib/slugify.sh — real bash function for proof/bash_slugify/
#
# Converts a string to URL-safe slug:
#   - lowercase
#   - spaces → hyphens
#   - strip non-alphanumeric (except hyphens)
#   - collapse consecutive hyphens
#   - trim leading/trailing hyphens
#
# Usage:
#   source lib/slugify.sh
#   slugify "Hello World!"   # → "hello-world"

slugify() {
  local input="$1"
  local result

  # Lowercase
  result="${input,,}"

  # Replace spaces with hyphens
  result="${result// /-}"

  # Remove non-alphanumeric (keep hyphens)
  result="${result//[^a-zA-Z0-9-]/}"

  # Collapse consecutive hyphens
  while [[ "$result" == *--* ]]; do
    result="${result//--/-}"
  done

  # Trim leading hyphens
  while [[ "$result" == -* ]]; do
    result="${result#-}"
  done

  # Trim trailing hyphens
  while [[ "$result" == *- ]]; do
    result="${result%-}"
  done

  printf '%s' "$result"
}

# Multi-arg variant: slugify each arg, join with hyphens
# Usage: slugify_join "Hello" "World" → "hello-world"
slugify_join() {
  local parts=()
  local arg
  for arg in "$@"; do
    parts+=("$(slugify "$arg")")
  done
  local IFS=-
  printf '%s' "${parts[*]}"
}
