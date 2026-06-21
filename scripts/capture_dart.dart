// capture_dart.dart — ghost-runner for Dart clusters
//
// Reads regrets/manifest.json, filters clusters with stack: "dart",
// invokes the entry function with each declared inputs[] value,
// computes the fingerprint (IDENTICAL algorithm to fingerprint.js / .py),
// and writes a .regret file with the standard format:
//
//   cluster: <id>
//   version: 1
//   fingerprint: <7char>
//   captured: <ISO8601>
//   watches: [fn1, fn2]
//   entry: <entry>
//   stack: dart
//   fingerprintLevel: entry
//   ---
//   INPUT  <json>
//   OUTPUT <json>
//   HASH   <7char>
//
// Usage:
//   dart run scripts/capture_dart.dart
//   dart run scripts/capture_dart.dart --cluster my-cluster
//   dart run scripts/capture_dart.dart --manifest ./regrets/manifest.json
//
// Design notes:
//
// Dart doesn't have a JS Proxy equivalent that can transparently intercept
// arbitrary method calls on an existing instance. So unlike capture.js (which
// uses the Ghost Proxy pattern), we follow the same approach as capture_php.php:
//
//   - The cluster's entry function is invoked directly via dynamic dispatch.
//   - The fingerprint is based on entry-level input -> output only
//     (fingerprintLevel: 'entry'). Callee-level capture is NOT supported
//     in this v1 — same limitation as PHP, Go, Rust, C, C++, etc.
//   - Trivial-output guard: if output is null/NaN/empty string/list/map,
//     OR if invocation throws, the cluster is SKIPPED (not written).
//
// This matches the architecture pattern of all non-JS / non-Python stacks
// in the repo — see CONTEXT.md "Callee Contract" for the rationale.

import 'dart:convert';
import 'dart:io';
import 'dart:mirrors';

import 'fingerprint_dart.dart';

// ─── Manifest-aware entry-point invocation ───────────────────────────────────
// dart:mirrors can reflect on libraries already loaded into the current
// isolate, but loading an arbitrary file path at runtime requires either:
//   (a) a Uri-based lookup in currentMirrorSystem().libraries — which only
//       works if the file has already been imported by some other code path,
//       OR
//   (b) generating a temporary harness file that imports the target file
//       and exposes its top-level symbols, then spawning it as a separate
//       process and parsing JSON output.
//
// We use approach (b) because it works for ANY file path the manifest
// declares, without requiring the user to pre-import anything. The harness
// imports the target file by absolute path, looks up the entry symbol via
// dart:mirrors (now safe because the import makes the library load), invokes
// it with the recorded input, and prints the result as JSON to stdout.
//
// Communication protocol (capture harness → parent process):
//   Line 1: "REGRET_OUTPUT <json-encoded-output>"
//   Line 2 (if thrown): "REGRET_ERROR <error-message>"
//   Line 3 (always): "REGRET_DONE"
//
// Trivial-output guard: parent checks the output before computing fingerprint.

// ─── CLI args ─────────────────────────────────────────────────────────────────

({String? clusterFilter, String manifestPath}) _parseArgs(List<String> args) {
  String? clusterFilter;
  String? manifestPath;
  var i = 0;
  while (i < args.length) {
    if (args[i] == '--cluster' && i + 1 < args.length) {
      clusterFilter = args[++i];
    } else if (args[i] == '--manifest' && i + 1 < args.length) {
      manifestPath = args[++i];
    }
    i++;
  }
  manifestPath ??= '${Directory.current.path}/regrets/manifest.json';
  return (clusterFilter: clusterFilter, manifestPath: manifestPath);
}

// ─── Manifest model ───────────────────────────────────────────────────────────

class Cluster {
  final String id;
  final String entry;
  final List<String> watches;
  final String? file;
  final String? libraryUri;
  final List<Object?> inputs;
  final List<String> normalizeRules;
  final List<String> ignoreFields;
  final String fingerprintLevel;
  final String? fingerprintMode;
  final List<String> valuePaths;
  final bool multiArgs;

  Cluster(Map<String, dynamic> m)
      : id = m['id'] as String,
        entry = m['entry'] as String,
        watches = ((m['watches'] ?? []) as List).cast<String>(),
        file = m['file'] as String?,
        libraryUri = m['libraryUri'] as String?,
        inputs = ((m['inputs'] ?? [null]) as List).cast<Object?>(),
        normalizeRules =
            ((m['normalize'] ?? []) as List).cast<String>(),
        ignoreFields =
            ((m['ignoreFields'] ?? []) as List).cast<String>(),
        fingerprintLevel = (m['fingerprintLevel'] ?? 'entry') as String,
        fingerprintMode = m['fingerprintMode'] as String?,
        valuePaths = ((m['valuePaths'] ?? []) as List).cast<String>(),
        multiArgs = (m['multiArgs'] ?? false) as bool;
}

// ─── Temporary harness generator ──────────────────────────────────────────────
// dart:mirrors cannot resolve a library by file path that hasn't been
// imported yet. So we generate a small temporary Dart file that imports
// the target file, looks up the entry symbol, invokes it with the recorded
// input (passed as JSON via env var REGRET_INPUT), and prints the output
// as JSON to stdout.
//
// The harness is spawned as a child process via `dart run`, parses its
// stdout, and returns the output.

String _harnessCode(Cluster c, String targetAbsPath) {
  final targetUri = Uri.file(targetAbsPath).toString();
  // Use raw string + manual concatenation to avoid escaping nightmares
  // with $ and \${} inside Dart string interpolation.
  final parts = <String>[
    "// AUTO-GENERATED by capture_dart.dart — do not edit.",
    "// Imports the target file by absolute path and invokes the entry function.",
    "import 'dart:convert';",
    "import 'dart:io';",
    "import 'dart:mirrors';",
    "import '$targetUri';",
    "",
    "void main(List<String> args) {",
    "  final inputJson = Platform.environment['REGRET_INPUT'];",
    "  final multiArgs = Platform.environment['REGRET_MULTIARGS'] == 'true';",
    "  Object? input;",
    "  if (inputJson != null && inputJson.isNotEmpty) {",
    "    input = jsonDecode(inputJson);",
    "  }",
    "",
    "  // Find the library that owns the entry symbol.",
    "  final entrySymbol = MirrorSystem.getSymbol('${c.entry}');",
    "  LibraryMirror? lib;",
    "  for (final l in currentMirrorSystem().libraries.values) {",
    "    final d = l.declarations[entrySymbol];",
    "    if (d is MethodMirror && d.isRegularMethod) {",
    "      lib = l;",
    "      break;",
    "    }",
    "  }",
    "  if (lib == null) {",
    "    stderr.writeln('REGRET_ERROR entry function ${c.entry} not found in any loaded library');",
    "    stderr.writeln('REGRET_DONE');",
    "    exit(2);",
    "  }",
    "",
    "  try {",
    "    Object? output;",
    "    if (multiArgs && input is List) {",
    "      final args = input.cast<Object?>().toList();",
    "      output = lib.invoke(entrySymbol, args).reflectee;",
    "    } else {",
    "      output = lib.invoke(entrySymbol, [input]).reflectee;",
    "    }",
    "    stdout.writeln('REGRET_OUTPUT ' + jsonEncode(output));",
    "    stderr.writeln('REGRET_DONE');",
    "  } catch (e, st) {",
    "    stderr.writeln('REGRET_ERROR ' + e.toString());",
    "    stderr.writeln('REGRET_DONE');",
    "    exit(1);",
    "  }",
    "}",
  ];
  return parts.join('\n') + '\n';
}

Future<({Object? output, String? error})> _invokeViaHarness(
  Cluster c,
  Object? input,
  String targetAbsPath,
) async {
  final harnessDir = Directory.systemTemp.createTempSync('regret_dart_harness_');
  final harnessPath = '${harnessDir.path}/harness.dart';
  File(harnessPath).writeAsStringSync(_harnessCode(c, targetAbsPath));

  try {
    final inputJson = jsonEncode(input);
    final result = await Process.run(
      'dart',
      ['run', '--enable-asserts', harnessPath],
      environment: {
        'REGRET_INPUT': inputJson,
        'REGRET_MULTIARGS': c.multiArgs ? 'true' : 'false',
      },
      // Run from the same dir as the parent so relative imports in target
      // file resolve correctly.
      workingDirectory: Directory.current.path,
    );

    final stdout = result.stdout as String;
    final stderr = result.stderr as String;

    // Parse stdout for REGRET_OUTPUT line
    String? outputLine;
    for (final line in stdout.split('\n')) {
      if (line.startsWith('REGRET_OUTPUT ')) {
        outputLine = line.substring('REGRET_OUTPUT '.length);
        break;
      }
    }

    if (outputLine != null) {
      try {
        final output = jsonDecode(outputLine);
        return (output: output, error: null);
      } catch (_) {
        // Output wasn't valid JSON — return as string
        return (output: outputLine, error: null);
      }
    }

    // Parse stderr for REGRET_ERROR
    for (final line in stderr.split('\n')) {
      if (line.startsWith('REGRET_ERROR ')) {
        return (output: null, error: line.substring('REGRET_ERROR '.length));
      }
    }

    return (
      output: null,
      error: 'harness produced no output. stderr: ${stderr.trim()}',
    );
  } finally {
    harnessDir.deleteSync(recursive: true);
  }
}

// ─── Run a single cluster ────────────────────────────────────────────────────

Future<bool> runCluster(Cluster c, String outDir) async {
  stdout.writeln('\n📡 Capturing: ${c.id}');
  stdout.writeln('   File:       ${c.file ?? "(none)"}');
  stdout.writeln('   LibraryUri: ${c.libraryUri ?? "(none)"}');
  stdout.writeln('   Entry:      ${c.entry}');
  stdout.writeln('   Watches:    ${c.watches.join(", ")}');
  stdout.writeln('   Inputs:     ${c.inputs.length} case(s)');

  if (c.file == null && c.libraryUri == null) {
    stdout.writeln('   ❌ Cluster requires either "file" or "libraryUri".');
    return false;
  }

  // Resolve target file to absolute path
  final targetAbsPath = c.file != null
      ? '${Directory.current.path}/${c.file}'
      : c.libraryUri!;

  if (c.file != null && !File(targetAbsPath).existsSync()) {
    stdout.writeln('   ❌ Target file not found: $targetAbsPath');
    return false;
  }

  try {
    final results = <Map<String, Object?>>[];
    var skippedTrivial = 0;

    for (final input in c.inputs) {
      // Deep-clone input BEFORE invocation to prevent mutation from
      // affecting the recorded fingerprint (matches JS/Python contract).
      final inputForRecord = deepClone(input);

      final res = await _invokeViaHarness(c, input, targetAbsPath);
      if (res.error != null) {
        stdout.writeln('   ⚠️  Invocation threw for input $input: ${res.error}');
        // Trivial-output guard: throws → skip this input case
        skippedTrivial++;
        continue;
      }

      final output = res.output;

      // Trivial-output guard
      if (isTrivialOutput(output)) {
        stdout.writeln('   ⚠️  Trivial output for input $input — skipping this case.');
        skippedTrivial++;
        continue;
      }

      // Compute fingerprint
      final fp = fingerprint(
        inputForRecord,
        output,
        rules: c.normalizeRules,
        ignoreFields: c.ignoreFields,
      );

      results.add({
        'input': inputForRecord,
        'output': output,
        'fp': fp,
      });
    }

    if (results.isEmpty) {
      stdout.writeln('   ❌ All input cases were trivial/threw — no .regret written.');
      return false;
    }

    // Use FIRST successful result as the golden (matches capture.js behavior)
    final golden = results.first;
    final fp = golden['fp'] as String;

    // Write .regret file
    final regretPath = '$outDir/${c.id}.regret';
    final timestamp = DateTime.now().toUtc().toIso8601String();

    final lines = <String>[
      'cluster: ${c.id}',
      'version: 1',
      'fingerprint: $fp',
      'captured: $timestamp',
      'watches: [${c.watches.join(", ")}]',
      'entry: ${c.entry}',
      'stack: dart',
      'fingerprintLevel: ${c.fingerprintLevel}',
      if (c.fingerprintMode != null) 'fingerprintMode: ${c.fingerprintMode}',
      if (c.valuePaths.isNotEmpty) 'valuePaths: [${c.valuePaths.join(", ")}]',
      if (c.normalizeRules.isNotEmpty)
        'normalize: [${c.normalizeRules.join(", ")}]',
      if (c.ignoreFields.isNotEmpty)
        'ignoreFields: [${c.ignoreFields.join(", ")}]',
      if (c.multiArgs) 'multiArgs: true',
      if (c.file != null) 'file: ${c.file}',
      if (c.libraryUri != null) 'libraryUri: ${c.libraryUri}',
      '---',
      'INPUT  ${json.encode(golden['input'])}',
      'OUTPUT ${json.encode(golden['output'])}',
      'HASH   $fp',
    ];

    File(regretPath).writeAsStringSync(lines.join('\n'));

    stdout.writeln('   ✅ Fingerprint: $fp');
    stdout.writeln('   📄 Saved: regrets/${c.id}.regret');
    if (skippedTrivial > 0) {
      stdout.writeln('   ℹ️  $skippedTrivial trivial/threw case(s) skipped.');
    }
    return true;
  } catch (e, st) {
    stdout.writeln('   ❌ Capture failed: $e');
    stdout.writeln('   $st');
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

Future<void> main(List<String> argv) async {
  final args = _parseArgs(argv);

  // Load manifest
  final manifestFile = File(args.manifestPath);
  if (!manifestFile.existsSync()) {
    stderr.writeln('❌ Could not read manifest: ${args.manifestPath}');
    stderr.writeln('   Create regrets/manifest.json first. See SKILL.md for format.');
    exit(1);
  }

  late final Map<String, dynamic> manifest;
  try {
    manifest = json.decode(manifestFile.readAsStringSync()) as Map<String, dynamic>;
  } catch (e) {
    stderr.writeln('❌ Invalid JSON in manifest: ${args.manifestPath}');
    exit(1);
  }

  final clustersRaw = (manifest['clusters'] as List?) ?? [];
  var clusters = clustersRaw
      .map((c) => Cluster(c as Map<String, dynamic>))
      .where((c) => true) // all stacks; we filter to dart below
      .toList();

  // Filter: only dart stack, plus optional --cluster id filter
  clusters = clusters
      .where((c) {
        // We can't read the raw 'stack' field from Cluster (not modeled) — re-check raw
        return true;
      })
      .toList();

  // Re-filter from raw manifest to respect stack: "dart"
  final dartClustersRaw = clustersRaw
      .where((c) => (c as Map<String, dynamic>)['stack'] == 'dart')
      .toList();
  clusters = dartClustersRaw.map((c) => Cluster(c as Map<String, dynamic>)).toList();

  if (args.clusterFilter != null) {
    clusters = clusters.where((c) => c.id == args.clusterFilter).toList();
  }

  if (clusters.isEmpty) {
    stdout.writeln('No Dart clusters found in manifest.'
        '${args.clusterFilter != null ? ' (filter: "${args.clusterFilter}")' : ''}');
    exit(0);
  }

  // Ensure output dir exists
  final outDir = '${Directory.current.path}/regrets';
  Directory(outDir).createSync(recursive: true);

  var passed = 0;
  var failed = 0;
  for (final c in clusters) {
    if (await runCluster(c, outDir)) {
      passed++;
    } else {
      failed++;
    }
  }

  // Summary
  stdout.writeln('\n${"─" * 50}');
  stdout.writeln('Dart capture complete: $passed captured, $failed failed');
  if (failed > 0) {
    stdout.writeln('\n⚠️  Fix failed captures before proceeding to PHASE 2.');
    exit(1);
  }
  stdout.writeln('\nNext: dart run scripts/validate_dart.dart');
  stdout.writeln('If all green → you are clear to refactor.');
}
