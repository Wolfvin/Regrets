// capture Program.fs — manifest-driven capture for F# clusters
//
// Reads regrets/manifest.json, filters stack: "fsharp", invokes entry function
// via temporary harness project that references target .fs file, computes
// fingerprint, writes .regret file.
//
// Architecture: F# cannot load a .fs file at runtime without compilation.
// So for each cluster, we generate a temporary .fsproj + Program.fs that
// references the target .fs file + calls the entry function directly
// (F# type inference works at compile time). The temp harness reads input
// JSON via env var REGRET_INPUT, invokes entry, prints output as JSON to stdout
// via "REGRET_OUTPUT <json>" line.

module CaptureProgram

open System
open System.Diagnostics
open System.IO
open System.Text.Json
open Fingerprint

// ─── CLI args ─────────────────────────────────────────────────────────────────

type CliArgs = {
    ClusterFilter: string option
    ManifestPath: string
}

let parseArgs (argv: string[]) : CliArgs =
    let mutable clusterFilter = None
    let mutable manifestPath = Path.Combine(Directory.GetCurrentDirectory(), "regrets", "manifest.json")
    let i = ref 0
    while !i < argv.Length do
        match argv.[!i] with
        | "--cluster" when !i + 1 < argv.Length ->
            clusterFilter <- Some argv.[!i + 1]
            i := !i + 2
        | "--manifest" when !i + 1 < argv.Length ->
            manifestPath <- argv.[!i + 1]
            i := !i + 2
        | _ -> i := !i + 1
    { ClusterFilter = clusterFilter; ManifestPath = manifestPath }

// ─── Manifest model ───────────────────────────────────────────────────────────

type Cluster = {
    Id: string
    Entry: string
    Watches: string list
    File: string
    Inputs: JsonElement list
    NormalizeRules: string list
    IgnoreFields: string list
    MultiArgs: bool
    FingerprintLevel: string
}

let parseCluster (m: JsonElement) : Cluster option =
    let tryStr (key: string) =
        let mutable v = Unchecked.defaultof<JsonElement>
        if m.TryGetProperty(key, &v) && v.ValueKind = JsonValueKind.String then
            Some (v.GetString())
        else None
    let tryList (key: string) =
        let mutable v = Unchecked.defaultof<JsonElement>
        if m.TryGetProperty(key, &v) && v.ValueKind = JsonValueKind.Array then
            v.EnumerateArray() |> Seq.map (fun e -> e.GetString()) |> Seq.toList
        else []
    let tryBool (key: string) (def: bool) =
        let mutable v = Unchecked.defaultof<JsonElement>
        if m.TryGetProperty(key, &v) then
            match v.ValueKind with
            | JsonValueKind.True -> true
            | JsonValueKind.False -> false
            | _ -> def
        else def
    let inputs =
        let mutable v = Unchecked.defaultof<JsonElement>
        if m.TryGetProperty("inputs", &v) && v.ValueKind = JsonValueKind.Array then
            v.EnumerateArray() |> Seq.toList
        else []
    let stack = tryStr "stack" |> Option.defaultValue "js"
    if stack <> "fsharp" then None
    else
        Some {
            Id = tryStr "id" |> Option.defaultValue ""
            Entry = tryStr "entry" |> Option.defaultValue ""
            Watches = tryList "watches"
            File = tryStr "file" |> Option.defaultValue ""
            Inputs = inputs
            NormalizeRules = tryList "normalize"
            IgnoreFields = tryList "ignoreFields"
            MultiArgs = tryBool "multiArgs" false
            FingerprintLevel = tryStr "fingerprintLevel" |> Option.defaultValue "entry"
        }

// ─── Temporary harness generator ──────────────────────────────────────────────
// The harness Program.fs references the target file's entry function directly.
// Since F# is statically typed, the entry function signature is inferred at
// compile time. The harness passes input as a JSON string via env var, parses
// it, calls entry, and serializes output as JSON.
//
// To handle various entry signatures (int->int, string->string, list->map),
// we use a generic approach: the harness deserializes input to obj, calls
// entry via reflection (FSharpValue.MakeFunction / ApplyFunction).
// For v1 simplicity, we require the entry function to accept a single obj
// and return an obj (the target file can wrap with a small adapter if needed).
// multiArgs=true means input is a JSON array; entry must accept obj[] (or list).

let harnessProjectContent (targetAbsPath: string) : string =
    $"""<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="{targetAbsPath}" />
    <Compile Include="Program.fs" />
  </ItemGroup>
</Project>"""

let harnessProgramContent (entryName: string) (multiArgs: bool) : string =
    // The harness calls entry with deserialized input.
    // For single-arg: input is deserialized to obj (JsonElement).
    // For multiArgs: input is array; entry is called with obj[] (boxed).
    // Entry must accept the matching type. F# type inference at compile time
    // will fail if entry signature doesn't match — that's a clear error.
    let invokeLine =
        if multiArgs then
            sprintf "            let arr = doc.RootElement.EnumerateArray() |> Seq.toArray |> Array.map box"
        else
            sprintf "            let result = %s (box doc.RootElement)" entryName
    let resultLine =
        if multiArgs then
            sprintf "            let result = %s arr" entryName
        else
            null  // already set in invokeLine
    let lines = ResizeArray<string>()
    lines.Add("// AUTO-GENERATED by capture Program.fs")
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
        lines.Add(invokeLine)  // let arr = ...
        lines.Add(resultLine)  // let result = entry arr
    else
        lines.Add(invokeLine)  // let result = entry (box doc.RootElement)
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

/// Build the harness project first (so we can see build errors clearly),
/// then run it. Returns Result with output or error message including build errors.
let invokeViaHarness (targetAbsPath: string) (entryName: string) (multiArgs: bool) (inputJson: string) : Result<obj, string> =
    let tempDir = Path.Combine(Path.GetTempPath(), "regret_fsharp_" + Guid.NewGuid().ToString("N").[..7])
    Directory.CreateDirectory(tempDir) |> ignore
    let projPath = Path.Combine(tempDir, "harness.fsproj")
    let progPath = Path.Combine(tempDir, "Program.fs")
    File.WriteAllText(projPath, harnessProjectContent targetAbsPath)
    File.WriteAllText(progPath, harnessProgramContent entryName multiArgs)

    try
        // Step 1: build first to surface compile errors clearly
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
            // Step 2: run the built dll
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
                | None -> Error("harness produced no output. stdout: " + stdout.Trim().[..500] + " | stderr: " + stderr.Trim().[..500])
    finally
        try Directory.Delete(tempDir, true) with _ -> ()

// ─── Run a single cluster ────────────────────────────────────────────────────

let runCluster (c: Cluster) (outDir: string) : bool =
    Console.WriteLine()
    Console.WriteLine("📡 Capturing: " + c.Id)
    Console.WriteLine("   File:       " + c.File)
    Console.WriteLine("   Entry:      " + c.Entry)
    Console.WriteLine("   Watches:    " + String.Join(", ", c.Watches))
    Console.WriteLine("   Inputs:     " + string c.Inputs.Length + " case(s)")

    if String.IsNullOrEmpty(c.File) then
        Console.WriteLine("   ❌ Cluster requires 'file' field.")
        false
    else
        let targetAbsPath = Path.Combine(Directory.GetCurrentDirectory(), c.File) |> Path.GetFullPath
        if not (File.Exists(targetAbsPath)) then
            Console.WriteLine("   ❌ Target file not found: " + targetAbsPath)
            false
        else
            try
                let results = ResizeArray<{| Input: obj; Output: obj; Fp: string |}>()
                let mutable skippedTrivial = 0

                for input in c.Inputs do
                    let inputJson = input.GetRawText()
                    match invokeViaHarness targetAbsPath c.Entry c.MultiArgs inputJson with
                    | Error e ->
                        Console.WriteLine("   ⚠️  Invocation threw for input " + inputJson + ": " + e)
                        skippedTrivial <- skippedTrivial + 1
                    | Ok output ->
                        if isTrivialOutput output then
                            Console.WriteLine("   ⚠️  Trivial output for input " + inputJson + " — skipping this case.")
                            skippedTrivial <- skippedTrivial + 1
                        else
                            let inputObj = box input
                            let fp = fingerprint inputObj output c.NormalizeRules c.IgnoreFields
                            results.Add({| Input = inputObj; Output = output; Fp = fp |})

                if results.Count = 0 then
                    Console.WriteLine("   ❌ All input cases were trivial/threw — no .regret written.")
                    false
                else
                    let golden = results.[0]
                    let fp = golden.Fp
                    let regretPath = Path.Combine(outDir, c.Id + ".regret")
                    let timestamp = DateTime.UtcNow.ToString("o")

                    let lines = ResizeArray<string>()
                    lines.Add("cluster: " + c.Id)
                    lines.Add("version: 1")
                    lines.Add("fingerprint: " + fp)
                    lines.Add("captured: " + timestamp)
                    lines.Add("watches: [" + String.Join(", ", c.Watches) + "]")
                    lines.Add("entry: " + c.Entry)
                    lines.Add("stack: fsharp")
                    lines.Add("fingerprintLevel: " + c.FingerprintLevel)
                    if not (List.isEmpty c.NormalizeRules) then
                        lines.Add("normalize: [" + String.Join(", ", c.NormalizeRules) + "]")
                    if not (List.isEmpty c.IgnoreFields) then
                        lines.Add("ignoreFields: [" + String.Join(", ", c.IgnoreFields) + "]")
                    if c.MultiArgs then lines.Add("multiArgs: true")
                    lines.Add("file: " + c.File)
                    lines.Add("---")
                    lines.Add("INPUT  " + JsonSerializer.Serialize(golden.Input))
                    lines.Add("OUTPUT " + JsonSerializer.Serialize(golden.Output))
                    lines.Add("HASH   " + fp)

                    File.WriteAllLines(regretPath, lines)

                    Console.WriteLine("   ✅ Fingerprint: " + fp)
                    Console.WriteLine("   📄 Saved: regrets/" + c.Id + ".regret")
                    if skippedTrivial > 0 then
                        Console.WriteLine("   ℹ️  " + string skippedTrivial + " trivial/threw case(s) skipped.")
                    true
            with
            | e ->
                Console.WriteLine("   ❌ Capture failed: " + e.Message)
                false

// ─── Main ────────────────────────────────────────────────────────────────────

[<EntryPoint>]
let main argv =
    let args = parseArgs argv

    if not (File.Exists(args.ManifestPath)) then
        Console.Error.WriteLine("❌ Could not read manifest: " + args.ManifestPath)
        Console.Error.WriteLine("   Create regrets/manifest.json first. See SKILL.md for format.")
        1
    else
        try
            let manifestJson = File.ReadAllText(args.ManifestPath)
            use doc = JsonDocument.Parse(manifestJson)
            let mutable clustersEl = Unchecked.defaultof<JsonElement>
            let hasClusters = doc.RootElement.TryGetProperty("clusters", &clustersEl)
            let clustersRaw =
                if hasClusters && clustersEl.ValueKind = JsonValueKind.Array then
                    clustersEl.EnumerateArray() |> Seq.toList
                else []
            let clusters = clustersRaw |> List.choose parseCluster
            let filteredClusters =
                match args.ClusterFilter with
                | Some id -> clusters |> List.filter (fun c -> c.Id = id)
                | None -> clusters

            if List.isEmpty filteredClusters then
                Console.WriteLine("No F# clusters found in manifest.")
                0
            else
                let outDir = Path.Combine(Directory.GetCurrentDirectory(), "regrets")
                Directory.CreateDirectory(outDir) |> ignore

                let mutable passed = 0
                let mutable failed = 0
                for c in filteredClusters do
                    if runCluster c outDir then passed <- passed + 1
                    else failed <- failed + 1

                Console.WriteLine()
                Console.WriteLine(String('─', 50))
                Console.WriteLine("F# capture complete: " + string passed + " captured, " + string failed + " failed")
                if failed > 0 then 1 else 0
        with
        | e ->
            Console.Error.WriteLine("❌ Error: " + e.Message)
            1
