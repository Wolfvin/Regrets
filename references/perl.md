# Perl Stack — Regrets Capture & Validate

This document describes how to use Regrets with Perl codebases. For the
general Regrets workflow (capture → refactor → validate), see
[`README.md`](../README.md) and [`SKILL.md`](../SKILL.md).

## Prerequisites

- **Perl 5.14 or newer** (5.40+ recommended). Perl is pre-installed on
  most Linux distros and macOS. On Windows, install
  [Strawberry Perl](https://strawberryperl.com/) or
  [ActivePerl](https://www.activestate.com/products/perl/).

- **Core modules** (bundled with Perl since 5.14, no CPAN install needed):
  - `JSON::PP` — JSON encode/decode
  - `Digest::SHA` — SHA-256 hashing
  - `Math::BigInt` — large integer arithmetic (SHA-256 hashes exceed 64-bit)

  Verify they're available:

  ```sh
  perl -MJSON::PP -MDigest::SHA -MMath::BigInt -e 'print "all ok\n"'
  ```

## Quick start

```sh
# 1. Create regrets/manifest.json in your Perl project root
cat > regrets/manifest.json << 'EOF'
{
  "clusters": [{
    "id": "my-fn",
    "entry": "my_function",
    "file": "lib/MyModule.pm",
    "stack": "perl",
    "multiArgs": true,
    "inputs": [[1, 2], [3, 4]],
    "watches": ["my_function"]
  }]
}
EOF

# 2. Capture (writes regrets/my-fn.regret)
perl scripts/capture_perl.pl

# 3. Refactor your Perl code freely (rename vars, extract helpers, etc.)
#    ...edit lib/MyModule.pm...

# 4. Validate (PASS = refactor preserved behavior, FAIL = behavior changed)
perl scripts/validate_perl.pl
```

## Manifest fields for Perl clusters

| Field | Required | Description |
|---|---|---|
| `id` | yes | Cluster identifier. Becomes `<id>.regret` filename. |
| `entry` | yes | Subroutine name. Can be unqualified (`foo`) or fully-qualified (`Package::foo`). |
| `file` | one of | Path to `.pm` file, e.g. `lib/MyModule.pm`. The file will be `require`'d. |
| `module` | one of | Module name, e.g. `MyModule` or `Some::Package`. Use this instead of `file` if the module is already in `@INC`. |
| `libPath` | optional | Directory to add to `@INC` before `require`-ing `module`. e.g. `"lib"`. |
| `stack` | yes | Must be `"perl"`. |
| `inputs` | yes | Array of input values. Each input is invoked separately (only the first becomes the golden contract — multi-input support is planned). |
| `multiArgs` | optional | If `true`, each input is treated as an **array of positional args**. If `false` (default), each input is a single arg. |
| `watches` | optional | Informational. Lists functions whose calls the regret tracks. |
| `description` | optional | Human-readable description. |

### Choosing `file` vs `module` vs `libPath`

- **`file: "lib/MyModule.pm"`** — Most common. Use when your module lives at
  a known path relative to the project root. Regrets adds the file's parent
  directory to `@INC` automatically and `require`s the module.

  Example:
  ```json
  { "file": "lib/MyModule.pm", "entry": "foo" }
  ```

- **`module: "MyModule"`** — Use when the module is already installed in
  `@INC` (e.g. a CPAN module, or your project's `lib/` is already in
  `PERL5LIB`).

  Example:
  ```json
  { "module": "List::Util", "entry": "sum" }
  ```

- **`module: "MyModule", "libPath": "lib"`** — Use when the module is in a
  project-local `lib/` directory that isn't in `@INC` by default.

  Example:
  ```json
  { "module": "MyModule", "libPath": "lib", "entry": "foo" }
  ```

## Subroutine invocation

Regrets invokes the entry subroutine via a coderef:

```perl
my $coderef = \&{ $loaded_module . '::' . $entry };
my @args = $multi_args ? @$input : ($input);
my $output = $coderef->(@args);
```

### Supported patterns

| Pattern | Works? | Example |
|---|---|---|
| Top-level `sub foo {}` in a package | ✅ | `package MyModule; sub foo { ... }` |
| Exported subroutines (`use Exporter`) | ✅ | `our @EXPORT_OK = qw(foo);` |
| Fully-qualified entry | ✅ | `"entry": "Other::Package::foo"` |
| Nested package file path + unqualified entry | ✅ | `"file": "lib/Foo/Bar.pm"`, `"entry": "greet"` → resolves to `Foo::Bar::greet` (parsed from the file's `package` declaration) |
| `module` field (with or without `libPath`) | ✅ | `"module": "TextTools"`, `"libPath": "lib"` → `require TextTools.pm` after `::`→`/` conversion |
| `multiArgs: true` (multiple positional args) | ✅ | `"inputs": [[1, 2, 3]]` → `foo(1, 2, 3)` |
| Single arg (no `multiArgs`) | ✅ | `"inputs": [5]` → `foo(5)` |
| No args (`inputs: []` or input is `null`) | ✅ | `foo()` |
| Object method calls (`$obj->method`) | ❌ | Use a wrapper sub |
| Closures / anonymous subs | ❌ | Use a named sub |
| Functions that modify `@_` in place | ⚠️ | The input snapshot is taken before invocation, so the golden hash is preserved, but the live re-run during validate sees the same input. |

> **Package name resolution:** When using `file:`, Regrets reads the `.pm`
> file's `package XYZ;` declaration to determine which package the entry
> subroutine lives in. This means `lib/Foo/Bar.pm` declaring
> `package Foo::Bar;` works correctly with unqualified `entry: "greet"`
> (resolves to `Foo::Bar::greet`). If the file has no `package` declaration,
> Regrets falls back to deriving the package name from the path (strip
> extension, replace `/` with `::`).

### Return value handling

The subroutine's return value is captured via:

```perl
my $output = $coderef->(@args);
```

Perl's return value semantics:
- Scalar context: the last evaluated expression
- The coderef is called in scalar context by default

If your function returns a list that should be fingerprinted as an array,
return an arrayref:

```perl
# Returns a list — Regrets will see the last element only (scalar context)
sub bad { return (1, 2, 3); }

# Returns an arrayref — Regrets will fingerprint [1, 2, 3]
sub good { return [1, 2, 3]; }
```

## .regret file format

Identical to the JS/Python stacks. Sample:

```
cluster: my-fn
version: 1
fingerprint: 13mxb0z
captured: 2026-06-20T18:01:18.000000+00:00
watches: [my_function]
entry: my_function
stack: perl
fingerprintLevel: entry
multiArgs: true
file: lib/MyModule.pm
---
INPUT  [2,3]
OUTPUT 5
HASH   13mxb0z
```

### Cross-stack compatibility

A `.regret` file written by `capture_perl.pl` can be validated by:
- `perl scripts/validate_perl.pl` (Perl)
- `node scripts/validate.js` (JS) — but JS validate won't know how to
  invoke a Perl function, so it will FAIL with "cannot find module".
- `python scripts/validate.py` (Python) — same caveat.

The fingerprint algorithm is identical across stacks (verified by
`fingerprint_perl.pl`'s self-test, which checks against the JS reference
values). So a `.regret` file's `HASH` field is meaningful regardless of
which stack created it — the limitation is only that the validator needs
to be able to re-invoke the function in its own language.

## Cross-stack fingerprint verification

`fingerprint_perl.pl` includes a self-test that verifies its output matches
the JS reference fingerprints exactly:

```sh
$ perl scripts/fingerprint_perl.pl
=== fingerprint_perl.pl self-test ===
Cross-stack verification against fingerprint.js reference values:

  [PASS] string input/output
    expected: 67q5v7m
    got:      67q5v7m
  [PASS] numeric input/output
    expected: 3gpqqch
    got:      3gpqqch
  ...

ALL PASS — Perl fingerprint matches JS reference
```

If this self-test ever FAILs, the Perl stack is broken — do not use it
until the divergence is fixed.

## End-to-end verification

Run the self-contained verification script to confirm the entire Perl
stack (capture + validate + breaking-change detection + non-breaking
refactor tolerance) works end-to-end:

```sh
bash scripts/verify_perl_stack.sh
```

This creates a temporary Perl project, captures, validates, mutates
(breaking + non-breaking), and reports results. Exit code 0 = all checks
passed; non-zero = something is broken.

## Limitations

- **Single input capture**: only the first input in `inputs[]` becomes the
  golden contract. Multi-input support (the `INPUTS` line in .regret files,
  issue #315) is not yet implemented for the Perl stack. Workaround: define
  one cluster per input if you need to test multiple inputs.

- **No callee wrapping**: the JS/Python stacks support ghost-proxy callee
  interception (re-validate functions called by the entry function). The
  Perl stack does not yet support this — only the entry function's
  output is fingerprinted.

- **No normalize rules**: the `normalize` field in the manifest (for
  timestamps, UUIDs, etc.) is parsed but not yet applied. Perl functions
  that return non-deterministic values (timestamps, random numbers) will
  produce false FAILs. Workaround: wrap the function to mask
  non-deterministic output.

- **Scalar context only**: the entry function is called in scalar context.
  Functions that return lists should return an arrayref instead.

## Troubleshooting

### "Cannot find subroutine foo in MyModule"

The `entry` field doesn't match a sub in the loaded module. Check:
1. The sub is defined in the package (not just exported by another package).
2. The spelling matches (case-sensitive).
3. If using `file:`, the file's `package` declaration matches the expected module name.

### "Use of uninitialized value" warnings

This usually means your function expects multiple args but the manifest
doesn't have `multiArgs: true`. Without `multiArgs`, each input is passed
as a single arg, so `sub foo { my ($a, $b) = @_; }` will see `$b` as undef.

Fix: set `"multiArgs": true` and make each input an array:
```json
{ "multiArgs": true, "inputs": [[2, 3]] }
```

### Cross-stack fingerprint mismatch

If `fingerprint_perl.pl`'s self-test FAILs, the Perl implementation has
diverged from the JS/Python reference. Check:
1. `stable_stringify` handles nested hashes/arrays correctly (keys sorted).
2. `to_base36` produces the same string as JS `BigInt.toString(36)`.
3. `JSON::PP` encodes numbers vs strings the same way as `JSON.stringify`.

Run the self-test with verbose output:
```sh
perl -e 'use lib "scripts"; require "fingerprint_perl.pl";' 2>&1
```

## See also

- [`scripts/fingerprint_perl.pl`](../scripts/fingerprint_perl.pl) — shared fingerprint module
- [`scripts/capture_perl.pl`](../scripts/capture_perl.pl) — capture CLI
- [`scripts/validate_perl.pl`](../scripts/validate_perl.pl) — validate CLI
- [`scripts/verify_perl_stack.sh`](../scripts/verify_perl_stack.sh) — end-to-end verification
- [`references/go.md`](go.md) — analogous doc for the Go stack
- [`README.md`](../README.md) — general Regrets documentation
