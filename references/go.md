# Go Stack Variant

Regression fingerprinting for Go projects using generated test files and `go test` capture.

## Status: Working — capture + validate implemented

Go stack support is now **working end-to-end** — both `capture_go.sh capture` and `capture_go.sh validate` generate and run real Go test files that invoke entry functions via reflection, compute cross-stack-compatible fingerprints, and write/compare `.regret` files. This is based on real-world testing against the `baris-inandi/bfgo` project (a Brainfuck compiler/interpreter in Go) and the built-in test fixture at `tests/fixtures/go-example/`.

**Verification:** run `bash scripts/verify_go_stack.sh` from the repo root to see a full end-to-end demo (capture → validate PASS for no-change and valid-refactor, FAIL for breaking change, plus cross-stack fingerprint parity with JS).

### What's implemented

- **Capture**: `bash scripts/capture_go.sh capture` generates `regrets/regret_helpers_test.go` + `regrets/regret_capture_test.go`, runs `go test`, writes `.regret` files for each cluster.
- **Validate**: `bash scripts/capture_go.sh validate` generates `regrets/regret_helpers_test.go` + `regrets/regret_validate_test.go`, re-invokes each entry function with the saved input, compares the live fingerprint to the golden, reports PASS/FAIL.
- **Single-cluster**: `bash scripts/capture_go.sh --cluster <id>` (capture) or `bash scripts/capture_go.sh validate --cluster <id>`.
- **Cross-stack parity**: Go fingerprints match JS fingerprints for the same input/output (verified for int, string, array, NaN/Inf sentinels).
- **Reflect-based invocation**: handles single-arg, multi-arg (`multiArgs: true`), and zero-arg functions via `reflect.Call`.
- **Partial capture (#318 parity)**: if one input throws, the cluster still captures with the remaining inputs (matching the JS stack's behavior).
- **INPUTS line**: multi-input clusters store additional results in an `INPUTS` line, and validate re-checks all of them.
- **NaN/Inf sentinels (#322 parity)**: Go `stableStringify` matches JS behavior for NaN → `"__nan__"`, +Inf → `"__infinity__"`, -Inf → `"__neg_infinity__"`.

### What's NOT yet implemented (deferred to follow-up PRs)

- **Callee contracts** (`<parent>.calls.<callee>.regret`): Go has no runtime Proxy, so callee wrapping requires test-generated recording wrappers — a larger feature.
- **expectThrow support**: Go capture doesn't yet read `{ __expectThrow: true, value: <input> }` input markers.

---

## Quick Start

1. Add `"stack": "go"` clusters to `regrets/manifest.json`
2. Create `regrets/` folder in your Go project root
3. Run `bash scripts/capture_go.sh` to generate and run capture tests
4. Run `bash scripts/capture_go.sh validate` to validate
5. All `.regret` files use identical format to JS stack

---

## Why Go Is Different

Go's design creates unique challenges for the Ghost Proxy pattern used in JS/Python:

| Challenge | JS/Python Approach | Go Reality |
|-----------|-------------------|------------|
| Function wrapping | Proxy / decorator | No runtime Proxy — must use explicit wrappers or interfaces |
| Dynamic imports | `import()` / `importlib` | Go requires compile-time imports; `go test` is the runner |
| Module loading | Any file at runtime | Must follow `go mod` conventions; package paths required |
| Test execution | `node script.js` | `go test` with specific package targeting |
| Unexported functions | Always accessible | Only accessible from same-package `_test.go` files |
| Methods on structs | Wrapped via Proxy | Need interface extraction or test-only wrappers |

---

## Equivalent of Ghost Proxy in Go

Go has no runtime Proxy like JavaScript. Instead, we use **test-generated recording wrappers** — a generated test file wraps function calls and records I/O before the function executes.

### Pattern: Test-Generated Recording

```go
// In the generated regret_capture_test.go

// recorder collects function call data (like JS ghost recorder)
var recorder []CallRecord

type CallRecord struct {
    FnName string
    Args   interface{}
    Result interface{}
}

// ghostWrap calls the real function, records I/O, returns result unchanged.
func ghostWrap(fnName string, fn func(...interface{}) interface{}, args ...interface{}) interface{} {
    result := fn(args...)
    recorder = append(recorder, CallRecord{
        FnName: fnName,
        Args:   args,
        Result: result,
    })
    return result
}
```

### Pattern: Interface Extraction (Recommended for Methods)

For functions that are methods on structs, extract the behavior into an interface:

```go
// ❌ BEFORE — method on struct, hard to fingerprint
type BfContext struct {
    tape [30000]byte
    ptr  uint16
}

func (ctx *BfContext) EvalExprWithContext(code string) {
    // complex logic with side effects (prints to stdout)
}

// ✅ AFTER — extract pure logic into standalone function
func EvalExprPure(code string, initialTape [30000]byte, initialPtr uint16) (string, [30000]byte, uint16) {
    // Pure computation — returns output string + final state
    // No side effects, deterministic for same input
}
```

---

## Fingerprint Algorithm — Cross-Stack Parity

The Go fingerprint implementation MUST produce identical results to JS/Python/Rust for the same input/output pair. The algorithm is:

```
1. stableStringify(input) + "|" + stableStringify(output) → combined string
2. sha256(combined) → hex string
3. BigInt(hex, 16).toString(36) → base36 string
4. Take first 7 characters
```

### Go Implementation

```go
package regrettest

import (
    "crypto/sha256"
    "encoding/json"
    "fmt"
    "math/big"
    "sort"
)

// stableStringify produces deterministic JSON with sorted keys.
// MUST match JS stableStringify() and Python stable_dumps() output exactly.
func stableStringify(obj interface{}) string {
    if obj == nil {
        return "null"
    }
    switch v := obj.(type) {
    case bool:
        if v { return "true" }
        return "false"
    case int:
        return fmt.Sprintf("%d", v)
    case int64:
        return fmt.Sprintf("%d", v)
    case float64:
        // Match JS Number.toString() behavior for consistency
        return fmt.Sprintf("%g", v)
    case string:
        b, _ := json.Marshal(v)
        return string(b)
    case []interface{}:
        parts := make([]string, len(v))
        for i, item := range v {
            parts[i] = stableStringify(item)
        }
        return "[" + joinStrings(parts, ",") + "]"
    case map[string]interface{}:
        keys := make([]string, 0, len(v))
        for k := range v {
            keys = append(keys, k)
        }
        sort.Strings(keys)
        parts := make([]string, len(keys))
        for i, k := range keys {
            kb, _ := json.Marshal(k)
            parts[i] = string(kb) + ":" + stableStringify(v[k])
        }
        return "{" + joinStrings(parts, ",") + "}"
    default:
        b, _ := json.Marshal(v)
        return string(b)
    }
}

func joinStrings(ss []string, sep string) string {
    result := ""
    for i, s := range ss {
        if i > 0 { result += sep }
        result += s
    }
    return result
}

func toBase36(n *big.Int) string {
    if n.Sign() == 0 { return "0" }
    chars := "0123456789abcdefghijklmnopqrstuvwxyz"
    base := big.NewInt(36)
    zero := big.NewInt(0)
    result := ""
    remainder := new(big.Int)
    temp := new(big.Int).Set(n)
    if temp.Sign() < 0 { temp.Abs(temp) }
    for temp.Cmp(zero) > 0 {
        temp.DivMod(temp, base, remainder)
        result = string(chars[int(remainder.Int64())]) + result
    }
    return result
}

// fingerprint computes the 7-char base36 hash.
// IDENTICAL to JS/Python/Rust: sha256(input|output) → base36 → first 7 chars.
func fingerprint(input interface{}, output interface{}) string {
    combined := stableStringify(input) + "|" + stableStringify(output)
    hash := sha256.Sum256([]byte(combined))
    hexStr := fmt.Sprintf("%x", hash)
    bigNum := new(big.Int)
    bigNum.SetString(hexStr, 16)
    b36 := toBase36(bigNum)
    if len(b36) >= 7 {
        return b36[:7]
    }
    return b36
}
```

### Cross-Stack Consistency Check

```
INPUT:  "2025-01-15T00:00:00"
OUTPUT: "15/01/2025"

Go:     stableStringify("2025-01-15T00:00:00") + "|" + stableStringify("15/01/2025")
        → sha256 → hex → big.Int → base36 → first 7 chars
        Result: yju9g9g  ✅ Same as JS/Python/Rust
```

Run `go test -run TestCrossStackParity` in the generated test file to verify.

---

## Manifest for Go Clusters

```json
{
  "clusters": [
    {
      "id": "to-valid-bf",
      "entry": "ToValidBF",
      "watches": ["ToValidBF"],
      "file": "lang/readcode/read.go",
      "stack": "go",
      "goPackage": "github.com/example/bfgo/lang/readcode",
      "goTestPkg": "./lang/readcode",
      "fingerprintLevel": "entry",
      "description": "Strip non-BF characters from source code string",
      "inputs": [
        "+++-<>.,[]comment",
        "hello world",
        "+++"
      ]
    },
    {
      "id": "match-loop-indices",
      "entry": "MatchLoopIndices",
      "watches": ["MatchLoopIndices"],
      "file": "lang/exec/interpreter/evalExpr.go",
      "stack": "go",
      "goPackage": "github.com/example/bfgo/lang/exec/interpreter",
      "goTestPkg": "./lang/exec/interpreter",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "description": "Find start and end indices of a BF loop expression",
      "inputs": [
        [0, "++[>++<-]"],
        [3, "++[>++<-]++"]
      ]
    }
  ]
}
```

### Go-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"go"` |
| `file` | ✅ | Path to source file relative to project root |
| `goPackage` | ✅ | Full Go module import path (e.g., `"github.com/user/repo/pkg/name"`) |
| `goTestPkg` | ❌ | Relative path for `go test` (e.g., `"./pkg/name"`) — defaults to `"./"` + directory of `file` |
| `goBuildTags` | ❌ | Build tags to pass to `go test -tags` |
| `module` | ❌ | Alternative: Go module path using dot notation (like Python) |

---

## capture_go.sh — Script Runner

```bash
# Capture all Go clusters
bash scripts/capture_go.sh capture

# Capture a specific cluster
bash scripts/capture_go.sh capture --cluster to-valid-bf

# Validate all Go clusters
bash scripts/capture_go.sh validate

# Health report (delegates to health.js)
bash scripts/capture_go.sh health
```

### What capture_go.sh Does

1. Reads `regrets/manifest.json`
2. Filters clusters with `"stack": "go"`
3. Generates `regrets/regret_capture_test.go` containing:
   - The fingerprint algorithm (cross-stack compatible)
   - Test functions that import target packages
   - Input/output recording logic
4. Runs `go test -v -run TestRegretCapture`
5. Parses test output to extract fingerprints
6. Writes `.regret` files in the same format as JS/Python

### Generated Test File Structure

```
regrets/
  regret_capture_test.go   ← auto-generated from manifest
  regret_validate_test.go  ← auto-generated from manifest
  to-valid-bf.regret       ← written by test execution
  match-loop-indices.regret
```

---

## Pure Logic Extraction in Go

Same principle as other stacks — extract pure business logic from modules that have side effects:

```go
// ❌ BEFORE — mixed concerns, hard to fingerprint
// interpreter/evalExpr.go
func (ctx *BfContext) EvalExprWithContext(code string) {
    for index, char := range code {
        switch string(char) {
        case ".":
            fmt.Print(string(ctx.tape[ctx.ptr]))  // side effect: stdout
        case ",":
            var bfIn byte
            fmt.Scanln(&bfIn)  // side effect: stdin
            ctx.tape[ctx.ptr] = bfIn
        case "+":
            ctx.tape[ctx.ptr]++  // pure state mutation
        // ...
        }
    }
}

// ✅ AFTER — pure logic extracted
// interpreter/evalPure.go
type EvalResult struct {
    Output string
    Tape   [30000]byte
    Ptr    uint16
}

// EvalExprPure — no side effects, deterministic for same inputs
func EvalExprPure(code string, tape [30000]byte, ptr uint16) EvalResult {
    var output strings.Builder
    for _, char := range code {
        switch string(char) {
        case "+":
            tape[ptr]++
        case "-":
            tape[ptr]--
        case ".":
            output.WriteByte(tape[ptr])  // capture output instead of printing
        case "<":
            ptr--
        case ">":
            ptr++
        // ... loops need recursive handling
        }
    }
    return EvalResult{Output: output.String(), Tape: tape, Ptr: ptr}
}

// interpreter/evalExpr.go — thin shell with side effects
func (ctx *BfContext) EvalExprWithContext(code string) {
    result := EvalExprPure(code, ctx.tape, ctx.ptr)
    fmt.Print(result.Output)  // side effect: only at boundary
    ctx.tape = result.Tape
    ctx.ptr = result.Ptr
}
```

### Manifest for the extracted logic:

```json
{
  "id": "eval-expr-pure",
  "entry": "EvalExprPure",
  "watches": ["EvalExprPure"],
  "file": "interpreter/evalPure.go",
  "stack": "go",
  "goPackage": "github.com/example/bfgo/lang/exec/interpreter",
  "description": "Pure BF expression evaluator — no I/O side effects",
  "inputs": [
    {"code": "+++.", "tape": [30000]byte{}, "ptr": 0}
  ]
}
```

### Rules for Go Pure Logic Extraction

1. **Never fingerprint functions that do I/O** — `fmt.Print`, `os.ReadFile`, `http.Get` go in the shell
2. **Never fingerprint functions that use `time.Now()` or `rand.*`** — pass time/randomness as parameters
3. **Logic modules must have zero imports of**: `os`, `net`, `fmt` (for output), `io`, `database/sql`, or any I/O package
4. **Logic functions take all data as parameters** — no receiver that hides state, no package-level globals
5. **If a function needs current time** — accept `now time.Time` as a parameter, let the shell pass `time.Now()`
6. **For stateful computations** — return the full state as the output, don't mutate in place

---

## Normalization: Go-Specific Patterns

| Non-Deterministic Source | Go Pattern | Normalization Rule | Replacement |
|--------------------------|-----------|-------------------|-------------|
| Current time | `time.Now()` | `"timestamps"` | `<TIMESTAMP>` |
| Unix epoch | `time.Now().Unix()` | `"epochs"` | `<EPOCH>` |
| UUID | `uuid.New()` (google/uuid) | `"uuids"` | `<UUID>` |
| Random | `rand.Intn()` / `crypto/rand` | `"ignoreFields"` on that key | — |
| File paths | `os.Getwd()` / `filepath.Abs()` | `"absPaths"` | `<ROOT>/...` |
| Dynamic dates | Period strings in filenames | `"dynamicDates"` | `<MMYYYY>`/`<YYYY>` |

---

## Example `.regret` Output for Go Function

```
cluster: to-valid-bf
fingerprint: a1b2c3d
captured: 2026-06-13T10:00:00Z
watches: [ToValidBF]
entry: ToValidBF
stack: go
goPackage: github.com/baris-inandi/bfgo/lang/readcode
fingerprintLevel: entry
---
INPUT  "+++-<>.,[]comment"
OUTPUT "+++-<>.,[]"
HASH   a1b2c3d
```

Note: The fingerprint hash matches the JS cluster `to-valid-bf` because the same input → same output → same fingerprint algorithm. Cross-stack parity verified.

---

## Handling Go-Specific Challenges

### Challenge 1: Unexported Functions

**Problem:** Go's visibility rules mean lowercase functions are unexported and can't be accessed from external test packages.

**Solution:** Use **same-package test files** (not `_test` package suffix):

```go
// File: lang/readcode/read_test.go
// Package MUST match the source file's package (not readcode_test)
package readcode

import "testing"

func TestToValidBF(t *testing.T) {
    // Can access unexported functions in same package
    result := ToValidBF("hello+world-[]")
    // fingerprint...
}
```

### Challenge 2: Functions with Side Effects

**Problem:** Many Go functions write to `stdout`, read from `stdin`, or modify global state. The Ghost Proxy can't transparently intercept these.

**Solution:** Redirect I/O during capture:

```go
func captureWithRedirectedIO(fn func()) string {
    old := os.Stdout
    r, w, _ := os.Pipe()
    os.Stdout = w
    fn()
    w.Close()
    os.Stdout = old
    var buf bytes.Buffer
    io.Copy(&buf, r)
    return buf.String()
}
```

### Challenge 3: Multiple Return Values

**Problem:** Go functions often return multiple values (e.g., `(int, int, string)`). JSON serialization needs special handling.

**Solution:** Wrap multi-return values into a struct for fingerprinting:

```go
// Original: func MatchLoopIndices(index int, code string) (int, int, string)
// Wrap for fingerprinting:
type MatchLoopIndicesResult struct {
    Start int    `json:"start"`
    End   int    `json:"end"`
    Expr  string `json:"expr"`
}

// In test:
start, end, expr := interpreter.MatchLoopIndices(0, "++[>++<-]")
result := MatchLoopIndicesResult{Start: start, End: end, Expr: expr}
fp := fingerprint(input, result)
```

### Challenge 4: Struct Methods vs Functions

**Problem:** Many Go functions are methods on structs (receivers). The manifest's `entry` field expects a function name, but `ctx.EvalExprWithContext(code)` is a method call.

**Solution:** In the manifest, specify the constructor + method:

```json
{
  "id": "eval-expr",
  "entry": "EvalExprWithContext",
  "receiver": "NewBfContext",
  "watches": ["EvalExprWithContext"],
  "file": "lang/exec/interpreter/evalExpr.go",
  "stack": "go",
  "description": "Evaluate BF expression with context"
}
```

The capture script generates code that:
1. Calls the `receiver` constructor to create the struct
2. Calls the `entry` method on that struct
3. Records both the struct state and the method return value

---

## NPM Script Equivalents for Go

Add to the target project's `package.json` (if it has one for CI orchestration):

```json
{
  "regret:capture:go": "bash ../../skills/regresion-testing/scripts/capture_go.sh capture",
  "regret:validate:go": "bash ../../skills/regresion-testing/scripts/capture_go.sh validate",
  "regret:health:go": "bash ../../skills/regresion-testing/scripts/capture_go.sh health"
}
```

Or add as Makefile targets:

```makefile
regret-capture-go:
        bash skills/regresion-testing/scripts/capture_go.sh capture

regret-validate-go:
        bash skills/regresion-testing/scripts/capture_go.sh validate

regret-health-go:
        bash skills/regresion-testing/scripts/capture_go.sh health
```

Or use Go's native tooling:

```makefile
regret-capture-go:
        go test -v -run TestRegretCapture ./regrets/

regret-validate-go:
        go test -v -run TestRegretValidate ./regrets/
```

---

## Compatibility with JS Manifest

Go clusters can coexist with JS/Python/Rust clusters in the same `manifest.json`. The capture/validate scripts filter by `stack` field:

```json
{
  "clusters": [
    {
      "id": "format-period",
      "entry": "formatPeriod",
      "stack": "js",
      "file": "js/date-utils.js"
    },
    {
      "id": "to-valid-bf",
      "entry": "ToValidBF",
      "stack": "go",
      "file": "lang/readcode/read.go",
      "goPackage": "github.com/example/bfgo/lang/readcode"
    }
  ]
}
```

- `capture.js` only processes `stack: "js"` or `stack: "ts"` clusters
- `capture.py` only processes `stack: "python"` clusters
- `capture_go.sh` only processes `stack: "go"` clusters
- `validate.js` validates JS/TS clusters; `validate.py` validates Python clusters
- `health.js` and `health.py` both read the same `audit.log` — health reports cover all stacks

---

## Real-World Case Study: bfgo

This Go stack variant was designed and tested against `baris-inandi/bfgo`, a Brainfuck compiler, interpreter, and REPL written in Go. Key findings from that experience:

### Identifiable Pure Functions

| Package | Function | Signature | Cluster ID |
|---------|----------|-----------|------------|
| `lang/readcode` | `ToValidBF` | `func(string) string` | `to-valid-bf` |
| `lang/exec/interpreter` | `MatchLoopIndices` | `func(int, string) (int, int, string)` | `match-loop-indices` |
| `utils` | `RuneInSlice` | `func(rune, []rune) bool` | `rune-in-slice` |
| `bffmt` | `format` | `func(string) string` | `bf-format` |

### Functions Requiring Pure Logic Extraction

| Function | Issue | Extraction Strategy |
|----------|-------|-------------------|
| `EvalExprWithContext` | Writes to stdout | Extract to `EvalExprPure(code, tape, ptr) → (output, tape, ptr)` |
| `Canonicalize` | Modifies struct state | Extract to pure function that returns new Code value |
| `ReadBFCode` | Reads from filesystem | Already has `ToValidBF` as the pure core |

### Lessons Learned

1. **Go's compilation model is fundamentally different** — you can't just `import()` a file at runtime like JS/Python. Everything must compile before testing.
2. **Package visibility matters** — only exported functions (uppercase) can be tested from external packages. For unexported functions, tests must be in the same package.
3. **Struct methods need special handling** — the `receiver` field in the manifest allows specifying a constructor for method calls.
4. **Multiple return values are common in Go** — these need to be wrapped into a single struct for JSON serialization and fingerprinting.
5. **Side effects in Go are explicit** — `fmt.Print` and `os.ReadFile` are clearly visible, making it easier to identify pure functions than in some other languages.
