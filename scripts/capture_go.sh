#!/usr/bin/env bash
# capture_go.sh — compile + run regret capture for Go clusters
# Generates a Go test file from manifest.json, runs `go test`, and writes .regret files.
#
# Usage:
#   bash scripts/capture_go.sh                # capture all Go clusters
#   bash scripts/capture_go.sh validate       # validate all Go clusters
#   bash scripts/capture_go.sh health         # health report (delegates to health.js)
#   bash scripts/capture_go.sh --cluster to-valid-bf

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Ensure regrets directory exists
mkdir -p "$REGRET_DIR"

MODE="${1:-capture}"
CLUSTER_FLAG=""

# Parse --cluster flag
for arg in "$@"; do
  if [[ "$arg" == "--cluster" ]]; then
    shift
    CLUSTER_FLAG="$1"
    break
  fi
done

# ─── Helper: Generate Go fingerprint code ─────────────────────────────────────

# The Go fingerprint code must produce IDENTICAL results to the JS/Python/Rust
# implementations: sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars

FINGERPRINT_GO=$(cat <<'GOEOF'
package regrettest

import (
        "crypto/sha256"
        "encoding/json"
        "fmt"
        "math/big"
        "sort"
)

// stableStringify produces a deterministic JSON string with sorted keys.
// Must produce identical output to JS stableStringify() and Python stable_dumps().
func stableStringify(obj interface{}) string {
        return doStableStringify(obj)
}

func doStableStringify(obj interface{}) string {
        if obj == nil {
                return "null"
        }
        switch v := obj.(type) {
        case bool:
                if v {
                        return "true"
                }
                return "false"
        case int:
                return fmt.Sprintf("%d", v)
        case int64:
                return fmt.Sprintf("%d", v)
        case float64:
                return fmt.Sprintf("%g", v)
        case string:
                b, _ := json.Marshal(v)
                return string(b)
        case []interface{}:
                parts := make([]string, len(v))
                for i, item := range v {
                        parts[i] = doStableStringify(item)
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
                        b, _ := json.Marshal(k)
                        parts[i] = string(b) + ":" + doStableStringify(v[k])
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
                if i > 0 {
                        result += sep
                }
                result += s
        }
        return result
}

// toBase36 converts a big.Int to base36 string (lowercase).
// Must produce identical output to JS BigInt.toString(36) and Python to_base36().
func toBase36(n *big.Int) string {
        if n.Sign() == 0 {
                return "0"
        }
        chars := "0123456789abcdefghijklmnopqrstuvwxyz"
        base := big.NewInt(36)
        zero := big.NewInt(0)
        result := ""
        remainder := new(big.Int)
        temp := new(big.Int).Set(n)
        if temp.Sign() < 0 {
                temp.Abs(temp)
        }
        for temp.Cmp(zero) > 0 {
                temp.DivMod(temp, base, remainder)
                result = string(chars[int(remainder.Int64())]) + result
        }
        return result
}

// fingerprint computes the 7-char base36 fingerprint.
// IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint.rs:
//   sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars
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
GOEOF
)

# ─── Helper: Shared Go helpers (regretIO, writeRegret, parseRegret, etc.) ─────

HELPERS_GO=$(cat <<'GOEOF'

// regretIO holds a single input/output/hash triple.
type regretIO struct {
        Input  interface{}
        Output interface{}
        Hash   string
}

// writeRegret builds and writes a .regret file for the given cluster.
// Format matches capture.js: cluster/version/fingerprint/captured/watches/
// entry/stack/goPackage/fingerprintLevel header, then --- separator, then
// INPUT/OUTPUT/HASH for the first result, then INPUTS for results[1+].
func writeRegret(id, entry, goPackage string, results []regretIO) error {
        if len(results) == 0 {
                return fmt.Errorf("no results for cluster %s", id)
        }
        fp := results[0].Hash
        timestamp := time.Now().UTC().Format(time.RFC3339)
        var b strings.Builder
        b.WriteString("cluster: " + id + "\n")
        b.WriteString("version: 1\n")
        b.WriteString("fingerprint: " + fp + "\n")
        b.WriteString("captured: " + timestamp + "\n")
        b.WriteString("watches: [" + entry + "]\n")
        b.WriteString("entry: " + entry + "\n")
        b.WriteString("stack: go\n")
        b.WriteString("goPackage: " + goPackage + "\n")
        b.WriteString("fingerprintLevel: entry\n")
        b.WriteString("---\n")
        inBytes, _ := json.Marshal(results[0].Input)
        outBytes, _ := json.Marshal(results[0].Output)
        b.WriteString("INPUT  " + string(inBytes) + "\n")
        b.WriteString("OUTPUT " + string(outBytes) + "\n")
        b.WriteString("HASH   " + results[0].Hash + "\n")
        if len(results) > 1 {
                rest := make([]map[string]interface{}, 0, len(results)-1)
                for k := 1; k < len(results); k++ {
                        rest = append(rest, map[string]interface{}{
                                "input":  results[k].Input,
                                "output": results[k].Output,
                                "hash":   results[k].Hash,
                        })
                }
                restBytes, _ := json.Marshal(rest)
                b.WriteString("INPUTS " + string(restBytes) + "\n")
        }
        regretPath := id + ".regret"
        return os.WriteFile(regretPath, []byte(b.String()), 0644)
}

// adaptArg converts a JSON-parsed interface{} value to the target reflect.Type.
// Handles common conversions: float64->int, float64->int64, int->float64, etc.
// This bridges the gap between JSON's float64-only number type and Go's typed
// function parameters.
func adaptArg(v interface{}, target reflect.Type) (reflect.Value, error) {
        if v == nil {
                return reflect.Zero(target), nil
        }
        rv := reflect.ValueOf(v)
        if rv.Type() == target {
                return rv, nil
        }
        if rv.Type().ConvertibleTo(target) {
                return rv.Convert(target), nil
        }
        return reflect.Value{}, fmt.Errorf("cannot convert %v to %v", rv.Type(), target)
}

// callEntry invokes fn via reflection. If multiArgs is true, input must be an
// array; each element is converted to the corresponding parameter type via
// adaptArg. Returns the result(s) as a single interface{} (or []interface{}
// for multi-return functions).
func callEntry(fn reflect.Value, multiArgs bool, input interface{}) (interface{}, error) {
        fnType := fn.Type()
        var args []interface{}
        if multiArgs {
                arr, ok := input.([]interface{})
                if !ok {
                        return nil, fmt.Errorf("multiArgs input is not an array (got %T)", input)
                }
                args = arr
        } else {
                args = []interface{}{input}
        }
        if fnType.NumIn() != len(args) {
                return nil, fmt.Errorf("entry expects %d args, got %d", fnType.NumIn(), len(args))
        }
        reflectArgs := make([]reflect.Value, len(args))
        for i, a := range args {
                av, err := adaptArg(a, fnType.In(i))
                if err != nil {
                        return nil, fmt.Errorf("arg %d: %w", i, err)
                }
                reflectArgs[i] = av
        }
        callResults := fn.Call(reflectArgs)
        if len(callResults) == 0 {
                return nil, nil
        }
        if len(callResults) == 1 {
                return callResults[0].Interface(), nil
        }
        arr := make([]interface{}, len(callResults))
        for k, r := range callResults {
                arr[k] = r.Interface()
        }
        return arr, nil
}

// parseRegret extracts INPUT, OUTPUT, HASH, and INPUTS fields from a .regret
// file's content. Returns the first input/output/hash plus the INPUTS array
// (for multi-input clusters, inputs[1+]).
func parseRegret(content string) (input interface{}, output interface{}, hash string, inputsList []map[string]interface{}, err error) {
        lines := strings.Split(content, "\n")
        var inputData, outputData, hashData, inputsData string
        for _, line := range lines {
                if strings.HasPrefix(line, "INPUTS ") && inputsData == "" {
                        inputsData = strings.TrimSpace(strings.TrimPrefix(line, "INPUTS"))
                } else if strings.HasPrefix(line, "INPUT ") && inputData == "" {
                        inputData = strings.TrimSpace(strings.TrimPrefix(line, "INPUT"))
                } else if strings.HasPrefix(line, "OUTPUT ") && outputData == "" {
                        outputData = strings.TrimSpace(strings.TrimPrefix(line, "OUTPUT"))
                } else if strings.HasPrefix(line, "HASH ") && hashData == "" {
                        hashData = strings.TrimSpace(strings.TrimPrefix(line, "HASH"))
                }
        }
        if inputData != "" {
                if e := json.Unmarshal([]byte(inputData), &input); e != nil {
                        err = fmt.Errorf("parse INPUT: %w", e)
                        return
                }
        }
        if outputData != "" {
                if e := json.Unmarshal([]byte(outputData), &output); e != nil {
                        err = fmt.Errorf("parse OUTPUT: %w", e)
                        return
                }
        }
        hash = hashData
        if inputsData != "" {
                if e := json.Unmarshal([]byte(inputsData), &inputsList); e != nil {
                        err = fmt.Errorf("parse INPUTS: %w", e)
                        return
                }
        }
        return
}
GOEOF
)

# ─── Helper: Generate shared helpers test file ────────────────────────────────

generate_helpers_test() {
  local clusters_json="$1"
  local helpers_file="${REGRET_DIR}/regret_helpers_test.go"

  # Generate package declaration + stdlib imports.
  # NOTE: user packages are NOT imported here (helpers don't reference them;
  # the capture/validate test files import user packages themselves).
  cat > "$helpers_file" << 'HELPERSHDR'
// regret_helpers_test.go — auto-generated by capture_go.sh
// DO NOT EDIT — shared helpers for capture/validate.
package regrettest

import (
        "crypto/sha256"
        "encoding/json"
        "fmt"
        "math/big"
        "os"
        "reflect"
        "sort"
        "strings"
        "time"
)
HELPERSHDR

  # Append fingerprint code (strip the "package" + "import" block from FINGERPRINT_GO)
  echo "$FINGERPRINT_GO" | sed '1,/^)/d' >> "$helpers_file"

  # Append shared helpers
  echo "$HELPERS_GO" >> "$helpers_file"

  echo "$helpers_file"
}

# ─── Helper: Read Go clusters from manifest ───────────────────────────────────

read_go_clusters() {
  if [ ! -f "$MANIFEST" ]; then
    echo "❌ regrets/manifest.json not found"
    exit 1
  fi
  node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
    const clusters = m.clusters.filter(c => c.stack === 'go');
    if ('$CLUSTER_FLAG') {
      const id = '$CLUSTER_FLAG'.trim();
      const filtered = clusters.filter(c => c.id === id);
      console.log(JSON.stringify(filtered));
    } else {
      console.log(JSON.stringify(clusters));
    }
  "
}

# ─── Helper: Generate Go capture test file ────────────────────────────────────

generate_capture_test() {
  local clusters_json="$1"
  local test_file="${REGRET_DIR}/regret_capture_test.go"

  CLUSTERS_JSON="$clusters_json" node << 'NODESCRIPT' > "$test_file"
const clusters = JSON.parse(process.env.CLUSTERS_JSON);

// goLit: convert a JS value to a Go literal expression
function goLit(val) {
  if (val === null || val === undefined) return 'nil';
  if (typeof val === 'string') return JSON.stringify(val);
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    return '[]interface{}{' + val.map(goLit).join(', ') + '}';
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val).map(([k, v]) => JSON.stringify(k) + ': ' + goLit(v));
    return 'map[string]interface{}{' + entries.join(', ') + '}';
  }
  return 'nil';
}

// goStr: produce a Go double-quoted string literal from a JS string
function goStr(s) {
  return JSON.stringify(String(s));
}

// Build package alias map (must match generate_helpers_test)
const pkgMap = new Map();
const stdlibNames = new Set(['json','fmt','os','filepath','reflect','strings','testing','time','sort','big','sha256','crypto','encoding','math','path']);
for (const c of clusters) {
  if (c.goPackage && !pkgMap.has(c.goPackage)) {
    const last = c.goPackage.split('/').pop();
    let alias = last;
    if (stdlibNames.has(last)) alias = last + 'pkg';
    let base = alias, n = 2;
    while (Array.from(pkgMap.values()).includes(alias)) { alias = base + n; n++; }
    pkgMap.set(c.goPackage, alias);
  }
}

const lines = [];
lines.push('// regret_capture_test.go — auto-generated by capture_go.sh');
lines.push('// DO NOT EDIT — regenerated on each capture run.');
lines.push('package regrettest');
lines.push('');
lines.push('import (');
lines.push('\t"reflect"');
lines.push('\t"testing"');
for (const [pkg, alias] of pkgMap) {
  const last = pkg.split('/').pop();
  if (alias === last) {
    lines.push('\t"' + pkg + '"');
  } else {
    lines.push('\t' + alias + ' "' + pkg + '"');
  }
}
lines.push(')');
lines.push('');
lines.push('func TestRegretCapture(t *testing.T) {');

for (const cluster of clusters) {
  const id = cluster.id;
  const entry = cluster.entry;
  const goPackage = cluster.goPackage || '';
  const multiArgs = !!cluster.multiArgs;
  const inputs = cluster.inputs || [null];
  const alias = pkgMap.get(goPackage) || '';

  lines.push('\tt.Run(' + goStr(id) + ', func(t *testing.T) {');
  lines.push('\t\tresults := []regretIO{}');

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    lines.push('\t\t{ // input[' + i + ']');
    lines.push('\t\t\tvar in interface{} = ' + goLit(input));
    lines.push('\t\t\tfn := reflect.ValueOf(' + alias + '.' + entry + ')');
    lines.push('\t\t\tout, err := callEntry(fn, ' + (multiArgs ? 'true' : 'false') + ', in)');
    lines.push('\t\t\tif err != nil {');
    lines.push('\t\t\t\tt.Errorf(' + goStr('❌ ' + id + ' input[' + i + '] call failed: %v') + ', err)');
    lines.push('\t\t\t\treturn');
    lines.push('\t\t\t}');
    lines.push('\t\t\th := fingerprint(in, out)');
    lines.push('\t\t\tresults = append(results, regretIO{Input: in, Output: out, Hash: h})');
    lines.push('\t\t}');
  }

  lines.push('\t\tif err := writeRegret(' + goStr(id) + ', ' + goStr(entry) + ', ' + goStr(goPackage) + ', results); err != nil {');
  lines.push('\t\t\tt.Errorf(' + goStr('❌ ' + id + ' failed to write .regret: %v') + ', err)');
  lines.push('\t\t\treturn');
  lines.push('\t\t}');
  lines.push('\t\tt.Logf(' + goStr('✅ ' + id + ' captured (hash: %s)') + ', results[0].Hash)');
  lines.push('\t})');
  lines.push('');
}

lines.push('}');
console.log(lines.join('\n'));
NODESCRIPT

  echo "$test_file"
}

# ─── Helper: Generate Go validate test file ───────────────────────────────────

generate_validate_test() {
  local clusters_json="$1"
  local test_file="${REGRET_DIR}/regret_validate_test.go"

  CLUSTERS_JSON="$clusters_json" node << 'NODESCRIPT' > "$test_file"
const clusters = JSON.parse(process.env.CLUSTERS_JSON);

function goStr(s) {
  return JSON.stringify(String(s));
}

// Build package alias map (must match generate_helpers_test)
const pkgMap = new Map();
const stdlibNames = new Set(['json','fmt','os','filepath','reflect','strings','testing','time','sort','big','sha256','crypto','encoding','math','path']);
for (const c of clusters) {
  if (c.goPackage && !pkgMap.has(c.goPackage)) {
    const last = c.goPackage.split('/').pop();
    let alias = last;
    if (stdlibNames.has(last)) alias = last + 'pkg';
    let base = alias, n = 2;
    while (Array.from(pkgMap.values()).includes(alias)) { alias = base + n; n++; }
    pkgMap.set(c.goPackage, alias);
  }
}

const lines = [];
lines.push('// regret_validate_test.go — auto-generated by capture_go.sh');
lines.push('// DO NOT EDIT — regenerated on each validate run.');
lines.push('package regrettest');
lines.push('');
lines.push('import (');
lines.push('\t"os"');
lines.push('\t"reflect"');
lines.push('\t"testing"');
for (const [pkg, alias] of pkgMap) {
  const last = pkg.split('/').pop();
  if (alias === last) {
    lines.push('\t"' + pkg + '"');
  } else {
    lines.push('\t' + alias + ' "' + pkg + '"');
  }
}
lines.push(')');
lines.push('');
lines.push('func TestRegretValidate(t *testing.T) {');

for (const cluster of clusters) {
  const id = cluster.id;
  const entry = cluster.entry;
  const goPackage = cluster.goPackage || '';
  const multiArgs = !!cluster.multiArgs;
  const alias = pkgMap.get(goPackage) || '';
  const maFlag = multiArgs ? 'true' : 'false';

  lines.push('\tt.Run(' + goStr(id) + ', func(t *testing.T) {');
  lines.push('\t\tregretPath := ' + goStr(id + '.regret'));
  lines.push('\t\tcontent, err := os.ReadFile(regretPath)');
  lines.push('\t\tif err != nil {');
  lines.push('\t\t\tt.Errorf(' + goStr('❌ ' + id + ' FAIL — cannot read .regret: %v') + ', err)');
  lines.push('\t\t\treturn');
  lines.push('\t\t}');
  lines.push('\t\tgInput, _, gHash, gInputs, perr := parseRegret(string(content))');
  lines.push('\t\tif perr != nil {');
  lines.push('\t\t\tt.Errorf(' + goStr('❌ ' + id + ' FAIL — parse error: %v') + ', perr)');
  lines.push('\t\t\treturn');
  lines.push('\t\t}');
  lines.push('\t\tfn := reflect.ValueOf(' + alias + '.' + entry + ')');
  // Validate input[0]
  lines.push('\t\tout, cerr := callEntry(fn, ' + maFlag + ', gInput)');
  lines.push('\t\tif cerr != nil {');
  lines.push('\t\t\tt.Errorf(' + goStr('❌ ' + id + ' FAIL — %v') + ', cerr)');
  lines.push('\t\t\treturn');
  lines.push('\t\t}');
  lines.push('\t\tnewHash := fingerprint(gInput, out)');
  lines.push('\t\tif newHash != gHash {');
  lines.push('\t\t\tt.Errorf(' + goStr('❌ ' + id + ' FAIL — expected %s got %s') + ', gHash, newHash)');
  lines.push('\t\t\treturn');
  lines.push('\t\t}');
  lines.push('\t\tt.Logf(' + goStr('✅ ' + id + ' PASS') + ')');
  // Validate inputs[1+] (INPUTS line)
  lines.push('\t\tfor k, golden := range gInputs {');
  lines.push('\t\t\tgi := golden[' + goStr('input') + ']');
  lines.push('\t\t\tgh, _ := golden[' + goStr('hash') + '].(string)');
  lines.push('\t\t\tgout, gerr := callEntry(fn, ' + maFlag + ', gi)');
  lines.push('\t\t\tif gerr != nil {');
  lines.push('\t\t\t\tt.Errorf(' + goStr('❌ ' + id + ' FAIL input[%d] — %v') + ', k+1, gerr)');
  lines.push('\t\t\t\treturn');
  lines.push('\t\t\t}');
  lines.push('\t\t\tgNewHash := fingerprint(gi, gout)');
  lines.push('\t\t\tif gNewHash != gh {');
  lines.push('\t\t\t\tt.Errorf(' + goStr('❌ ' + id + ' FAIL input[%d] — expected %s got %s') + ', k+1, gh, gNewHash)');
  lines.push('\t\t\t\treturn');
  lines.push('\t\t\t}');
  lines.push('\t\t}');
  lines.push('\t})');
  lines.push('');
}

lines.push('}');
console.log(lines.join('\n'));
NODESCRIPT

  echo "$test_file"
}

# ─── Main dispatch ────────────────────────────────────────────────────────────

case "$MODE" in
  capture)
    echo "📡 Capturing Go clusters..."

    if ! command -v go &> /dev/null; then
      echo "⚠️  Go is not installed. Install Go to use the Go stack."
      echo "   See references/go.md for the Go capture protocol."
      exit 0
    fi

    CLUSTERS_JSON=$(read_go_clusters)

    if [ "$CLUSTERS_JSON" = "[]" ]; then
      echo "No Go clusters found in manifest."
      exit 0
    fi

    echo "Found Go clusters:"
    echo "$CLUSTERS_JSON" | node -e "
      const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      clusters.forEach(c => console.log('  - ' + c.id + ' (' + c.entry + ')'));
    "

    # Clean up old generated test files (avoid redeclaration conflicts)
    rm -f "$REGRET_DIR/regret_helpers_test.go" "$REGRET_DIR/regret_capture_test.go" "$REGRET_DIR/regret_validate_test.go"

    HELPERS_FILE=$(generate_helpers_test "$CLUSTERS_JSON")
    echo "📄 Generated: $HELPERS_FILE"
    TEST_FILE=$(generate_capture_test "$CLUSTERS_JSON")
    echo "📄 Generated: $TEST_FILE"

    echo "🔧 Building Go modules..."
    go build ./... 2>/dev/null || true

    echo "🧪 Running regret capture..."
    go test -v -run TestRegretCapture "$REGRET_DIR" 2>&1
    ;;

  validate)
    echo "🔍 Validating Go clusters..."

    if ! command -v go &> /dev/null; then
      echo "⚠️  Go is not installed. Cannot validate Go clusters."
      exit 0
    fi

    CLUSTERS_JSON=$(read_go_clusters)

    if [ "$CLUSTERS_JSON" = "[]" ]; then
      echo "No Go clusters found in manifest."
      exit 0
    fi

    # Clean up old generated test files (avoid redeclaration conflicts)
    rm -f "$REGRET_DIR/regret_helpers_test.go" "$REGRET_DIR/regret_capture_test.go" "$REGRET_DIR/regret_validate_test.go"

    HELPERS_FILE=$(generate_helpers_test "$CLUSTERS_JSON")
    echo "📄 Generated: $HELPERS_FILE"
    TEST_FILE=$(generate_validate_test "$CLUSTERS_JSON")
    echo "📄 Generated: $TEST_FILE"

    echo "🔧 Building Go modules..."
    go build ./... 2>/dev/null || true

    echo "🧪 Running regret validation..."
    go test -v -run TestRegretValidate "$REGRET_DIR" 2>&1
    ;;

  health)
    node "$SKILL_DIR/scripts/health.js"
    ;;

  *)
    echo "Usage: bash scripts/capture_go.sh [capture|validate|health] [--cluster <id>]"
    exit 1
    ;;
esac
