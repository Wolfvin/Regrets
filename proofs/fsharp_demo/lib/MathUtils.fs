// MathUtils.fs — real F# functions used as capture/validate targets.
//
// These are pure functions that take JSON-deserializable input and return
// JSON-serializable output. The Regrets harness passes input as a JSON
// string via env var, deserializes to JsonElement (boxed as obj), and
// calls the entry function. Entry must accept obj (the JsonElement) and
// return a JSON-serializable value.
//
// Three functions exported:
//   - add: takes obj (JsonElement representing a number), returns int
//   - classifyBmi: takes obj (JsonElement representing a number), returns string
//   - summarizeCart: takes obj (JsonElement representing an array of items),
//     returns a map { subtotal, tax, total, itemCount }

module MathUtils

open System
open System.Text.Json

/// Helper: extract a number from a JsonElement (handles int or float).
let private num (o: obj) : float =
    match o with
    | :? JsonElement as el ->
        match el.ValueKind with
        | JsonValueKind.Number -> el.GetDouble()
        | _ -> 0.0
    | :? int as i -> float i
    | :? float as f -> f
    | :? double as d -> d
    | _ -> 0.0

/// add: takes a JsonElement representing a number, returns the number +1.
/// (Simple increment function — good fingerprint target.)
let add (input: obj) : int =
    int (num input) + 1

/// classifyBmi: takes a JsonElement representing a BMI number, returns
/// a WHO category string.
let classifyBmi (input: obj) : string =
    let bmi = num input
    if bmi < 18.5 then "Underweight"
    elif bmi < 25.0 then "Normal"
    elif bmi < 30.0 then "Overweight"
    else "Obese"

/// summarizeCart: takes a JsonElement representing an array of cart items
/// (each { name, price, qty }), returns a map with subtotal, tax (11% PPN),
/// total, and itemCount.
let summarizeCart (input: obj) : obj =
    let items =
        match input with
        | :? JsonElement as el when el.ValueKind = JsonValueKind.Array ->
            el.EnumerateArray() |> Seq.toList
        | _ -> []
    let mutable subtotal = 0
    let mutable itemCount = 0
    for item in items do
        let price = item.GetProperty("price").GetInt32()
        let qty = item.GetProperty("qty").GetInt32()
        subtotal <- subtotal + (price * qty)
        itemCount <- itemCount + qty
    let tax = int (round (float subtotal * 0.11))
    let total = subtotal + tax
    // Return as a dict (will be JSON-serialized)
    dict [
        "subtotal", box subtotal
        "tax", box tax
        "total", box total
        "itemCount", box itemCount
    ] :> obj

/// formatRupiah: takes a JsonElement representing an integer amount,
/// returns a formatted Indonesian Rupiah string (e.g., 1500000 → "Rp 1.500.000").
let formatRupiah (input: obj) : string =
    let amount = int (num input)
    let absAmount = if amount < 0 then -amount else amount
    let s = string absAmount
    let buf = Text.StringBuilder()
    let mutable count = 0
    for i in (s.Length - 1) .. -1 .. 0 do
        if count > 0 && count % 3 = 0 then buf.Append('.') |> ignore
        buf.Append(s.[i]) |> ignore
        count <- count + 1
    let formatted =
        // Reverse
        let arr = buf.ToString().ToCharArray()
        Array.Reverse(arr)
        String(arr)
    if amount < 0 then "-Rp " + formatted
    else "Rp " + formatted
