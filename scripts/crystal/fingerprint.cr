# fingerprint.cr — shared Crystal module for Regrets fingerprint computation.
#
# Implements the SAME algorithm as scripts/fingerprint.js:
#   fingerprint(input, output) = base36(sha256(stableStringify(input) + "|" + stableStringify(output)))[0..6]
#
# Cross-stack parity is MANDATORY:
#   fingerprint("hello", "olleh") in Crystal MUST equal fingerprint("hello", "olleh") in JS  → 5nssd6s
#   fingerprint("hello", 2)        in Crystal MUST equal fingerprint("hello", 2)        in JS  → 5izc285
#   fingerprint("abc",   294)      in Crystal MUST equal fingerprint("abc",   294)      in JS  → 2i99lkw
#
# Verified manually against scripts/fingerprint.js (Node 24) — see proof/crystal_demo/demo.sh.
#
# Limitations vs JS stableStringify:
#   - No circular-reference detection (Crystal doesn't have a generic object graph
#     we can walk; we only support JSON-compatible primitives, Array, Hash).
#   - TypedArray / DataView / Map / Set / Date / Symbol / Function are NOT supported
#     (Crystal doesn't have direct equivalents; users should pre-convert to JSON types).
#   - NaN / Infinity sentinels match JS (__nan__ / __infinity__ / __neg_infinity__).

require "json"
require "digest/sha256"
require "big"

module RegretFingerprint
  # ─── stable_stringify ────────────────────────────────────────────────────
  #
  # Produces a deterministic JSON string with sorted keys (recursively).
  # Strings are JSON-encoded (with surrounding quotes); numbers/bools are bare.

  def self.stable_stringify(obj : JSON::Any?) : String
    return "null" if obj.nil?
    stable_stringify_any(obj)
  end

  def self.stable_stringify(obj) : String
    stable_stringify_any(obj)
  end

  private def self.stable_stringify_any(obj) : String
    case obj
    when Nil
      "null"
    when Bool
      obj.to_s
    when Int8, Int16, Int32, Int64, UInt8, UInt16, UInt32, UInt64
      obj.to_s
    when Float32, Float64
      if obj.responds_to?(:nan?) && obj.nan?
        "\"__nan__\""
      elsif obj.responds_to?(:infinite?) && obj.infinite?
        obj > 0 ? "\"__infinity__\"" : "\"__neg_infinity__\""
      else
        # Match JS Number.toString() — integers stay integer, floats use
        # shortest round-trip representation. Crystal's to_s on a Float64
        # like 1.5 gives "1.5"; on 1.0 gives "1.0" (which matches JS).
        obj.to_s
      end
    when String
      # JSON-encode the string (adds quotes, escapes special chars).
      # JSON.stringify("hello") in JS === obj.to_json in Crystal for strings.
      obj.to_json
    when Array
      "[" + obj.map { |v| stable_stringify_any(v) }.join(",") + "]"
    when Hash
      # Sort keys lexicographically (Crystal Hash iteration order is insertion
      # order, NOT sorted — so we MUST sort explicitly to match JS).
      keys = obj.keys.sort_by { |k| k.to_s }
      "{" + keys.map { |k|
        # Keys must be JSON-encoded strings (matches JS: JSON.stringify(k) + ":")
        k.to_s.to_json + ":" + stable_stringify_any(obj[k])
      }.join(",") + "}"
    when JSON::Any
      # Unwrap JSON::Any and recurse
      stable_stringify_any(obj.raw)
    when BigInt
      # JS serializes BigInt as "__bigint__:<n>" — match that
      "\"__bigint__:#{obj}\""
    else
      # Fall back to JSON for anything else (Time, custom classes, etc.)
      obj.to_json
    end
  end

  # ─── to_base36 ───────────────────────────────────────────────────────────
  #
  # Convert a BigInt to lowercase base36. Matches JS BigInt.toString(36)
  # and Python int.to_bytes(...) → base36 conversion.

  def self.to_base36(n : BigInt) : String
    return "0" if n == 0
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    base = BigInt.new(36)
    result = ""
    temp = n.abs
    while temp > 0
      temp, rem = temp.divmod(base)
      result = chars[rem.to_i] + result
    end
    result
  end

  # ─── fingerprint ─────────────────────────────────────────────────────────
  #
  # SHA-256 of (stableStringify(input) + "|" + stableStringify(output)),
  # interpreted as a 256-bit big-endian unsigned integer, converted to
  # base36, first 7 chars.

  def self.fingerprint(input, output) : String
    combined = stable_stringify(input) + "|" + stable_stringify(output)
    hash_hex = Digest::SHA256.hexdigest(combined)
    big = BigInt.new(hash_hex, 16)
    fp = to_base36(big)
    fp.size >= 7 ? fp[0..6] : fp
  end

  # ─── deep_clone ──────────────────────────────────────────────────────────
  #
  # Crystal values are value types (Int, Bool, etc.) — no clone needed.
  # For Array/Hash wrapped in JSON::Any, we recursively clone to prevent
  # mutation during function invocation (matches JS deepClone behavior).
  # Always returns JSON::Any to keep the type system happy.

  def self.deep_clone(obj : JSON::Any) : JSON::Any
    raw = obj.raw
    case raw
    when Array
      cloned = raw.map { |v| deep_clone(v) }
      JSON::Any.new(cloned)
    when Hash
      cloned = {} of String => JSON::Any
      raw.each { |k, v| cloned[k] = deep_clone(v) }
      JSON::Any.new(cloned)
    else
      obj
    end
  end

  def self.deep_clone(obj) : JSON::Any
    deep_clone(JSON::Any.new(obj))
  end
end
