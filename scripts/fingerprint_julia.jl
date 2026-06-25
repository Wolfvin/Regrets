#!/usr/bin/env julia
# fingerprint_julia.jl — deterministic hash for regression contracts
#
# IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_nim.nim /
# fingerprint_perl.pl / fingerprint_rb.rb / fingerprint_lua.lua / fingerprint_php.php.
# Same input+output pair MUST produce the same 7-char hash across all stacks.
#
# Algorithm:
#   stableStringify(input) * "|" * stableStringify(output)
#   → sha256 (hex)
#   → BigInt
#   → base36
#   → first 7 chars
#
# Uses only Julia stdlib modules (no Pkg.add needed):
#   SHA — for sha256 (in stdlib since Julia 1.0)
#   JSON — for JSON serialization (in stdlib since Julia 1.7)
#   Dates — for ISO-8601 timestamps (in stdlib since Julia 1.0)
#   Printf — for hex formatting (in stdlib since Julia 1.0)
#
# This is a shared module — `include`d by capture and validate harnesses.
# Import its functions via:
#   include("fingerprint_julia.jl")
#   using .RegretsFingerprint: stableStringify, fingerprint, toBase36

module RegretsFingerprint

using SHA
using JSON
using Dates
using Printf

export stableStringify, fingerprint, toBase36, normalize, stripFields, deepClone

# ─── stableStringify ─────────────────────────────────────────────────────────
# Mirrors JS `stableStringify` (scripts/fingerprint.js) and Python `stable_dumps`:
#   - Keys sorted recursively
#   - Deterministic output regardless of dict insertion order
#   - Compact separators ("," and ":")
#   - Sentinels for non-finite numbers (NaN, Inf, -Inf) to match JS behavior
#     (issue #322 — JSON.stringify would emit "null" for all of them,
#      causing hash collisions)
#
# Julia-specific notes:
#   - `JSON.json(obj)` produces compact JSON but doesn't sort keys.
#     We sort manually by converting Dict → sorted vector of pairs → re-build.
#   - `nothing` → `null` (matches JS undefined/null → "null" sentinel behavior)
#   - `missing` → `null` (same)
#   - `NaN` → `"__nan__"` (sentinel, NOT "null" — issue #322)
#   - `Inf` → `"__infinity__"` (sentinel)
#   - `-Inf` → `"__neg_infinity__"` (sentinel)

function stableStringify(obj)::String
    return _stable_stringify_internal(obj, Set{UInt}())
end

function _stable_stringify_internal(obj, seen::Set{UInt})::String
    # nothing / missing → "null"
    if obj === nothing || obj === missing
        return "null"
    end

    # Handle numbers — sentinels for non-finite (issue #322)
    if obj isa AbstractFloat
        if isnan(obj)
            return "\"__nan__\""
        elseif isinf(obj)
            return obj > 0 ? "\"__infinity__\"" : "\"__neg_infinity__\""
        end
        # Finite float — JSON.json handles correctly.
        # JS JSON.stringify(2.0) → "2"; JSON.json(2.5) → "2.5".
        # Julia JSON.json(2.0) → "2.0"; JSON.json(2.5) → "2.5".
        # To match JS exactly: strip trailing ".0" from whole-number floats.
        if obj == floor(obj) && abs(obj) < 1e16
            return string(Int64(obj))
        end
        return JSON.json(obj)
    end

    # Integers — JSON.json handles correctly (no quotes)
    if obj isa Integer
        return string(obj)
    end

    # Booleans — JSON.json handles correctly
    if obj isa Bool
        return obj ? "true" : "false"
    end

    # Strings — JSON.json handles quoting + escaping
    if obj isa AbstractString
        return JSON.json(String(obj))
    end

    # Arrays
    if obj isa AbstractArray
        oid = objectid(obj)
        if oid in seen
            return "\"__circular__\""
        end
        push!(seen, oid)
        parts = [_stable_stringify_internal(x, seen) for x in obj]
        pop!(seen, oid)
        return "[" * join(parts, ",") * "]"
    end

    # Tuples — treated as JSON arrays (positional, matches Nim adapter convention
    # for anonymous tuples).
    if obj isa Tuple
        parts = [_stable_stringify_internal(x, seen) for x in obj]
        return "[" * join(parts, ",") * "]"
    end

    # NamedTuples — treated as JSON objects with field names as keys.
    if obj isa NamedTuple
        oid = objectid(obj)
        if oid in seen
            return "\"__circular__\""
        end
        push!(seen, oid)
        keys_sorted = sort(String.(fieldnames(typeof(obj))))
        parts = String[]
        for k in keys_sorted
            v = getfield(obj, Symbol(k))
            push!(parts, JSON.json(k) * ":" * _stable_stringify_internal(v, seen))
        end
        pop!(seen, oid)
        return "{" * join(parts, ",") * "}"
    end

    # Dicts — sort keys alphabetically, recurse values
    if obj isa AbstractDict
        oid = objectid(obj)
        if oid in seen
            return "\"__circular__\""
        end
        push!(seen, oid)
        # Sort keys by their string representation (JSON-encoded form for
        # consistency with JS Object.keys + sort behavior).
        keys_strings = [(JSON.json(String(k)), k) for k in keys(obj)]
        sort!(keys_strings, by = first)
        parts = String[]
        for (ks, k) in keys_strings
            v = obj[k]
            push!(parts, ks * ":" * _stable_stringify_internal(v, seen))
        end
        pop!(seen, oid)
        return "{" * join(parts, ",") * "}"
    end

    # Dates — ISO-8601 (matches JS Date.prototype.toJSON)
    if obj isa Dates.TimeType
        return JSON.json(Dates.format(obj, dateformat"yyyy-mm-ddTHH:MM:SS.sssZ"))
    end

    # Fallback: stringify via JSON.json (handles structs, custom types)
    try
        return JSON.json(obj)
    catch
        return "\"__unserializable__\""
    end
end

# ─── toBase36 ────────────────────────────────────────────────────────────────
# Convert a hex string to a lowercase base36 string.
# Mirrors JS BigInt.toString(36), Python to_base36, Ruby to_base36,
# Nim toBase36, Perl to_base36.
#
# IMPORTANT: strip ONLY leading zeros, not trailing zeros.
# Trailing zeros in a SHA-256 hex hash are significant — stripping them
# changes the BigInt value and produces a different base36 result.
# (Bug found in fingerprint_nim.nim by third-party verifier — see
# proof/nim_third_verify/README.md Finding #1. We avoid the same trap here.)
function toBase36(hexStr::String)::String
    # Strip leading zeros only.
    s = lowercase(hexStr)
    s = replace(s, r"^0+" => "")
    if isempty(s)
        return "0"
    end

    # Convert hex string to BigInt via parse.
    n = parse(BigInt, s, base = 16)

    # Julia 1.11: `Base.string(n, base=36)` produces lowercase base36.
    # (In older Julia this was `Base.base(36, n)` — but `base` was deprecated
    # and removed in 1.11; `string(n; base=N)` is the modern API.)
    return Base.string(n; base = 36)
end

# ─── normalize ───────────────────────────────────────────────────────────────
# Apply normalization rules before hashing (timestamps, uuids, etc.)
# Mirrors fingerprint.js normalize() — same rule names, same behavior.
# Unknown rules are silently ignored (forward-compat).

function normalize(obj, rules::Vector{String})
    if isempty(rules)
        return obj
    end

    if obj isa AbstractString
        s = String(obj)
        if "timestamps" in rules && occursin(r"^\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+$", s)
            return "<TIMESTAMP>"
        end
        if "uuids" in rules && occursin(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"i, s)
            return "<UUID>"
        end
        if "isoDates" in rules
            return replace(s, r"\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+\-]\d{2}:\d{2})?)?" => "<ISO_DATE>")
        end
        return s
    end

    if obj isa AbstractArray
        return [normalize(x, rules) for x in obj]
    end

    if obj isa AbstractDict
        return Dict(k => normalize(v, rules) for (k, v) in obj)
    end

    if obj isa NamedTuple
        return NamedTuple{(fieldnames(typeof(obj)),)}(normalize(getfield(obj, f), rules) for f in fieldnames(typeof(obj)))
    end

    return obj
end

# ─── stripFields ─────────────────────────────────────────────────────────────
# Strip ignored fields from output before hashing (matches fingerprint.js stripFields).

function stripFields(obj, ignoreFields::Vector{String})
    if isempty(ignoreFields)
        return obj
    end

    if obj isa AbstractDict
        return Dict(k => stripFields(v, ignoreFields) for (k, v) in obj
                    if !(String(k) in ignoreFields))
    end

    if obj isa NamedTuple
        kept = [(f => stripFields(getfield(obj, f), ignoreFields))
                for f in fieldnames(typeof(obj))
                if !(String(f) in ignoreFields)]
        return NamedTuple{map(x -> x[1], kept)}(map(x -> x[2], kept))
    end

    if obj isa AbstractArray
        return [stripFields(x, ignoreFields) for x in obj]
    end

    return obj
end

# ─── deepClone ───────────────────────────────────────────────────────────────
# Deep clone via JSON round-trip (matches fingerprint.js deepClone behavior).
# Used to avoid mutation of input/output during normalize/stripFields passes.
#
# NaN/Inf cannot be JSON-serialized by JSON.json (it throws by default —
# spec-compliant). We work around by replacing them with sentinel strings
# BEFORE the round-trip (mirroring the __nan__ / __infinity__ sentinels
# that stableStringify emits anyway). The clone is structurally identical
# to the original for hashing purposes.

function _replaceNonFinite(x)
    if x isa AbstractFloat
        if isnan(x)
            return "__nan__"
        elseif isinf(x)
            return x > 0 ? "__infinity__" : "__neg_infinity__"
        end
        return x
    elseif x isa AbstractArray
        return [_replaceNonFinite(v) for v in x]
    elseif x isa AbstractDict
        return Dict(k => _replaceNonFinite(v) for (k, v) in x)
    elseif x isa NamedTuple
        return NamedTuple{(fieldnames(typeof(x)),)}(_replaceNonFinite(getfield(x, f)) for f in fieldnames(typeof(x)))
    elseif x isa Tuple
        return Tuple(_replaceNonFinite(v) for v in x)
    end
    return x
end

function deepClone(obj)
    return _replaceNonFinite(obj)
end

# ─── fingerprint ─────────────────────────────────────────────────────────────
# Core: produces the 7-char base36 fingerprint for an input/output pair.

function fingerprint(inputData, outputData;
                     normalizeRules::Vector{String} = String[],
                     ignoreFields::Vector{String} = String[])::String
    cleanInput = stripFields(normalize(deepClone(inputData), normalizeRules), ignoreFields)
    cleanOutput = stripFields(normalize(deepClone(outputData), normalizeRules), ignoreFields)
    combined = stableStringify(cleanInput) * "|" * stableStringify(cleanOutput)
    hashHex = bytes2hex(sha256(combined))
    b36 = toBase36(hashHex)
    # Take first 7 chars (matches JS slice(0, 7)).
    return length(b36) >= 7 ? b36[1:7] : b36
end

end # module
