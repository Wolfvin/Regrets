// validate Program.fs — regression validator for F# clusters
//
// Reads .regret files for F# clusters, re-invokes entry function via
// temporary harness (same pattern as capture), compares hash to stored HASH.

module ValidateProgram

open System
open System.Diagnostics
open System.IO
open System.Text.Json
open Fingerprint

// ─── CLI args ─────────────────────────────────────────────────────────────────

type CliArgs = {
    ClusterFilter: string option
    FailFast: bool
}

let parseArgs (argv: string[]) : CliArgs =
    let mutable clusterFilter = None
    let mutable failFast = false
    let i = ref 0
    while !i < argv.Length do
        match argv.[!i] with
        | "--cluster" when !i + 1 < argv.Length ->
            clusterFilter <- Some argv.[!i + 1]
            i := !i + 2
        | "--fail-fast" ->
            failFast <- true
            i := !i + 1
        | _ -> i := !i + 1
    { ClusterFilter = clusterFilter; FailFast = failFast }

// ─── .regret file parser ─────────────────────────────────────────────────────

type RegretFile = {
    Cluster: string
    GoldenHash: string
    Entry: string
    File: string
    Watches: string list
    NormalizeRules: string list
    IgnoreFields: string list
    MultiArgs: bool
    Input: obj
    Output: obj
    // Inputs 2..N parsed from the INPUTS line (issue #535 parity with Haskell/Crystal/Tcl).
    // Empty for older .regret files that only persisted input #1 — backward compat:
    // validate then behaves exactly like before (only first input is checked).
    ExtraInputs: (obj * string) list  // (input, hash) — output is re-derived live
}

let parseListField (v: string) : string list =
    let trimmed = v.Trim()
    if String.IsNullOrEmpty(trimmed) then []
    else
        let inner =
            if trimmed.StartsWith("[") && trimmed.EndsWith("]") then
                trimmed.Substring(1, trimmed.Length - 2)
            else trimmed
        if String.IsNullOrEmpty(inner.Trim()) then []
        else
            inner.Split(',') |> Array.map (fun s -> s.Trim()) |> Array.filter (fun s -> s.Length > 0) |> Array.toList

let parseRegret (content: string) : RegretFile option =
    // CRLF -> LF guard: git core.autocrlf=true (Windows default) rewrites
    // .regret files to CRLF on checkout. Without normalizing, every
    // extracted meta/data value below (file, entry, INPUT, OUTPUT, HASH)
    // keeps a trailing '\r' -- e.g. "file" becomes "MathUtils.fs\r", which
    // fails File.Exists downstream with a misleading "target file not
    // found" (same root cause/severity as confirmed Java bug #522).
    let content = content.Replace("\r\n", "\n")
    let sections = content.Split([|"---"|], StringSplitOptions.None)
    if sections.Length < 2 then None
    else
        let metaSection = sections.[0]
        let dataSection = String.Join("---", sections.[1..])
        let meta = ResizeArray<(string * string)>()
        for line in metaSection.Split('\n') do
            let idx = line.IndexOf(": ")
            if idx >= 0 then
                meta.Add((line.Substring(0, idx), line.Substring(idx + 2)))
        let metaMap = meta |> Map.ofSeq
        let mutable inputLine = None
        let mutable outputLine = None
        let mutable hashLine = None
        let mutable inputsLine = None
        for line in dataSection.Split('\n') do
            if line.StartsWith("INPUT ") then inputLine <- Some (line.Substring("INPUT ".Length))
            if line.StartsWith("OUTPUT ") then outputLine <- Some (line.Substring("OUTPUT ".Length))
            if line.StartsWith("HASH ") then hashLine <- Some (line.Substring("HASH ".Length))
            // INPUTS line (plural, issue #535): only matches the multi-input line
            // "INPUTS [...]", never "INPUT " (singular, which is matched above).
            if line.StartsWith("INPUTS ") then inputsLine <- Some (line.Substring("INPUTS ".Length))
        let parseJson (s: string option) : obj =
            match s with
            | None -> null
            | Some v ->
                if v = "undefined" then null
                else
                    try
                        let doc = JsonDocument.Parse(v)
                        let cloned = doc.RootElement.Clone()
                        box cloned
                    with _ -> box v
        // Parse INPUTS line (issue #535): JSON array of {input, output, hash}.
        // Returns list of (input-obj, hash-string) tuples. Output field is parsed
        // for forward-compat but not stored — validate re-derives output live.
        // Returns [] for missing/empty/malformed INPUTS line (backward compat).
        let parseExtraInputs (s: string option) : (obj * string) list =
            match s with
            | None -> []
            | Some v ->
                if String.IsNullOrWhiteSpace(v) then []
                else
                    try
                        use doc = JsonDocument.Parse(v)
                        if doc.RootElement.ValueKind <> JsonValueKind.Array then []
                        else
                            doc.RootElement.EnumerateArray()
                            |> Seq.map (fun el ->
                                let mutable inputEl = Unchecked.defaultof<JsonElement>
                                let hasInput = el.TryGetProperty("input", &inputEl)
                                let mutable hashEl = Unchecked.defaultof<JsonElement>
                                let hasHash = el.TryGetProperty("hash", &hashEl)
                                let inputObj =
                                    if hasInput then box (inputEl.Clone())
                                    else null
                                let hashStr =
                                    if hasHash && hashEl.ValueKind = JsonValueKind.String then hashEl.GetString()
                                    else ""
                                (inputObj, hashStr))
                            |> Seq.toList
                    with _ -> []
        match metaMap.TryFind("stack") with
        | Some s when s.Trim() = "fsharp" ->
            Some {
                Cluster = metaMap.TryFind("cluster") |> Option.defaultValue ""
                GoldenHash = (hashLine |> Option.defaultValue "").Trim()
                Entry = metaMap.TryFind("entry") |> Option.defaultValue ""
                File = metaMap.TryFind("file") |> Option.defaultValue ""
                Watches = parseListField (metaMap.TryFind("watches") |> Option.defaultValue "")
                NormalizeRules = parseListField (metaMap.TryFind("normalize") |> Option.defaultValue "")
                IgnoreFields = parseListField (metaMap.TryFind("ignoreFields") |> Option.defaultValue "")
                MultiArgs = (metaMap.TryFind("multiArgs") |> Option.defaultValue "false") = "true"
                Input = parseJson inputLine
                Output = parseJson outputLine
                ExtraInputs = parseExtraInputs inputsLine
            }
        | _ -> None

// ─── Harness generation (same as capture) ────────────────────────────────────

let harnessProjectContent (targetAbsPath: string) : string =
    sprintf """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="%s" />
    <Compile Include="Program.fs" />
  </ItemGroup>
</Project>""" targetAbsPath

let harnessProgramContent (entryName: string) (multiArgs: bool) : string =
    let invokeLine =
        if multiArgs then
            sprintf "            let arr = doc.RootElement.EnumerateArray() |> Seq.toArray |> Array.map box"
        else
            sprintf "            let result = %s (box doc.RootElement)" entryName
    let resultLine =
        if multiArgs then
            sprintf "            let result = %s arr" entryName
        else
            null
    let lines = ResizeArray<string>()
    lines.Add("// AUTO-GENERATED by validate Program.fs")
    lines.Add("module HarnessProgram")
    lines.Add("")
    lines.Add("open System")
    lines.Add("open System.Text.Json")
    lines.Add("")
    lines.Add("[<EntryPoint>]")
    lines.Add("let main _ =")
    lines.Add("    let inputJson = Environment.GetEnvironmentVariable(\"REGRET_INPUT\")")
    lines.Add("    if String.IsNullOrEmpty(inputJson) then")
    lines.Add("        Console.Error.WriteLine(\"REGRET_ERROR REGRET_INPUT env var not set\")")
    lines.Add("        Console.Error.WriteLine(\"REGRET_DONE\")")
    lines.Add("        1")
    lines.Add("    else")
    lines.Add("        try")
    lines.Add("            use doc = JsonDocument.Parse(inputJson)")
    if multiArgs then
        lines.Add(invokeLine)
        lines.Add(resultLine)
    else
        lines.Add(invokeLine)
    lines.Add("            let jsonOut = JsonSerializer.Serialize(result)")
    lines.Add("            Console.WriteLine(\"REGRET_OUTPUT \" + jsonOut)")
    lines.Add("            Console.Error.WriteLine(\"REGRET_DONE\")")
    lines.Add("            0")
    lines.Add("        with")
    lines.Add("        | e ->")
    lines.Add("            Console.Error.WriteLine(\"REGRET_ERROR \" + e.Message)")
    lines.Add("            Console.Error.WriteLine(\"REGRET_DONE\")")
    lines.Add("            1")
    String.Join("\n", lines) + "\n"

/// Build harness first, then run. Returns Result with output or error.
let invokeViaHarness (targetAbsPath: string) (entryName: string) (multiArgs: bool) (inputJson: string) : Result<obj, string> =
    let tempDir = Path.Combine(Path.GetTempPath(), "regret_fsharp_val_" + Guid.NewGuid().ToString("N").[..7])
    Directory.CreateDirectory(tempDir) |> ignore
    let projPath = Path.Combine(tempDir, "harness.fsproj")
    let progPath = Path.Combine(tempDir, "Program.fs")
    File.WriteAllText(projPath, harnessProjectContent targetAbsPath)
    File.WriteAllText(progPath, harnessProgramContent entryName multiArgs)

    try
        let buildPsi = ProcessStartInfo(
            FileName = "dotnet",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = tempDir
        )
        buildPsi.ArgumentList.Add("build")
        buildPsi.ArgumentList.Add(projPath)
        buildPsi.ArgumentList.Add("--nologo")
        buildPsi.EnvironmentVariables.["DOTNET_CLI_TELEMETRY_OPTOUT"] <- "1"
        buildPsi.EnvironmentVariables.["DOTNET_NOLOGO"] <- "true"
        let buildP = Process.Start(buildPsi)
        let buildStdout = buildP.StandardOutput.ReadToEnd()
        let buildStderr = buildP.StandardError.ReadToEnd()
        buildP.WaitForExit(120000) |> ignore
        if buildP.ExitCode <> 0 then
            Error("harness build failed:\n" + buildStdout + "\n" + buildStderr)
        else
            let dllPath = Path.Combine(tempDir, "bin", "Debug", "net8.0", "harness.dll")
            let runPsi = ProcessStartInfo(
                FileName = "dotnet",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            )
            runPsi.ArgumentList.Add(dllPath)
            runPsi.EnvironmentVariables.["REGRET_INPUT"] <- inputJson
            runPsi.EnvironmentVariables.["DOTNET_CLI_TELEMETRY_OPTOUT"] <- "1"
            runPsi.EnvironmentVariables.["DOTNET_NOLOGO"] <- "true"
            let p = Process.Start(runPsi)
            let stdout = p.StandardOutput.ReadToEnd()
            let stderr = p.StandardError.ReadToEnd()
            p.WaitForExit(60000) |> ignore
            let outputLine =
                stdout.Split('\n')
                |> Seq.tryFind (fun l -> l.StartsWith("REGRET_OUTPUT "))
            match outputLine with
            | Some line ->
                let jsonStr = line.Substring("REGRET_OUTPUT ".Length).Trim()
                try
                    let outDoc = JsonDocument.Parse(jsonStr)
                    let cloned = outDoc.RootElement.Clone()
                    Ok(box cloned)
                with _ ->
                    Ok(box jsonStr)
            | None ->
                let errLine =
                    stderr.Split('\n')
                    |> Seq.tryFind (fun l -> l.StartsWith("REGRET_ERROR "))
                match errLine with
                | Some line -> Error(line.Substring("REGRET_ERROR ".Length))
                | None -> Error("harness produced no output. stdout: " + stdout.Trim().[..300] + " stderr: " + stderr.Trim().[..300])
    finally
        try Directory.Delete(tempDir, true) with _ -> ()

// ─── Validate one cluster ────────────────────────────────────────────────────

type ValidateResult = Pass | Fail | Skip

let validateOne (r: RegretFile) : (ValidateResult * string option * obj option * string option) =
    try
        if String.IsNullOrEmpty(r.File) then
            Fail, None, None, Some "regret file missing 'file' field"
        else
            let targetAbsPath = Path.Combine(Directory.GetCurrentDirectory(), r.File) |> Path.GetFullPath
            if not (File.Exists(targetAbsPath)) then
                Fail, None, None, Some ("target file not found: " + targetAbsPath)
            else
                let inputJson =
                    if isNull r.Input then "null"
                    else JsonSerializer.Serialize(r.Input)
                match invokeViaHarness targetAbsPath r.Entry r.MultiArgs inputJson with
                | Error e -> Fail, None, None, Some ("invocation threw: " + e)
                | Ok actualOutput ->
                    if isTrivialOutput actualOutput then
                        Skip, None, Some actualOutput, Some "trivial output"
                    else
                        let actualHash = fingerprint r.Input actualOutput r.NormalizeRules r.IgnoreFields
                        if actualHash <> r.GoldenHash then
                            Fail, Some actualHash, Some actualOutput, Some "hash mismatch"
                        else
                            // First input passed. Now validate inputs 2..N from the
                            // INPUTS line (issue #535 parity with Haskell/Crystal/Tcl).
                            //
                            // Backward compat: older .regret files without an INPUTS
                            // line have r.ExtraInputs = [] and this loop is a no-op,
                            // so they continue to validate exactly like before
                            // (first input only). No false-FAIL on legacy .regret files.
                            //
                            // A mismatch on any input #2+ is a regression and FAILs
                            // the whole cluster — that's the bug being fixed.
                            let mutable extraError: string option = None
                            let mutable extraIdx = 2  // 1-indexed; input #1 already validated above
                            for (eiInput, eiHash) in r.ExtraInputs do
                                if Option.isNone extraError then
                                    let eiInputJson =
                                        if isNull eiInput then "null"
                                        else JsonSerializer.Serialize(eiInput)
                                    match invokeViaHarness targetAbsPath r.Entry r.MultiArgs eiInputJson with
                                    | Error e ->
                                        extraError <- Some (sprintf "INPUTS[%d] invocation threw: %s" extraIdx e)
                                    | Ok eiActualOutput ->
                                        if isTrivialOutput eiActualOutput then
                                            extraError <- Some (sprintf "INPUTS[%d] trivial output" extraIdx)
                                        else
                                            let eiActualHash = fingerprint eiInput eiActualOutput r.NormalizeRules r.IgnoreFields
                                            if eiActualHash <> eiHash then
                                                extraError <- Some (
                                                    sprintf "INPUTS[%d] hash mismatch (golden: %s, live: %s)"
                                                        extraIdx eiHash eiActualHash)
                                extraIdx <- extraIdx + 1
                            match extraError with
                            | Some e -> Fail, Some actualHash, Some actualOutput, Some e
                            | None -> Pass, Some actualHash, Some actualOutput, None
    with
    | e -> Fail, None, None, Some ("exception: " + e.Message)

// ─── Main ────────────────────────────────────────────────────────────────────

[<EntryPoint>]
let main argv =
    let args = parseArgs argv
    let regretDir = Path.Combine(Directory.GetCurrentDirectory(), "regrets")
    if not (Directory.Exists(regretDir)) then
        Console.Error.WriteLine("❌ regrets/ directory not found.")
        1
    else
        let regretFiles =
            Directory.GetFiles(regretDir, "*.regret")
            |> Array.filter (fun f -> not (Path.GetFileName(f).Contains(".calls.")))
            |> Array.choose (fun f ->
                let content = File.ReadAllText(f)
                parseRegret content
            )
            |> Array.filter (fun r ->
                match args.ClusterFilter with
                | Some id -> r.Cluster = id
                | None -> true
            )

        if Array.isEmpty regretFiles then
            Console.WriteLine("No F# .regret files found.")
            0
        else
            Console.WriteLine("🔍 Validating " + string regretFiles.Length + " F# regret file(s)...")
            let mutable pass = 0
            let mutable fail = 0
            let mutable skip = 0
            for r in regretFiles do
                let (result, actualHash, actualOutput, error) = validateOne r
                match result with
                | Pass ->
                    let nInputs = 1 + List.length r.ExtraInputs
                    let inputWord = if nInputs > 1 then " inputs" else " input"
                    Console.WriteLine("✅ PASS  " + r.Cluster + "  hash=" + (defaultArg actualHash "") + "  (" + string nInputs + inputWord + ")")
                    pass <- pass + 1
                | Fail ->
                    Console.WriteLine("❌ FAIL  " + r.Cluster)
                    Console.WriteLine("   expected hash: " + r.GoldenHash)
                    Console.WriteLine("   actual hash:   " + (defaultArg actualHash "(none)"))
                    Console.WriteLine("   reason:        " + (defaultArg error ""))
                    Console.WriteLine("   expected OUTPUT: " + JsonSerializer.Serialize(r.Output))
                    Console.WriteLine("   actual OUTPUT:   " + JsonSerializer.Serialize(actualOutput))
                    fail <- fail + 1
                    if args.FailFast then
                        Console.WriteLine("\n⚠️  --fail-fast: stopping on first failure.")
                        exit 1
                | Skip ->
                    Console.WriteLine("⏭️  SKIP  " + r.Cluster + "  (" + (defaultArg error "") + ")")
                    skip <- skip + 1
            Console.WriteLine()
            Console.WriteLine(String('─', 50))
            Console.WriteLine("Validation summary: " + string pass + " PASS, " + string fail + " FAIL, " + string skip + " SKIP")
            if fail > 0 then
                Console.WriteLine("\n❌ Regression detected. Fix the code, NOT the .regret file.")
                1
            else
                Console.WriteLine("\n✅ All green. Clear to refactor.")
                0
