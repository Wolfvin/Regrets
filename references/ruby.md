# Ruby Stack — `regret capture` / `regret validate` for Ruby

This guide covers the Ruby stack adapter for Regrets. After reading this, you
will know how to capture behavioral fingerprints for Ruby functions and
validate them after refactoring.

## TL;DR

```bash
# 1. Write a manifest that names your Ruby functions + sample inputs.
#    See "Manifest schema" below.
$ cat regrets/manifest.json
{
  "clusters": [{
    "id": "slugify",
    "entry": "slugify",
    "watches": ["slugify"],
    "file": "lib/slugify.rb",
    "stack": "ruby",
    "inputs": ["Hello, World!", "Café résumé", ""]
  }]
}

# 2. Capture fingerprints — writes regrets/<id>.regret files.
ruby scripts/capture_ruby.rb

# 3. Validate after refactoring — compares live fingerprints to .regret files.
ruby scripts/validate_ruby.rb
```

All green? Ship it. Any red? Fix the code, not the `.regret` files.

## Manifest schema (Ruby-specific fields)

| Field             | Required | Description                                                                 |
|-------------------|----------|-----------------------------------------------------------------------------|
| `id`              | yes      | Cluster identifier, becomes `<id>.regret` filename.                         |
| `entry`           | yes      | Function to invoke. Three forms (see below).                                |
| `watches`         | yes      | Informational list of functions covered by this cluster.                   |
| `file`            | yes      | Path to the Ruby source file, relative to project root.                    |
| `stack`           | yes      | Must be `"ruby"`.                                                           |
| `inputs`          | yes      | Array of inputs. Each input is passed to `entry` (first input is golden).  |
| `multiArgs`       | no       | If `true`, array inputs are splatted as `entry(*input)` instead of `entry(input)`. |
| `constructorArgs` | no       | For `Class#method` entries: array of args to `Class.new(*constructorArgs)`. |
| `normalize`       | no       | Same rule names as JS/PHP/Python (`timestamps`, `uuids`, `floatTolerance`, etc.). |
| `ignoreFields`    | no       | Field names to strip from output before hashing.                            |
| `fingerprintLevel`| no       | `entry` (default) — only entry function's output is hashed.               |
| `fingerprintMode` | no       | `value` (default), `schema`, or `mixed`.                                    |
| `valuePaths`      | no       | For `mixed` mode: list of `$.path.to.field` selectors to extract.           |

### Entry forms

1. **Top-level function** — `"my_function"`
   The file is `require`'d, then `my_function(input)` is called. The function
   must be defined at the file's top level (`def my_function(...)`).

2. **Class method** — `"MyClass.my_method"`
   Calls `MyClass.my_method(input)`. The class must be defined after `require`-ing the file.

3. **Instance method** — `"MyClass#my_method"`
   Instantiates `MyClass.new(*constructorArgs)` (or `MyClass.new` if no
   `constructorArgs`), then calls `instance.my_method(input)`.

## The `.regret` file format

Identical to every other stack. Each `.regret` file is a human-readable,
git-diffable golden contract:

```
cluster: slugify
version: 1
fingerprint: 615ytfn
captured: 2026-06-20T17:43:33.852848Z
watches: [slugify]
entry: slugify
stack: ruby
fingerprintLevel: entry
file: lib/slugify.rb
---
INPUT  "Hello, World!"
OUTPUT "hello-world"
HASH   615ytfn
```

The `regrets/` folder is sacred — never edit `.regret` files manually after
they are green. If behavior legitimately changed, use `regret update
<id> --reason "..."` (see below).

## Fingerprint algorithm — cross-stack parity

Ruby uses the same fingerprint algorithm as JS, TypeScript, Python, and PHP:

```
fingerprint = base36(sha256(stableStringify(input) + '|' + stableStringify(output)))[0..6]
```

Where `stableStringify` is JSON with keys sorted recursively. This means the
SAME input/output pair produces the SAME 7-character hash in every stack.
Cross-stack parity is verified in `proof/ruby_slugify/PARITY.md`.

## CLI flags

### `capture_ruby.rb`

```
ruby scripts/capture_ruby.rb
ruby scripts/capture_ruby.rb --cluster <id>
ruby scripts/capture_ruby.rb --manifest ./regrets/manifest.json
```

### `validate_ruby.rb`

```
ruby scripts/validate_ruby.rb
ruby scripts/validate_ruby.rb --cluster <id>
ruby scripts/validate_ruby.rb --runs 5                 # drift detection
ruby scripts/validate_ruby.rb --fail-fast              # stop on first failure
ruby scripts/validate_ruby.rb --update <id> --reason "specific reason"
```

### Unified runner (recommended)

```
python3 scripts/regret.py capture          # auto-detects ruby from manifest
python3 scripts/regret.py validate
python3 scripts/regret.py update <id> --reason "..."
python3 scripts/regret.py drift            # 5-run drift detection
python3 scripts/regret.py ci               # fail-fast CI mode
```

Or via the JS runner:

```
node scripts/regret.js capture
node scripts/regret.js validate --fail-fast
```

## `regret update` — when behavior legitimately changes

If a refactor intentionally changes behavior (e.g., bug fix, new
requirement), use `update` to record a new golden fingerprint with an audit
trail:

```bash
ruby scripts/validate_ruby.rb --update slugify --reason "tax rate updated from 11% to 12% per new regulation"
```

The `--reason` text must be at least 4 words and specific. The previous
fingerprint is recorded in `regrets/audit.log` along with the reason,
forming a hash-chained audit trail.

## Ruby-specific notes

### `require` semantics

`capture_ruby.rb` and `validate_ruby.rb` use `require` (not `load`) to
load your source file. This means the file is loaded at most once per
process. Each invocation of `capture_ruby.rb` is a fresh process, so
edits between runs are picked up automatically.

### Symbols and `Hash` with symbol keys

Ruby `Hash` objects with symbol keys (`{foo: 1}`) are serialized with
string keys in the `.regret` file — this is the same convention used
by JS/PHP/Python. Symbols (`:foo`) are serialized as strings (`"foo"`).

### `Time` objects

`Time` instances are serialized as `{"__datetime__": "<iso8601>", "fold": 0}`.
This matches the Python `datetime` serialization, so cross-stack parity is
preserved for functions that return `Time` objects (e.g., parsers that
return a timestamp).

### Float vs Integer

Ruby distinguishes `1` from `1.0` — `JSON.generate(1)` produces `"1"`,
`JSON.generate(1.0)` produces `"1.0"`. This matches Python's behavior.
JS is the outlier (`JSON.stringify(1.0)` → `"1"`), so a Ruby function
returning `1.0` will produce a different fingerprint than an equivalent
JS function returning `1`. Use the `floatPrecision` normalize rule to
strip the trailing `.0` if you need cross-stack parity for whole-valued
floats.

### Callee wrapping (Phase 2)

Callee wrapping (`.calls.<callee>.regret` files) is not yet supported
for Ruby. This is a Phase 2 enhancement; for now, all fingerprints are
at `fingerprintLevel: entry` only.

## See also

- [`proof/ruby_slugify/`](../proof/ruby_slugify/) — working example with
  a real Ruby `slugify` function, including a `run_demo.sh` that walks
  through baseline → valid refactor → breaking refactor.
- [`proof/ruby_slugify/PARITY.md`](../proof/ruby_slugify/PARITY.md) —
  cross-stack hash parity table (same input/output → same hash in JS,
  PHP, Python, Ruby).
- [`SKILL.md`](../SKILL.md) — full Regrets skill spec (manifest schema,
  fingerprint algorithm, all rules).
- [`references/phases.md`](phases.md) — Phase 1 (AUDIT) → Phase 2
  (REFACTOR) → Phase 3 (VALIDATE) workflow.
