// RegretRunner.cs — Main entry point for capture + validate of C# clusters.
//
// Usage:
//   dotnet run --project scripts/regret_csharp -- capture
//   dotnet run --project scripts/regret_csharp -- validate
//   dotnet run --project scripts/regret_csharp -- capture --cluster morse-encode
//   dotnet run --project scripts/regret_csharp -- validate --cluster morse-encode
//   dotnet run --project scripts/regret_csharp -- update --cluster morse-encode --reason "..."
//
// Reads regrets/manifest.json from the current working directory.
// Writes .regret files to regrets/<cluster-id>.regret.
//
// Manifest schema for C# clusters:
// {
//   "id": "morse-encode",
//   "entry": "Encode",
//   "watches": ["Encode"],
//   "stack": "csharp",
//   "assembly": "MyLib.dll",
//   "class": "MyLib.MorseCode",
//   "fingerprintLevel": "entry",
//   "inputs": ["SOS", "hello world", ""]
// }
//
// Required fields: id, entry, stack=csharp, assembly, inputs
// Optional: class (default: Program), watches (informational only in v1)

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RegretCsharp;

public class ClusterConfig
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("entry")] public string Entry { get; set; } = "";
    [JsonPropertyName("watches")] public List<string>? Watches { get; set; }
    [JsonPropertyName("stack")] public string Stack { get; set; } = "csharp";
    [JsonPropertyName("assembly")] public string? Assembly { get; set; }
    [JsonPropertyName("class")] public string? ClassName { get; set; }
    [JsonPropertyName("fingerprintLevel")] public string? FingerprintLevel { get; set; }
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("inputs")] public List<JsonElement>? Inputs { get; set; }
}

public class Manifest
{
    [JsonPropertyName("clusters")] public List<ClusterConfig> Clusters { get; set; } = new();
}

public class RegretFile
{
    public string Cluster { get; set; } = "";
    public int Version { get; set; } = 1;
    public string Fingerprint { get; set; } = "";
    public string Captured { get; set; } = "";
    public string Entry { get; set; } = "";
    public string Stack { get; set; } = "csharp";
    public string? ClassName { get; set; }
    public string? Assembly { get; set; }
    public string Input { get; set; } = "";
    public string Output { get; set; } = "";
    public string Hash { get; set; } = "";
}

public static class RegretRunner
{
    private const int RegretFormatVersion = 1;

    public static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            PrintUsage();
            return 1;
        }

        var command = args[0].ToLowerInvariant();
        string? clusterFilter = null;
        string? reason = null;

        for (int i = 1; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg == "--cluster" && i + 1 < args.Length)
            {
                clusterFilter = args[++i];
            }
            else if (arg == "--update" && i + 1 < args.Length)
            {
                // --update can be either a bare flag (JS-style) or take the cluster id
                // as its value (Python/Rust/Go-style). Both forms are supported.
                var next = args[i + 1];
                if (!next.StartsWith("--") && !string.IsNullOrEmpty(next))
                {
                    clusterFilter = next;
                    i++;
                }
            }
            else if (arg == "--reason" && i + 1 < args.Length)
            {
                reason = args[++i];
            }
            else if (arg == "--help" || arg == "-h")
            {
                PrintUsage();
                return 0;
            }
        }

        var cwd = Environment.GetEnvironmentVariable("REGRET_PROJECT_ROOT");
        if (string.IsNullOrEmpty(cwd))
        {
            cwd = Directory.GetCurrentDirectory();
        }
        var manifestPath = Path.Combine(cwd, "regrets", "manifest.json");
        if (!File.Exists(manifestPath))
        {
            Console.Error.WriteLine($"❌ regrets/manifest.json not found at: {manifestPath}");
            Console.Error.WriteLine("   Run this from your project root (where regrets/ lives).");
            return 2;
        }

        Manifest manifest;
        try
        {
            var manifestJson = File.ReadAllText(manifestPath);
            manifest = JsonSerializer.Deserialize<Manifest>(manifestJson, JsonOpts) ?? new Manifest();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"❌ Failed to parse manifest.json: {ex.Message}");
            return 2;
        }

        var csharpClusters = manifest.Clusters
            .Where(c => string.Equals(c.Stack, "csharp", StringComparison.OrdinalIgnoreCase))
            .ToList();

        if (clusterFilter != null)
        {
            csharpClusters = csharpClusters
                .Where(c => c.Id == clusterFilter)
                .ToList();
        }

        if (csharpClusters.Count == 0)
        {
            Console.WriteLine("ℹ️  No C# clusters found in manifest.");
            return 0;
        }

        return command switch
        {
            "capture" => RunCapture(csharpClusters, cwd),
            "validate" => RunValidate(csharpClusters, cwd),
            "update" => RunUpdate(csharpClusters, cwd, clusterFilter, reason),
            "list" => RunList(csharpClusters),
            _ => PrintUsage(),
        };
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static int PrintUsage()
    {
        Console.WriteLine("Usage: dotnet run --project scripts/regret_csharp -- <command> [options]");
        Console.WriteLine();
        Console.WriteLine("Commands:");
        Console.WriteLine("  capture              Capture fingerprints for all C# clusters");
        Console.WriteLine("  validate             Validate .regret files against current code");
        Console.WriteLine("  update               Re-capture (for use with `regret update`)");
        Console.WriteLine("  list                 List C# clusters from manifest");
        Console.WriteLine();
        Console.WriteLine("Options:");
        Console.WriteLine("  --cluster <id>       Operate on a single cluster");
        Console.WriteLine("  --reason \"...\"       Update reason (for audit log, with update)");
        Console.WriteLine("  --help, -h           Show this help");
        return 1;
    }

    private static int RunList(List<ClusterConfig> clusters)
    {
        Console.WriteLine($"C# clusters ({clusters.Count}):");
        foreach (var c in clusters)
        {
            Console.WriteLine($"  - {c.Id} (entry={c.Entry}, class={c.ClassName ?? "Program"}, assembly={c.Assembly})");
            if (c.Inputs != null)
            {
                Console.WriteLine($"    inputs: {c.Inputs.Count}");
            }
        }
        return 0;
    }

    private static int RunCapture(List<ClusterConfig> clusters, string projectRoot)
    {
        var regretDir = Path.Combine(projectRoot, "regrets");
        Directory.CreateDirectory(regretDir);

        var captured = 0;
        var skipped = 0;
        var failed = 0;

        Console.WriteLine($"📡 Capturing {clusters.Count} C# cluster(s)...");

        foreach (var cluster in clusters)
        {
            try
            {
                var (inputObj, outputObj, hash) = InvokeCluster(cluster, projectRoot);

                // Trivial output guard — skip if null/empty
                if (ShouldSkip(outputObj))
                {
                    Console.WriteLine($"  ⏭️  Skipped {cluster.Id}: trivial output (null/empty)");
                    skipped++;
                    continue;
                }

                var regret = new RegretFile
                {
                    Cluster = cluster.Id,
                    Version = RegretFormatVersion,
                    Fingerprint = hash,
                    Captured = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffffff+00:00"),
                    Entry = cluster.Entry,
                    Stack = "csharp",
                    ClassName = cluster.ClassName,
                    Assembly = cluster.Assembly,
                    Input = Fingerprint.StableStringify(inputObj),
                    Output = Fingerprint.StableStringify(outputObj),
                    Hash = hash,
                };

                var regretPath = Path.Combine(regretDir, $"{cluster.Id}.regret");
                File.WriteAllText(regretPath, SerializeRegret(regret));
                Console.WriteLine($"  ✅ Captured {cluster.Id} → {regretPath} (fp={hash})");
                captured++;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"  ❌ Failed {cluster.Id}: {ex.Message}");
                failed++;
            }
        }

        Console.WriteLine();
        Console.WriteLine($"Summary: {captured} captured, {skipped} skipped, {failed} failed");
        return failed > 0 ? 1 : 0;
    }

    private static int RunValidate(List<ClusterConfig> clusters, string projectRoot)
    {
        var regretDir = Path.Combine(projectRoot, "regrets");
        var passed = 0;
        var failed = 0;
        var missing = 0;
        var skipped = 0;

        Console.WriteLine($"🔍 Validating {clusters.Count} C# cluster(s)...");

        foreach (var cluster in clusters)
        {
            var regretPath = Path.Combine(regretDir, $"{cluster.Id}.regret");
            if (!File.Exists(regretPath))
            {
                Console.Error.WriteLine($"  ❌ Missing .regret file for {cluster.Id}: {regretPath}");
                Console.Error.WriteLine($"     Run capture first: dotnet run --project scripts/regret_csharp -- capture --cluster {cluster.Id}");
                missing++;
                continue;
            }

            RegretFile saved;
            try
            {
                saved = ParseRegret(File.ReadAllText(regretPath));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"  ❌ Failed to parse {regretPath}: {ex.Message}");
                failed++;
                continue;
            }

            try
            {
                var (inputObj, outputObj, hash) = InvokeCluster(cluster, projectRoot);

                if (ShouldSkip(outputObj))
                {
                    Console.WriteLine($"  ⏭️  Skipped {cluster.Id}: trivial output");
                    skipped++;
                    continue;
                }

                if (hash == saved.Hash)
                {
                    Console.WriteLine($"  ✅ PASS  {cluster.Id} (fp={hash})");
                    passed++;
                }
                else
                {
                    Console.Error.WriteLine($"  ❌ FAIL  {cluster.Id}");
                    Console.Error.WriteLine($"     expected fp={saved.Hash}, got fp={hash}");
                    Console.Error.WriteLine($"     input : {Fingerprint.StableStringify(inputObj)}");
                    Console.Error.WriteLine($"     output: {Fingerprint.StableStringify(outputObj)}");
                    Console.Error.WriteLine($"     saved input : {saved.Input}");
                    Console.Error.WriteLine($"     saved output: {saved.Output}");
                    failed++;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"  ❌ Failed to re-invoke {cluster.Id}: {ex.Message}");
                failed++;
            }
        }

        Console.WriteLine();
        Console.WriteLine($"Summary: {passed} passed, {failed} failed, {missing} missing, {skipped} skipped");
        return (failed + missing) > 0 ? 1 : 0;
    }

    private static int RunUpdate(List<ClusterConfig> clusters, string projectRoot, string? clusterFilter, string? reason)
    {
        if (string.IsNullOrEmpty(clusterFilter))
        {
            Console.Error.WriteLine("❌ update requires --cluster <id>");
            return 1;
        }

        var regretDir = Path.Combine(projectRoot, "regrets");
        var auditLogPath = Path.Combine(regretDir, "audit.log");

        Console.WriteLine($"📝 Updating {clusterFilter} (reason: {reason ?? "<none>"})...");

        var result = RunCapture(clusters.Where(c => c.Id == clusterFilter).ToList(), projectRoot);

        // Append to audit.log
        try
        {
            var reasonStr = reason ?? "<none>";
            var entry = $"[{DateTime.UtcNow:yyyy-MM-ddTHH:mm:ss.fffffffZ}] UPDATE cluster={clusterFilter} reason={reasonStr}";
            File.AppendAllText(auditLogPath, entry + Environment.NewLine);
            Console.WriteLine($"   📒 Appended audit entry: {auditLogPath}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"   ⚠️  Failed to append audit log: {ex.Message}");
        }

        return result;
    }

    // ─── Invocation via reflection ─────────────────────────────────────────────

    /// <summary>
    /// Invoke a cluster's entry method with each input from the manifest and
    /// return the first (input, output, fingerprint) tuple. Multiple inputs are
    /// not yet supported for fingerprinting — only the first is captured.
    /// (TODO: support multiple inputs like JS/Python.)
    /// </summary>
    private static (object? input, object? output, string fingerprint) InvokeCluster(
        ClusterConfig cluster, string projectRoot)
    {
        if (string.IsNullOrEmpty(cluster.Assembly))
        {
            throw new InvalidOperationException(
                $"Cluster '{cluster.Id}' is missing required field 'assembly' (path to .dll).");
        }

        if (cluster.Inputs == null || cluster.Inputs.Count == 0)
        {
            throw new InvalidOperationException(
                $"Cluster '{cluster.Id}' has no inputs defined in manifest.");
        }

        // Resolve assembly path relative to project root
        var asmPath = Path.IsPathRooted(cluster.Assembly)
            ? cluster.Assembly
            : Path.Combine(projectRoot, cluster.Assembly);

        if (!File.Exists(asmPath))
        {
            throw new FileNotFoundException(
                $"Assembly not found for cluster '{cluster.Id}': {asmPath}. " +
                "Make sure the project is built (e.g., `dotnet build`).", asmPath);
        }

        // Load assembly
        Assembly asm;
        try
        {
            asm = Assembly.LoadFrom(asmPath);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                $"Failed to load assembly '{asmPath}' for cluster '{cluster.Id}': {ex.Message}", ex);
        }

        // Resolve class type
        var className = string.IsNullOrEmpty(cluster.ClassName) ? "Program" : cluster.ClassName;
        var type = asm.GetType(className);
        if (type == null)
        {
            // Try searching all types for a match by simple name
            var allTypes = asm.GetTypes();
            var match = allTypes.FirstOrDefault(t =>
                t.FullName == className ||
                t.Name == className ||
                t.FullName?.EndsWith("." + className, StringComparison.Ordinal) == true);
            if (match == null)
            {
                throw new InvalidOperationException(
                    $"Type '{className}' not found in assembly '{asmPath}' for cluster '{cluster.Id}'. " +
                    $"Available types: {string.Join(", ", allTypes.Take(20).Select(t => t.FullName))}");
            }
            type = match;
        }

        // Resolve entry method
        var method = type.GetMethod(cluster.Entry,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance);
        if (method == null)
        {
            throw new InvalidOperationException(
                $"Method '{cluster.Entry}' not found on type '{type.FullName}' for cluster '{cluster.Id}'. " +
                $"Available public methods: {string.Join(", ", type.GetMethods().Select(m => m.Name))}");
        }

        // Take first input
        var inputElement = cluster.Inputs[0];
        var inputObj = ConvertJsonElement(inputElement);

        // Build parameter array
        var parameters = method.GetParameters();
        object?[] args;
        if (parameters.Length == 0)
        {
            args = Array.Empty<object?>();
        }
        else if (parameters.Length == 1)
        {
            args = new[] { ConvertToParameterType(inputObj, parameters[0].ParameterType) };
        }
        else
        {
            // If input is array, spread across params; otherwise error
            if (inputObj is IList list && list.Count == parameters.Length)
            {
                args = new object?[parameters.Length];
                for (int i = 0; i < parameters.Length; i++)
                {
                    args[i] = ConvertToParameterType(list[i], parameters[i].ParameterType);
                }
            }
            else
            {
                throw new InvalidOperationException(
                    $"Method '{cluster.Entry}' on '{type.FullName}' expects {parameters.Length} parameters, " +
                    $"but input is not an array of matching length. Provide an array input in the manifest.");
            }
        }

        // Create instance if instance method
        object? instance = null;
        if (!method.IsStatic)
        {
            try
            {
                instance = Activator.CreateInstance(type);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    $"Method '{cluster.Entry}' is an instance method but failed to create instance of '{type.FullName}': {ex.Message}. " +
                    "Either make the method static, or provide a parameterless constructor.", ex);
            }
        }

        // Invoke
        object? output;
        try
        {
            output = method.Invoke(instance, args);
        }
        catch (TargetInvocationException tie)
        {
            throw new InvalidOperationException(
                $"Method '{cluster.Entry}' on '{type.FullName}' threw: {tie.InnerException?.Message ?? tie.Message}",
                tie.InnerException ?? tie);
        }

        // Compute fingerprint
        var hash = Fingerprint.Compute(inputObj, output);
        return (inputObj, output, hash);
    }

    // ─── JSON element → object conversion ──────────────────────────────────────

    private static object? ConvertJsonElement(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                return null;
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.String:
                return element.GetString();
            case JsonValueKind.Number:
                if (element.TryGetInt64(out var l))
                {
                    if (l >= int.MinValue && l <= int.MaxValue) return (int)l;
                    return l;
                }
                if (element.TryGetDouble(out var d)) return d;
                return element.GetRawText();
            case JsonValueKind.Array:
                var list = new List<object?>();
                foreach (var item in element.EnumerateArray())
                {
                    list.Add(ConvertJsonElement(item));
                }
                return list;
            case JsonValueKind.Object:
                var dict = new Dictionary<string, object?>();
                foreach (var prop in element.EnumerateObject())
                {
                    dict[prop.Name] = ConvertJsonElement(prop.Value);
                }
                return dict;
            default:
                return element.GetRawText();
        }
    }

    private static object? ConvertToParameterType(object? value, Type targetType)
    {
        if (value == null)
        {
            return targetType.IsValueType ? Activator.CreateInstance(targetType) : null;
        }

        var srcType = value.GetType();

        // Direct assignment when types match
        if (targetType.IsAssignableFrom(srcType))
        {
            return value;
        }

        // Handle nullable<T>
        var underlying = Nullable.GetUnderlyingType(targetType);
        if (underlying != null)
        {
            return ConvertToParameterType(value, underlying);
        }

        // Numeric conversions
        if (value is IConvertible)
        {
            try
            {
                return Convert.ChangeType(value, targetType, CultureInfo.InvariantCulture);
            }
            catch
            {
                // fall through to JSON round-trip
            }
        }

        // Complex types — round-trip via JSON
        var json = JsonSerializer.Serialize(value, JsonOpts);
        return JsonSerializer.Deserialize(json, targetType, JsonOpts);
    }

    // ─── Trivial output guard ──────────────────────────────────────────────────

    private static bool ShouldSkip(object? output)
    {
        if (output == null) return true;
        if (output is string s && string.IsNullOrEmpty(s)) return true;
        if (output is IList list && list.Count == 0) return true;
        if (output is IDictionary dict && dict.Count == 0) return true;
        return false;
    }

    // ─── .regret file serialization ────────────────────────────────────────────

    private static string SerializeRegret(RegretFile regret)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"cluster: {regret.Cluster}");
        sb.AppendLine($"version: {regret.Version}");
        sb.AppendLine($"fingerprint: {regret.Fingerprint}");
        sb.AppendLine($"captured: {regret.Captured}");
        sb.AppendLine($"entry: {regret.Entry}");
        sb.AppendLine($"stack: {regret.Stack}");
        if (!string.IsNullOrEmpty(regret.ClassName))
            sb.AppendLine($"class: {regret.ClassName}");
        if (!string.IsNullOrEmpty(regret.Assembly))
            sb.AppendLine($"assembly: {regret.Assembly}");
        sb.AppendLine($"fingerprintLevel: entry");
        sb.AppendLine("---");
        sb.AppendLine($"INPUT  {regret.Input}");
        sb.AppendLine($"OUTPUT {regret.Output}");
        sb.AppendLine($"HASH   {regret.Hash}");
        return sb.ToString();
    }

    private static RegretFile ParseRegret(string content)
    {
        var regret = new RegretFile();
        var lines = content.Split('\n');
        var pastSeparator = false;

        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd('\r');
            if (string.IsNullOrEmpty(line)) continue;

            if (line == "---")
            {
                pastSeparator = true;
                continue;
            }

            if (!pastSeparator)
            {
                var idx = line.IndexOf(':');
                if (idx < 0) continue;
                var key = line[..idx].Trim();
                var value = line[(idx + 1)..].Trim();
                switch (key)
                {
                    case "cluster": regret.Cluster = value; break;
                    case "version": regret.Version = int.TryParse(value, out var v) ? v : 1; break;
                    case "fingerprint": regret.Fingerprint = value; break;
                    case "captured": regret.Captured = value; break;
                    case "entry": regret.Entry = value; break;
                    case "stack": regret.Stack = value; break;
                    case "class": regret.ClassName = value; break;
                    case "assembly": regret.Assembly = value; break;
                }
            }
            else
            {
                // INPUT / OUTPUT / HASH lines
                if (line.StartsWith("INPUT  ", StringComparison.Ordinal))
                    regret.Input = line["INPUT  ".Length..];
                else if (line.StartsWith("OUTPUT ", StringComparison.Ordinal))
                    regret.Output = line["OUTPUT ".Length..];
                else if (line.StartsWith("HASH   ", StringComparison.Ordinal))
                    regret.Hash = line["HASH   ".Length..];
            }
        }

        return regret;
    }
}
