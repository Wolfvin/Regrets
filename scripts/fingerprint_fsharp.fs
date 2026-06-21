// fingerprint_fsharp.fs — deterministic hash for regression contracts
//
// IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_dart.dart /
// fingerprint_perl.pl / fingerprint_php.php. Same input+output pair MUST produce
// the same 7-char base36 hash across all stacks.
//
// Algorithm:
//   combined = stableStringify(input) + "|" + stableStringify(output)
//   hashHex  = sha256(combined)
//   bigNum   = BigInteger.Parse(hashHex, 16)
//   return   toBase36(bigNum).[0..6]
//
// Shared module — required by capture_fsharp.fs and validate_fsharp.fs.
// Cross-stack consistency verified against Python fingerprint.py.

module Fingerprint

open System
open System.Security.Cryptography
open System.Text
open System.Text.Json

// ─── Stable JSON serialization ────────────────────────────────────────────────
// Keys sorted recursively — mirrors JS stableStringify() / Python stable_dumps().
// Output uses NO whitespace between tokens and unicode preserved.

let rec stableStringify (element: JsonElement) : string =
    match element.ValueKind with
    | JsonValueKind.Null -> "null"
    | JsonValueKind.True -> "true"
    | JsonValueKind.False -> "false"
    | JsonValueKind.String ->
        JsonSerializer.Serialize(element.GetString())
    | JsonValueKind.Number ->
        element.GetRawText()
    | JsonValueKind.Array ->
        let items = element.EnumerateArray() |> Seq.map stableStringify |> Seq.toArray
        "[" + String.Join(",", items) + "]"
    | JsonValueKind.Object ->
        let props = element.EnumerateObject() |> Seq.toArray
        let sorted = props |> Array.sortBy (fun p -> p.Name)
        let parts = sorted |> Array.map (fun p ->
            JsonSerializer.Serialize(p.Name) + ":" + stableStringify(p.Value)
        )
        "{" + String.Join(",", parts) + "}"
    | _ -> element.GetRawText()

let stableStringifyObj (obj: obj) : string =
    if isNull obj then "null"
    else
        let json = JsonSerializer.Serialize(obj)
        let doc = JsonDocument.Parse(json)
        stableStringify(doc.RootElement)

// ─── Base36 conversion ────────────────────────────────────────────────────────

let toBase36 (n: System.Numerics.BigInteger) : string =
    if n = System.Numerics.BigInteger.Zero then "0"
    else
        let chars = "0123456789abcdefghijklmnopqrstuvwxyz".ToCharArray()
        let mutable abs = if n.Sign < 0 then -n else n
        let result = ResizeArray<char>()
        while abs > System.Numerics.BigInteger.Zero do
            let divMod = abs % (System.Numerics.BigInteger 36)
            abs <- abs / (System.Numerics.BigInteger 36)
            let idx = int divMod
            result.Add(chars.[idx])
        let arr = result.ToArray()
        Array.Reverse(arr)
        String(arr)

// ─── Normalize ────────────────────────────────────────────────────────────────
// For v1, we skip normalize rules (most clusters don't need them).
// Fingerprint is computed on raw input/output. If needed, can be extended later.

let normalizeElement (element: JsonElement) (rules: string list) : JsonElement =
    if List.isEmpty rules then element
    else element  // v1: no normalization rules implemented

let normalizeObj (obj: obj) (rules: string list) : JsonElement =
    if isNull obj then
        let doc = JsonDocument.Parse("null")
        doc.RootElement.Clone()
    else
        let json = JsonSerializer.Serialize(obj)
        let doc = JsonDocument.Parse(json)
        normalizeElement doc.RootElement rules

// ─── Core fingerprint ────────────────────────────────────────────────────────

let fingerprint (inputData: obj) (outputData: obj)
                (rules: string list) (ignoreFields: string list) : string =
    let cleanInput = normalizeObj inputData rules
    let cleanOutput = normalizeObj outputData rules
    let combined = stableStringify(cleanInput) + "|" + stableStringify(cleanOutput)
    let bytes = Encoding.UTF8.GetBytes(combined)
    let hashBytes = SHA256.HashData(bytes)
    let hashHex =
        hashBytes
        |> Array.map (fun b -> b.ToString("x2"))
        |> String.Concat
    // BigInteger.Parse needs a positive hex; prepend "0" to avoid sign issues
    let bigNum = System.Numerics.BigInteger.Parse("0" + hashHex, Globalization.NumberStyles.HexNumber)
    let b36 = toBase36 bigNum
    if b36.Length >= 7 then b36.[0..6] else b36

// ─── Trivial output guard ─────────────────────────────────────────────────────

let isTrivialOutput (output: obj) : bool =
    if isNull output then true
    else
        match output with
        | :? string as s -> String.IsNullOrEmpty(s)
        | :? JsonElement as el ->
            match el.ValueKind with
            | JsonValueKind.Null -> true
            | JsonValueKind.String ->
                String.IsNullOrEmpty(el.GetString())
            | JsonValueKind.Array ->
                not (el.GetArrayLength() > 0)
            | JsonValueKind.Object ->
                // Object is never trivial (even empty object has structure)
                false
            | _ -> false
        | :? System.Collections.IEnumerable as e ->
            not (e |> Seq.cast |> Seq.isEmpty) |> not
        | _ -> false
