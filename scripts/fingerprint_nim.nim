# fingerprint_nim.nim — deterministic hash for regression contracts
#
# IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_php.php /
# fingerprint_rb.rb. Same input must produce the same 7-char base36 hash.
#
# Shared module — imported by capture_nim harness and validate_nim harness.
# Do NOT duplicate these functions.
#
# Cross-stack consistency contract:
#   sha256(stableStringify(input) + "|" + stableStringify(output)) -> base36 -> first 7 chars
#
# Parity verified manually with Python (see proof/nim_slugify/PARITY.md).

import std/[json, hashes, strutils, tables, sets, options, times, sequtils, algorithm, pegs, math, typetraits]

# ─── Tuple → JsonNode overload ───────────────────────────────────────────────
# Nim's std/json defines `%` for objects, seqs, options, tables, and primitives,
# but NOT for tuples. Without this overload, any proc that returns a tuple cannot
# be captured by the harness — the `%entrySym(...)` call fails with "ambiguous
# call" because no `%` overload matches.
#
# We define `%` for tuples as a JSON object whose keys are the tuple's field
# names (named tuples) or stringified indices "0", "1", ... (anonymous tuples).
# This matches the Ruby adapter convention (tuple → Hash) and preserves
# cross-stack hash parity when the equivalent JSON object is produced.
#
# Limitation: tuple fields whose type lacks a `%` overload are stringified via
# `$val` rather than failing — this is more forgiving than std/json's behavior
# for objects, and matches what a user would expect from a snapshot tool.

proc `%`*[T: tuple](t: T): JsonNode =
  result = newJObject()
  var idx = 0
  for name, val in fieldPairs(t):
    # fieldPairs yields empty name for anonymous tuples; fall back to "0", "1", ...
    let key = if name.len > 0: name else: $idx
    when compiles(%val):
      result[key] = %val
    else:
      # Field type lacks a `%` overload — stringify rather than fail compile.
      # This keeps the harness robust to user-defined types inside tuples.
      result[key] = newJString($val)
    inc idx

# ─── SHA-256 (clean-room FIPS 180-4 implementation) ──────────────────────────
# Nim 2.2.0 stdlib does not include std/sha256, so we implement it directly.
# This is the same algorithm used by JS crypto.subtle / Python hashlib / PHP hash().
# Verified against Python hashlib.sha256 — see proof/nim_slugify/PARITY.md.

const
  Sha256K: array[64, uint32] = [
    0x428a2f98'u32, 0x71374491'u32, 0xb5c0fbcf'u32, 0xe9b5dba5'u32,
    0x3956c25b'u32, 0x59f111f1'u32, 0x923f82a4'u32, 0xab1c5ed5'u32,
    0xd807aa98'u32, 0x12835b01'u32, 0x243185be'u32, 0x550c7dc3'u32,
    0x72be5d74'u32, 0x80deb1fe'u32, 0x9bdc06a7'u32, 0xc19bf174'u32,
    0xe49b69c1'u32, 0xefbe4786'u32, 0x0fc19dc6'u32, 0x240ca1cc'u32,
    0x2de92c6f'u32, 0x4a7484aa'u32, 0x5cb0a9dc'u32, 0x76f988da'u32,
    0x983e5152'u32, 0xa831c66d'u32, 0xb00327c8'u32, 0xbf597fc7'u32,
    0xc6e00bf3'u32, 0xd5a79147'u32, 0x06ca6351'u32, 0x14292967'u32,
    0x27b70a85'u32, 0x2e1b2138'u32, 0x4d2c6dfc'u32, 0x53380d13'u32,
    0x650a7354'u32, 0x766a0abb'u32, 0x81c2c92e'u32, 0x92722c85'u32,
    0xa2bfe8a1'u32, 0xa81a664b'u32, 0xc24b8b70'u32, 0xc76c51a3'u32,
    0xd192e819'u32, 0xd6990624'u32, 0xf40e3585'u32, 0x106aa070'u32,
    0x19a4c116'u32, 0x1e376c08'u32, 0x2748774c'u32, 0x34b0bcb5'u32,
    0x391c0cb3'u32, 0x4ed8aa4a'u32, 0x5b9cca4f'u32, 0x682e6ff3'u32,
    0x748f82ee'u32, 0x78a5636f'u32, 0x84c87814'u32, 0x8cc70208'u32,
    0x90befffa'u32, 0xa4506ceb'u32, 0xbef9a3f7'u32, 0xc67178f2'u32,
  ]

template rotr(x: uint32, n: int): uint32 =
  (x shr n) or (x shl (32 - n))

proc sha256(data: string): string =
  ## Compute SHA-256 hash of input string, return as 64-char lowercase hex.
  ## Clean-room FIPS 180-4 implementation.
  let bitLen = uint64(data.len) * 8'u64

  # Initialize hash state
  var h0: array[8, uint32] = [
    0x6a09e667'u32, 0xbb67ae85'u32, 0x3c6ef372'u32, 0xa54ff53a'u32,
    0x510e527f'u32, 0x9b05688c'u32, 0x1f83d9ab'u32, 0x5be0cd19'u32,
  ]

  # Build padded message
  var msg: seq[uint8] = @[]
  for ch in data: msg.add(uint8(ch))
  msg.add(0x80'u8)
  while msg.len mod 64 != 56:
    msg.add(0'u8)
  # Append 64-bit big-endian length
  for i in countdown(7, 0):
    msg.add(uint8((bitLen shr (i * 8)) and 0xff))

  # Process each 512-bit (64-byte) block
  var w: array[64, uint32]
  var chunkStart = 0
  while chunkStart < msg.len:
    # Build first 16 words from block (big-endian)
    for i in 0 ..< 16:
      var word: uint32 = 0
      for j in 0 ..< 4:
        word = (word shl 8) or uint32(msg[chunkStart + i * 4 + j])
      w[i] = word
    # Extend to 64 words
    for i in 16 ..< 64:
      let s0 = rotr(w[i - 15], 7) xor rotr(w[i - 15], 18) xor (w[i - 15] shr 3)
      let s1 = rotr(w[i - 2], 17) xor rotr(w[i - 2], 19) xor (w[i - 2] shr 10)
      w[i] = w[i - 16] + s0 + w[i - 7] + s1  # uint32 wraps automatically

    # Initialize working variables
    var a = h0[0]; var b = h0[1]; var c = h0[2]; var d = h0[3]
    var e = h0[4]; var f = h0[5]; var g = h0[6]; var hh = h0[7]

    for i in 0 ..< 64:
      let s1 = rotr(e, 6) xor rotr(e, 11) xor rotr(e, 25)
      let ch = (e and f) xor ((not e) and g)
      let temp1 = hh + s1 + ch + Sha256K[i] + w[i]
      let s0 = rotr(a, 2) xor rotr(a, 13) xor rotr(a, 22)
      let maj = (a and b) xor (a and c) xor (b and c)
      let temp2 = s0 + maj
      hh = g; g = f; f = e; e = d + temp1
      d = c; c = b; b = a; a = temp1 + temp2

    h0[0] = h0[0] + a; h0[1] = h0[1] + b; h0[2] = h0[2] + c; h0[3] = h0[3] + d
    h0[4] = h0[4] + e; h0[5] = h0[5] + f; h0[6] = h0[6] + g; h0[7] = h0[7] + hh

    chunkStart += 64

  # Produce hex string (big-endian per word)
  result = ""
  for h in h0:
    for i in countdown(3, 0):
      let b = uint8((h shr (i * 8)) and 0xff)
      result.add(b.toHex(2).toLowerAscii())

# ─── Stable JSON serialization ────────────────────────────────────────────────
# Mirrors JS stableStringify / Python stable_dumps / Ruby stable_dumps.
# Keys sorted recursively. Compact separators (no spaces). UTF-8 preserved.

proc stableSort(node: JsonNode): JsonNode =
  case node.kind
  of JObject:
    # Sort keys alphabetically (string comparison), recurse values.
    let keys = toSeq(node.keys).sorted()
    result = newJObject()
    for k in keys:
      result[k] = stableSort(node[k])
  of JArray:
    result = newJArray()
    for v in node:
      result.add(stableSort(v))
  else:
    result = node

proc stableDumps*(node: JsonNode): string =
  ## Deterministic JSON serialization: sorted keys, compact separators,
  ## UTF-8 preserved. Matches JS stableStringify / Python stable_dumps.
  if node.isNil:
    return "null"
  let sortedNode = stableSort(node)
  # compact separator: "," and ":" — matches json.dumps(separators=(',', ':'))
  result = $sortedNode

# ─── Normalize non-deterministic values before hashing ────────────────────────
# Implements the same rule set as fingerprint.js / fingerprint.py / fingerprint_rb.rb.
# Unknown rules are silently ignored (forward-compat with new rules added to other stacks).

proc normalizeString(s: string, rules: seq[string]): string =
  result = s
  if "timestamps" in rules and result.match(peg"^\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+$"):
    return "<TIMESTAMP>"
  if "uuids" in rules and result.match(peg"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"):
    return "<UUID>"
  if "isoDates" in rules:
    result = result.replace(peg"\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+\-]\d{2}:\d{2})?)?", "<ISO_DATE>")
  return result

proc normalizeNode(node: JsonNode, rules: seq[string]): JsonNode =
  if rules.len == 0:
    return node

  case node.kind
  of JString:
    let s = node.getStr()
    let normalized = normalizeString(s, rules)
    if normalized != s:
      return newJString(normalized)
    return node
  of JInt:
    if "epochs" in rules:
      let n = node.getInt()
      if n > 1_000_000_000 and n < 9_999_999_999_999:
        return newJString("<EPOCH>")
    return node
  of JFloat:
    let f = node.getFloat()
    if "floatPrecision" in rules:
      if f == f.floor:
        return newJInt(BiggestInt(f))
      # round to 2 decimals
      return newJFloat(round(f * 100.0) / 100.0)
    return node
  of JArray:
    result = newJArray()
    for v in node:
      result.add(normalizeNode(v, rules))
  of JObject:
    # tokenOffsets: replace known offset keys with <OFFSET>
    if "tokenOffsets" in rules:
      let offsetKeys = ["start", "end", "span_start", "span_end",
                        "full_span_start", "full_span_end",
                        "pin_cite_span_start", "pin_cite_span_end"].toSet()
      result = newJObject()
      for k, v in node.pairs:
        if k in offsetKeys and v.kind == JInt:
          result[k] = newJString("<OFFSET>")
        else:
          result[k] = normalizeNode(v, rules)
      return result
    # default: recurse values
    result = newJObject()
    for k, v in node.pairs:
      result[k] = normalizeNode(v, rules)
  else:
    return node

proc normalize*(node: JsonNode, rules: seq[string] = @[]): JsonNode =
  ## Apply normalization rules. Returns a new JsonNode; input is not modified.
  result = normalizeNode(node, rules)

# ─── Strip ignored fields from output before hashing ──────────────────────────

proc stripFields*(node: JsonNode, fields: seq[string] = @[]): JsonNode =
  ## Remove ignored fields from objects (recursively). Returns a new JsonNode.
  if fields.len == 0:
    return node

  case node.kind
  of JArray:
    result = newJArray()
    for v in node:
      result.add(stripFields(v, fields))
  of JObject:
    result = newJObject()
    for k, v in node.pairs:
      if k notin fields:
        result[k] = stripFields(v, fields)
  else:
    result = node

# ─── Base36 conversion ────────────────────────────────────────────────────────
# Mirrors JS BigInt.toString(36) / Python to_base36 / Ruby to_base36.
# Input: hex string (from SHA256). Output: lowercase base36 string.

proc toBase36*(hexStr: string): string =
  ## Convert a hex string to a lowercase base36 string.
  ## Mirrors JS BigInt.toString(36), Python to_base36, Ruby to_base36.
  let hex = hexStr.strip(chars = {'0'}).toLowerAscii()
  if hex.len == 0:
    return "0"

  # Convert hex string to a sequence of BigInt-like operations.
  # We use a simple arbitrary-precision integer represented as a seq of uint32.
  # Each digit holds 9 decimal places (max ~1e9 per slot).
  var digits: seq[uint32] = @[0'u32]

  let hexChars = hex
  for c in hexChars:
    let v = case c
            of '0'..'9': uint32(ord(c) - ord('0'))
            of 'a'..'f': uint32(ord(c) - ord('a') + 10)
            else: 0'u32

    # multiply digits by 16
    var carry: uint64 = 0
    for i in 0 ..< digits.len:
      let prod = uint64(digits[i]) * 16'u64 + carry
      digits[i] = uint32(prod mod 1_000_000_000'u64)
      carry = prod div 1_000_000_000'u64
    while carry > 0:
      digits.add(uint32(carry mod 1_000_000_000'u64))
      carry = carry div 1_000_000_000'u64

    # add v
    var addCarry: uint64 = v
    for i in 0 ..< digits.len:
      let sum = uint64(digits[i]) + addCarry
      digits[i] = uint32(sum mod 1_000_000_000'u64)
      addCarry = sum div 1_000_000_000'u64
      if addCarry == 0:
        break
    while addCarry > 0:
      digits.add(uint32(addCarry mod 1_000_000_000'u64))
      addCarry = addCarry div 1_000_000_000'u64

  # Convert base-1e9 digits to base36 string
  let chars36 = "0123456789abcdefghijklmnopqrstuvwxyz"
  var resultChars: seq[char] = @[]

  while digits.len > 1 or digits[0] > 0:
    var rem: uint64 = 0
    for i in countdown(digits.len - 1, 0):
      let cur = rem * 1_000_000_000'u64 + uint64(digits[i])
      digits[i] = uint32(cur div 36'u64)
      rem = cur mod 36'u64
    resultChars.add(chars36[int(rem)])

    # Strip leading zeros (most significant slots)
    while digits.len > 1 and digits[digits.len - 1] == 0:
      digits = digits[0 ..< digits.len - 1]

  if resultChars.len == 0:
    return "0"
  return resultChars.reversed.join()

# ─── Deep clone via JSON round-trip ───────────────────────────────────────────

proc deepClone*(node: JsonNode): JsonNode =
  ## Deep clone a JsonNode. Nim's std/json doesn't alias on read,
  ## but we explicitly deep-copy for parity with other stacks.
  if node.isNil:
    return nil
  case node.kind
  of JNull: result = newJNull()
  of JBool: result = newJBool(node.getBool())
  of JInt: result = newJInt(node.getInt())
  of JFloat: result = newJFloat(node.getFloat())
  of JString: result = newJString(node.getStr())
  of JArray:
    result = newJArray()
    for v in node:
      result.add(deepClone(v))
  of JObject:
    result = newJObject()
    for k, v in node.pairs:
      result[k] = deepClone(v)

# ─── Core fingerprint function ────────────────────────────────────────────────

proc fingerprint*(inputData, outputData: JsonNode,
                  rules: seq[string] = @[],
                  ignoreFields: seq[string] = @[]): string =
  ## Compute the 7-char base36 fingerprint for an input/output pair.
  ## IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_rb.rb.
  let cleanInput = stripFields(normalize(deepClone(inputData), rules), ignoreFields)
  let cleanOutput = stripFields(normalize(deepClone(outputData), rules), ignoreFields)
  let combined = stableDumps(cleanInput) & "|" & stableDumps(cleanOutput)
  let hashHex = sha256(combined)
  let b36 = toBase36(hashHex)
  if b36.len >= 7:
    return b36[0 ..< 7]
  return b36

# ─── Extract structural schema ────────────────────────────────────────────────
# Mirrors JS extractSchema / Python extract_schema / Ruby extract_schema.
# Used for fingerprintMode: "schema" — fingerprints the shape, not the values.

proc extractSchema*(node: JsonNode): JsonNode =
  if node.isNil:
    return newJString("null")

  case node.kind
  of JNull: result = newJString("null")
  of JBool: result = newJString("boolean")
  of JInt, JFloat: result = newJString("number")
  of JString: result = newJString("string")
  of JArray:
    if node.len == 0:
      result = newJString("array")
    else:
      let sampleSize = min(node.len, 5)
      var schemas: seq[JsonNode] = @[]
      var seen: HashSet[string] = initHashSet[string]()
      for i in 0 ..< sampleSize:
        let s = extractSchema(node[i])
        let key = stableDumps(s)
        if key notin seen:
          seen.incl(key)
          schemas.add(s)
      if schemas.len == 1:
        result = newJArray()
        result.add(schemas[0])
      else:
        result = newJArray()
        for s in schemas:
          result.add(s)
  of JObject:
    result = newJObject()
    let keys = toSeq(node.keys).sorted()
    for k in keys:
      result[k] = extractSchema(node[k])
