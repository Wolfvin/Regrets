// esm-callee-transform.js — Source transformer for ESM bare-name callees
//
// Background
// ─────────
// In ESM, a top-level `function foo() {}` declaration creates a local binding
// `foo` that is also exported via `export { foo }`. When `foo` is called from
// inside another function in the same module, the call resolves to the local
// binding — NOT to the module namespace property.
//
// The Ghost Proxy's `wrapCallees` reassigns `module.foo = proxy` to intercept
// calls. For CJS this works because `module.exports` is a mutable object and
// internal calls go through `module.exports.foo(...)`. For ESM it does NOT
// work because:
//   1. The ESM namespace is frozen — reassignment throws.
//   2. Even if reassignment succeeded, internal calls use the local binding.
//
// Solution (Approach A — in-memory source transformation)
// ─────────
// Before importing an ESM module that declares `callees`, we rewrite the
// source so that:
//   - A mutable holder object `__regretsHolder` is introduced at the top.
//   - Internal call sites `foo(...)` (inside function bodies only) are
//     rewritten to `__regretsHolder.foo(...)`.
//   - The holder is populated with the original function references at the
//     end of the module.
//   - The holder is exported so external code (wrapCallees) can reassign
//     entries to proxies.
//
// Because function declarations are hoisted in JS, populating the holder at
// the end of the module still works — by the time `main()` is actually
// called (after import completes), `__regretsHolder.foo` is defined.
//
// Supported ESM patterns (closes #262, #276)
// ─────────────────────────────────────────
// The transformer recognises these top-level callee declaration shapes:
//
//   1. `function foo() {}`                         (bare function declaration)
//   2. `export function foo() {}`                  (the most common ESM idiom — #262)
//   3. `export async function foo() {}`            (async variant)
//   4. `export function* foo() {}`                 (generator variant)
//   5. `export const foo = (a, b) => a + b`        (arrow function — #276)
//   6. `export const foo = function(a, b) { ... }` (function expression — #276)
//
// For patterns 1-4 the `export` keyword stays in place — the function name
// binding is still resolved through the user's original export. We only
// rewrite internal call sites and append a holder-population trailer.
//
// For patterns 5-6 the `export` keyword is stripped from the inline
// declaration (turning `export const foo = ...` into `const foo = ...`)
// and the name is re-exported via the trailing `export { ..., __regretsHolder }`
// list. This works around the fact that ESM namespace properties set via
// `export const` are non-writable: reassigning `module.foo = proxy` would
// throw "Cannot assign to read only property". By routing the export
// through the trailing export list, the namespace property remains
// writable (because it's a live binding to a `const`-declared identifier
// — and we don't try to reassign the const, we reassign the holder entry
// instead, which IS a plain mutable object).
//
// Safety
// ─────
// The transformer is conservative — it aborts (returns null) on any of:
//   - Source is not ESM (.mjs always ESM; .cjs always CJS; .js heuristically
//     detected via export/import syntax vs module.exports).
//   - Source cannot be parsed by tree-sitter.
//   - A callee name appears in a shadowing context anywhere in the file:
//       * as a function parameter (`function main(add) {}`)
//       * as a non-function variable declaration (`let add = 42`)
//       * inside destructuring patterns
//     This avoids incorrectly rewriting calls that reference the shadowing
//     binding instead of the top-level function.
//   - No transformable top-level function declaration matches a callee name.
//     (Callees that are nested, closure-private, class methods, etc. cannot
//     be transformed — the user gets the standard "could not install proxy"
//     warning from wrapCallees with the right diagnostic.)
//
// When the transformer aborts, capture.js falls back to the original import
// and wrapCallees emits the existing "frozen module" warning (Approach B).
//
// The original source file is NEVER modified. The transformed source lives
// only in memory until loaded via a temporary file in the same directory
// (so relative imports resolve correctly). The temp file is deleted in the
// capture.js `finally` block.

import { readFileSync, unlinkSync } from 'fs'
import { extname, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'

// ─── Tree-sitter loader (duplicated from analyzer.js) ─────────────────────
//
// We duplicate the loader rather than refactoring analyzer.js to keep this
// module self-contained — analyzer.js's lazy-init state is module-private
// and we don't want to risk changing its semantics for existing callers.

const _require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const WASM_DIR = join(__dirname, 'wasm')

let _parser = null
let _initPromise = null
const _loadedLanguages = new Map()

async function getParser() {
  if (_parser) return _parser
  if (!_initPromise) {
    const wts = _require('web-tree-sitter')
    _initPromise = wts.Parser.init().then(() => {
      _parser = new wts.Parser()
      return _parser
    })
  }
  return _initPromise
}

async function loadLanguage(langName) {
  if (_loadedLanguages.has(langName)) return _loadedLanguages.get(langName)
  await getParser()
  const { Language } = _require('web-tree-sitter')
  const wasmPath = join(WASM_DIR, `tree-sitter-${langName}.wasm`)
  const lang = await Language.load(wasmPath)
  _loadedLanguages.set(langName, lang)
  return lang
}

// ─── Public constants ─────────────────────────────────────────────────────

/** Name of the holder object exported from transformed modules. */
export const HOLDER_NAME = '__regretsHolder'

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Detect ESM imported bindings in source code (issue #301).
 *
 * Returns a Map<bindingName, { from: string, kind: 'named'|'default'|'namespace' }>
 * for each `import ... from '...'` statement in the source.
 *
 * Handled import forms:
 *   - `import { foo } from 'mod'`              → binding `foo`, kind 'named'
 *   - `import { foo as bar } from 'mod'`       → binding `bar`, kind 'named' (aliased)
 *   - `import { foo, bar } from 'mod'`         → bindings `foo`, `bar`, both 'named'
 *   - `import defaultExport from 'mod'`        → binding `defaultExport`, kind 'default'
 *   - `import foo, { bar } from 'mod'`         → both `foo` (default) and `bar` (named)
 *   - `import * as ns from 'mod'`              → binding `ns`, kind 'namespace'
 *     (callees called as `ns.foo()` are not bare-name callees; the entry is
 *     included for completeness/debugging only)
 *
 * Used to give accurate warnings when a declared `callees: [...]` entry matches
 * an imported binding (issue #301). The source transformer cannot rewrite
 * imported bindings (they're not top-level `function_declaration` nodes in
 * this file), and `wrapCallees` cannot install a proxy because ESM imported
 * bindings are NOT exposed as properties on the module namespace object
 * accessible via `mod[name]` — they are live bindings to external modules.
 *
 * Pure regex-based — fast and dependency-free. Robust against multi-line
 * import statements (uses [\s\S] for the binding-spec body) and against
 * either single- or double-quoted module paths. Block and line comments are
 * stripped first to avoid false positives (e.g., a commented-out import).
 *
 * Edge cases NOT handled (accepted limitations):
 *   - String literals containing the substring `import ... from` — extremely
 *     rare in practice; would require a full parser to disambiguate.
 *   - Dynamic `import("mod")` — these don't create bindings, so they're
 *     correctly ignored.
 *
 * @param {string} source - ESM (or CJS) source code; for CJS sources the
 *   result is always an empty Map (no ESM import statements).
 * @returns {Map<string, { from: string, kind: 'named'|'default'|'namespace', importedAs?: string }>}
 */
export function detectImportedBindings(source) {
  const bindings = new Map()
  if (typeof source !== 'string' || source.length === 0) return bindings

  // Strip comments to avoid false positives from commented-out imports.
  // Block comments first (so a `//` inside a block comment doesn't start a
  // line comment), then line comments.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  // Match: import <binding-spec> from "module-path"
  // binding-spec is captured non-greedily up to ` from ` followed by a quote.
  // The `m` flag makes `^` match line starts (so we only match imports at the
  // start of a line, ignoring mid-line text). The `g` flag iterates all.
  const importRegex = /^\s*import\s+([\s\S]+?)\s+from\s+['"]([^'"]+)['"]/gm

  let match
  while ((match = importRegex.exec(stripped)) !== null) {
    const [, spec, fromMod] = match
    _parseImportSpec(spec.trim(), fromMod, bindings)
  }

  return bindings
}

/**
 * Parse a single import binding spec into the `bindings` Map.
 *
 * Spec forms (after trimming):
 *   - `foo`                         → default only
 *   - `* as ns`                     → namespace only
 *   - `{ foo }`                     → named only
 *   - `{ foo, bar as baz }`         → named with alias
 *   - `foo, { bar }`                → default + named
 *   - `foo, * as ns`                → default + namespace
 *
 * @param {string} spec - Binding spec (the part between `import` and `from`)
 * @param {string} fromMod - Module path (the string after `from`)
 * @param {Map} bindings - Map to populate
 * @private
 */
function _parseImportSpec(spec, fromMod, bindings) {
  if (!spec) return

  let defaultPart = ''
  let restPart = spec

  // Check for combined "default, rest" form.
  // We need to find the first comma that's NOT inside braces.
  // Simple approach: if the spec starts with an identifier followed by a comma,
  // peel off the default binding.
  const defaultWithRest = restPart.match(/^(\w+)\s*,\s*([\s\S]+)$/)
  if (defaultWithRest) {
    defaultPart = defaultWithRest[1]
    restPart = defaultWithRest[2].trim()
  } else if (/^\w+$/.test(restPart)) {
    // Pure default: "import foo from 'mod'"
    defaultPart = restPart
    restPart = ''
  }
  // Otherwise: spec starts with `{` or `*` — no default binding.

  if (defaultPart) {
    bindings.set(defaultPart, { from: fromMod, kind: 'default' })
  }

  if (!restPart) return

  // Namespace: * as ns
  const nsMatch = restPart.match(/^\*\s+as\s+(\w+)$/)
  if (nsMatch) {
    bindings.set(nsMatch[1], { from: fromMod, kind: 'namespace' })
    return
  }

  // Named: { ... }
  const namedMatch = restPart.match(/^\{([^}]*)\}$/)
  if (namedMatch) {
    const inner = namedMatch[1]
    for (const part of inner.split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      // "foo as bar" — binding name is `bar` (the local alias)
      const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/)
      if (asMatch) {
        const [, originalName, localName] = asMatch
        bindings.set(localName, { from: fromMod, kind: 'named', importedAs: originalName })
      } else if (/^\w+$/.test(trimmed)) {
        bindings.set(trimmed, { from: fromMod, kind: 'named' })
      }
    }
  }
}

/**
 * Detect if a source file is ESM (vs CJS).
 *
 *   .mjs → always ESM
 *   .cjs → always CJS
 *   .js  → heuristic: if source uses `module.exports` or `exports.X =`, CJS;
 *          else if source uses `export`/`import` keywords, ESM; else CJS
 *          (default Node behavior with no package.json type:module).
 *
 * TypeScript files (.ts/.tsx) are treated as ESM if they use ESM syntax.
 *
 * @param {string} source - File source code
 * @param {string} ext - File extension including the dot (e.g. '.mjs', '.js')
 * @returns {boolean}
 */
export function isEsmSource(source, ext) {
  if (ext === '.mjs') return true
  if (ext === '.cjs') return false
  if (ext !== '.js' && ext !== '.ts' && ext !== '.tsx') return false

  // .js/.ts/.tsx: heuristic detection
  // Strong CJS signal — module.exports anywhere
  if (/module\.exports\s*=/.test(source)) return false
  // Strong CJS signal — top-level `exports.X =` (not inside a function)
  if (/^\s*exports\.\w+\s*=/m.test(source)) return false
  // Strong ESM signal — `export ...` or `import ... from`
  if (/\bexport\b\s*(?:default\s+)?(?:function|const|let|var|class|async\s+function|\{|\*)/m.test(source)) return true
  if (/^\s*import\s(?:.+\sfrom\s)?['"]/m.test(source)) return true
  return false
}

/**
 * Transform ESM source so that bare-name function declarations can be
 * intercepted by `wrapCallees`.
 *
 * @param {string} source - Original ESM source code
 * @param {string[]} calleeNames - Names of callees to make interceptable
 * @param {string} [ext='.mjs'] - File extension (for language detection)
 * @returns {Promise<{transformedSource: string, holderName: string} | null>}
 *   - On success: { transformedSource, holderName }
 *   - On abort: null (caller should fall back to Approach B)
 */
export async function transformEsmForCallees(source, calleeNames, ext = '.mjs') {
  if (!calleeNames || calleeNames.length === 0) return null

  // Load grammar. We only support JS/TS for transformation.
  const langName = (ext === '.ts' || ext === '.tsx') ? 'typescript' : 'javascript'
  let language
  try {
    language = await loadLanguage(langName)
  } catch {
    return null
  }

  const parser = await getParser()
  parser.setLanguage(language)

  let tree
  try {
    tree = parser.parse(source)
  } catch {
    return null
  }
  if (!tree) return null

  try {
    return doTransform(tree.rootNode, source, calleeNames)
  } catch {
    // Any unexpected error → abort, caller falls back to warning.
    return null
  } finally {
    tree.delete()
  }
}

// ─── Internal: actual transformation logic ────────────────────────────────

/**
 * Walk a tree-sitter node tree depth-first, calling fn(node) for each node.
 */
function walk(node, fn) {
  fn(node)
  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), fn)
  }
}

/**
 * Find the nearest ancestor of `node` whose type is in `types`.
 * Returns null if no such ancestor exists.
 */
function findAncestorOfType(node, types) {
  let parent = node.parent
  while (parent) {
    if (types.includes(parent.type)) return parent
    parent = parent.parent
  }
  return null
}

/**
 * Collect all identifier text values inside a destructuring pattern
 * (object_pattern, array_pattern) — used to detect shadowing in parameters
 * like `function main({ add }) {}` or `function main([add]) {}`.
 *
 * Tree-sitter node types we recognize as "identifier-like":
 *   - identifier (bare names)
 *   - shorthand_property_identifier (in object literals)
 *   - shorthand_property_identifier_pattern (in destructuring patterns)
 */
function collectPatternIdentifiers(node, out = []) {
  if (!node) return out
  if (node.type === 'identifier' ||
      node.type === 'shorthand_property_identifier' ||
      node.type === 'shorthand_property_identifier_pattern') {
    out.push(node.text)
    return out
  }
  if (node.type === 'assignment_pattern') {
    // { add = 1 } — the left side is the identifier
    const left = node.childForFieldName('left')
    if (left) collectPatternIdentifiers(left, out)
    return out
  }
  for (let i = 0; i < node.childCount; i++) {
    collectPatternIdentifiers(node.child(i), out)
  }
  return out
}

/**
 * Check if any callee name is shadowed anywhere in the file.
 *
 * Shadowing contexts:
 *   - formal_parameters: `function main(add) {}` or `function main({ add }) {}`
 *   - variable_declarator INSIDE a function body: `function main() { let add = ... }`
 *     (any value type — even `let add = () => ...` shadows the outer `add`)
 *   - variable_declarator at top level with non-function value: `let add = 42`
 *     (the function-bearing top-level case is the legitimate definition; it
 *     still aborts transformation because the callee isn't a
 *     function_declaration, but that's handled separately by
 *     `collectTopLevelFunctionDeclarations`)
 *
 * If shadowing is detected, we abort the transformation to avoid
 * incorrectly rewriting calls that reference the shadowing binding.
 */
function detectShadowing(root, calleeSet) {
  // Function-like node types — used to check if a declaration is inside a function body
  const FUNCTION_CONTEXT_TYPES = [
    'function_declaration',
    'generator_function_declaration',
    'method_definition',
    'function_expression',
    'arrow_function',
  ]
  let shadowed = false

  walk(root, (node) => {
    if (shadowed) return

    // formal_parameters — function/method parameters
    if (node.type === 'formal_parameters') {
      for (let i = 0; i < node.childCount; i++) {
        const param = node.child(i)
        if (!param) continue
        // Bare identifier parameter: `function main(add) {}`
        if (param.type === 'identifier' && calleeSet.has(param.text)) {
          shadowed = true
          return
        }
        // Destructuring: `function main({ add }) {}` or `function main([add]) {}`
        if (param.type === 'object_pattern' || param.type === 'array_pattern' ||
            param.type === 'rest_pattern') {
          const names = collectPatternIdentifiers(param)
          if (names.some(n => calleeSet.has(n))) {
            shadowed = true
            return
          }
        }
      }
    }

    // variable_declarator — `let add = ...` / `const add = ...` / `var add = ...`
    //
    // Two sub-cases:
    //   1. Inside a function body → ALWAYS shadowing (regardless of value type).
    //      Even `function main() { const add = () => ... }` shadows the outer `add`.
    //   2. At top level with non-function value → shadowing (e.g. `let add = 42`).
    //      The top-level function-bearing cases (`const add = () => ...` and
    //      `export const add = () => ...`) are the legitimate definitions and
    //      are now transformable (see collectTopLevelExportedConstFunctions).
    //      A top-level `const add = () => ...` WITHOUT `export` is still a
    //      legitimate binding that calls can be rewritten through the holder
    //      — but since it's not exported, wrapCallees cannot install a proxy
    //      on the namespace. The transformer still rewrites the call sites
    //      via the holder; the user just won't get callee contracts unless
    //      they also export the function (which is the standard ESM pattern).
    //      We don't flag the function-bearing top-level case as shadowing
    //      here — it's handled separately by collectTopLevelFunctionDeclarations
    //      and collectTopLevelExportedConstFunctions.
    if (node.type === 'variable_declarator') {
      const nameNode = node.childForFieldName('name')
      if (nameNode && nameNode.type === 'identifier' && calleeSet.has(nameNode.text)) {
        const fnAncestor = findAncestorOfType(node, FUNCTION_CONTEXT_TYPES)
        if (fnAncestor) {
          // Inside a function body → shadowing
          shadowed = true
          return
        }
        // Top-level — only flag if value is NOT a function-like
        const valueNode = node.childForFieldName('value')
        if (!valueNode || !['arrow_function', 'function_expression', 'function'].includes(valueNode.type)) {
          shadowed = true
          return
        }
      }
      // Destructuring declaration: `const { add } = obj` or `const [add] = arr`
      // (any value type — destructuring always shadows if name matches)
      if (nameNode && (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern')) {
        const names = collectPatternIdentifiers(nameNode)
        if (names.some(n => calleeSet.has(n))) {
          shadowed = true
          return
        }
      }
    }
  })

  return shadowed
}

/**
 * Collect the set of top-level function_declaration names that can be
 * transformed. This includes:
 *
 *   1. Plain top-level `function foo() {}` declarations (direct child of
 *      the program node) — the case the original transformer handled.
 *
 *   2. `export function foo() {}` declarations — these are wrapped in an
 *      `export_statement` node, so they're NOT direct children of the
 *      program node. The inner function_declaration IS still effectively
 *      top-level (it has the same hoisting + binding semantics as case
 *      1) and its calls can be safely rewritten through the holder.
 *      Closes #262: `export function foo()` (the most common ESM idiom)
 *      used to be silently skipped.
 *
 *   3. `export async function foo() {}` and `export function* foo() {}`
 *      (generators) — same wrapping pattern as case 2.
 *
 * The transformer rewrites calls to these functions inside other
 * function bodies to go through `__regretsHolder.NAME(...)`. The
 * function declarations themselves are NOT moved — they stay in place
 * (the `export` keyword stays where it is, the function body is
 * unchanged). Only the call sites get rewritten, and a holder
 * population trailer is appended at the end of the module.
 *
 * Returns a Map<name, kind> where kind is one of:
 *   - 'function_declaration'  (cases 1, 2, 3 above)
 */
function collectTopLevelFunctionDeclarations(root) {
  const found = new Map()
  // Top-level means direct child of the program node.
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)
    if (!child) continue
    // Case 1: direct top-level function_declaration
    if (child.type === 'function_declaration' ||
        child.type === 'generator_function_declaration') {
      const nameNode = child.childForFieldName('name')
      if (nameNode && nameNode.text) {
        found.set(nameNode.text, 'function_declaration')
      }
      continue
    }
    // Case 2/3: export_statement wrapping a function_declaration
    // (e.g. `export function foo() {}` or `export async function foo() {}`).
    if (child.type === 'export_statement') {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j)
        if (!inner) continue
        if (inner.type === 'function_declaration' ||
            inner.type === 'generator_function_declaration') {
          const nameNode = inner.childForFieldName('name')
          if (nameNode && nameNode.text) {
            found.set(nameNode.text, 'function_declaration')
          }
        }
      }
    }
  }
  return found
}

/**
 * Collect the set of top-level `export const NAME = <function-value>` names.
 *
 * These are the ESM patterns closed by issue #276:
 *
 *   - `export const foo = (a, b) => a + b`           (arrow function)
 *   - `export const foo = function(a, b) { ... }`    (function expression)
 *
 * Both shapes parse as:
 *   export_statement
 *     export
 *     lexical_declaration
 *       const
 *       variable_declarator
 *         name: identifier  ← NAME
 *         value: arrow_function | function_expression
 *
 * Unlike `function_declaration`, a `const`-assigned arrow/function is NOT
 * hoisted. That means populating the holder at the END of the module works
 * (the assignment has already run by then), but we also have to be careful:
 * the holder is populated AFTER the user's const declaration, so any
 * top-level call (module-evaluation time) to the callee via the holder
 * would see `undefined`. We never rewrite top-level calls — only calls
 * inside function bodies — so this is fine.
 *
 * The transformer strips the `export` keyword from these declarations
 * (turning `export const foo = ...` into `const foo = ...`) and re-exports
 * the name via the trailing `export { ..., __regretsHolder }` list. This
 * works around the fact that ESM namespace properties are non-writable —
 * by NOT exporting `foo` directly, we avoid the "Cannot assign to read
 * only property" error that would otherwise fire when wrapCallees tries
 * to reassign `module.foo = proxy`. The user-facing API is unchanged
 * (the module still exports `foo`), but the binding is resolved via the
 * trailing export list rather than via the inline `export const`.
 *
 * Returns a Map<name, { declStart, declEnd }> with byte ranges of the
 * `export_statement` node (so the transformer can strip the `export`
 * keyword by removing bytes [exportStart, exportStart + 7) — the
 * keyword `export` plus one space — and leaving the rest intact).
 */
function collectTopLevelExportedConstFunctions(root) {
  const found = new Map()
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)
    if (!child || child.type !== 'export_statement') continue

    // Look for lexical_declaration (const/let/var) as the exported child.
    let lexDecl = null
    for (let j = 0; j < child.childCount; j++) {
      const inner = child.child(j)
      if (inner && (inner.type === 'lexical_declaration' ||
                    inner.type === 'variable_declaration')) {
        lexDecl = inner
        break
      }
    }
    if (!lexDecl) continue

    // Walk the lexical_declaration's variable_declarator children.
    for (let k = 0; k < lexDecl.childCount; k++) {
      const decl = lexDecl.child(k)
      if (!decl || decl.type !== 'variable_declarator') continue
      const nameNode = decl.childForFieldName('name')
      const valueNode = decl.childForFieldName('value')
      if (!nameNode || nameNode.type !== 'identifier' || !nameNode.text) continue
      if (!valueNode) continue
      if (valueNode.type === 'arrow_function' ||
          valueNode.type === 'function_expression' ||
          valueNode.type === 'function') {
        // Record the byte range of the `export` keyword + the single
        // space that follows it, so the transformer can strip them
        // (turning `export const foo = ...` into `const foo = ...`).
        // We store the export_statement's start (which is the `export`
        // keyword's start) and the lexical_declaration's start (which
        // is the `const`/`let`/`var` keyword's start, immediately
        // after the single space).
        found.set(nameNode.text, {
          exportStart: child.startIndex,
          declStart: lexDecl.startIndex,
        })
      }
    }
  }
  return found
}

/**
 * Find all call sites that need to be rewritten.
 *
 * A call site qualifies if:
 *   - It's a call_expression
 *   - The callee is a bare identifier (not a member_expression like obj.foo)
 *   - The callee name is in calleeSet
 *   - The call is INSIDE a function body (any depth, but not at the top
 *     level of the module — top-level calls are left unchanged to preserve
 *     module-evaluation semantics)
 *
 * Returns an array of { startByte, endByte, calleeName } sorted by
 * startByte descending (so we can splice from end to start without
 * invalidating earlier offsets).
 */
function findCallSitesToRewrite(root, calleeSet) {
  const FUNCTION_CONTEXT_TYPES = [
    'function_declaration',
    'generator_function_declaration',
    'method_definition',
    'function_expression',
    'arrow_function',
  ]
  const sites = []

  walk(root, (node) => {
    if (node.type !== 'call_expression') return

    // callee field is `function` in JS tree-sitter grammar
    const calleeNode = node.childForFieldName('function')
    if (!calleeNode || calleeNode.type !== 'identifier') return
    if (!calleeSet.has(calleeNode.text)) return

    // Must be inside a function body (any depth)
    const fnAncestor = findAncestorOfType(node, FUNCTION_CONTEXT_TYPES)
    if (!fnAncestor) return

    // Sanity: the call site's identifier node itself is the callee.
    // We rewrite at the identifier's byte range, replacing `calleeName`
    // with `__regretsHolder.calleeName`.
    sites.push({
      startByte: calleeNode.startIndex,
      endByte: calleeNode.endIndex,
      calleeName: calleeNode.text,
    })
  })

  // Sort descending by startByte so splices don't shift earlier offsets.
  sites.sort((a, b) => b.startByte - a.startByte)
  return sites
}

/**
 * Find the byte offset where we should insert the holder declaration.
 * This is right after the last top-level import statement, or 0 if there
 * are no imports.
 */
function findHolderInsertOffset(root) {
  let lastImportEnd = 0
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)
    if (!child) continue
    if (child.type === 'import_statement') {
      lastImportEnd = Math.max(lastImportEnd, child.endIndex)
    }
  }
  return lastImportEnd
}

/**
 * Perform the actual transformation. Returns null if any safety check fails.
 */
function doTransform(root, source, calleeNames) {
  const calleeSet = new Set(calleeNames)

  // Safety check 1: no shadowing
  if (detectShadowing(root, calleeSet)) return null

  // Safety check 2: callees must include at least one transformable top-level
  // function. We accept BOTH:
  //   - top-level function_declaration (with or without an `export` wrapper)
  //   - top-level `export const NAME = <arrow|function-expression>`
  //
  // Both kinds populate the holder at the end of the module, so call sites
  // can be uniformly rewritten to `__regretsHolder.NAME(...)`.
  const fnDecls = collectTopLevelFunctionDeclarations(root)   // Map<name, kind>
  const constFns = collectTopLevelExportedConstFunctions(root) // Map<name, {exportStart, declStart}>

  const transformableFns = new Set([...fnDecls.keys(), ...constFns.keys()])
  const calleesToTransform = calleeNames.filter(name => transformableFns.has(name))
  if (calleesToTransform.length === 0) return null

  // Find all call sites to rewrite
  const sites = findCallSitesToRewrite(root, new Set(calleesToTransform))
  // If there are no internal calls to rewrite, transformation is pointless
  // — the original module is fine (no calls to intercept). Return null so
  // the caller falls back to the original behavior (which will warn that
  // the callee was never called during capture, but that's the original
  // behavior — we don't change it).
  if (sites.length === 0) return null

  // Build the transformed source by splicing from end to start.
  // Step 1: rewrite call sites (from end to start)
  let transformed = source
  for (const site of sites) {
    const replacement = `${HOLDER_NAME}.${site.calleeName}`
    transformed =
      transformed.slice(0, site.startByte) +
      replacement +
      transformed.slice(site.endByte)
  }

  // Step 2: for `export const NAME = <fn>` callees, strip the `export`
  // keyword (turning `export const NAME = ...` into `const NAME = ...`).
  // The name will be re-exported via the trailing export list below,
  // which avoids the ESM "Cannot assign to read only property" error
  // when wrapCallees tries to reassign `module.NAME = proxy`.
  //
  // Splice from end to start so earlier offsets stay valid. We only
  // strip the keyword for callees the user asked to transform — other
  // `export const` declarations are left untouched.
  const constCalleesToStrip = calleesToTransform
    .filter(name => constFns.has(name))
    .map(name => constFns.get(name))
    .sort((a, b) => b.exportStart - a.exportStart)
  for (const { exportStart, declStart } of constCalleesToStrip) {
    // Replace bytes [exportStart, declStart) (the `export` keyword plus
    // any whitespace between it and the `const`/`let`/`var` keyword)
    // with empty string. This turns `export const foo = ...` into
    // `const foo = ...` cleanly, preserving the rest of the line.
    transformed =
      transformed.slice(0, exportStart) +
      transformed.slice(declStart)
  }

  // Step 3: insert holder declaration at the top (after imports)
  // Use a leading newline to ensure we don't run together with the previous
  // statement (e.g. `import ... from '...'const __regretsHolder = {}` would
  // be a syntax error). The leading newline is harmless when insertOffset is 0.
  const insertOffset = findHolderInsertOffset(root)
  const holderDecl = `\nconst ${HOLDER_NAME} = {};\n`
  transformed =
    transformed.slice(0, insertOffset) +
    holderDecl +
    transformed.slice(insertOffset)

  // Step 4: append holder population + export at the end.
  //
  // The trailing `export { ... }` list includes:
  //   - The holder (so wrapCallees can reassign entries on it)
  //   - Every `export const NAME = <fn>` callee whose `export` keyword we
  //     stripped in step 2 — re-exporting here keeps the user-facing API
  //     unchanged (the module still exports NAME).
  //
  // `function_declaration` callees (whether bare or `export function foo()`)
  // keep their original `export` keyword (or their separate `export { foo }`
  // statement) — we don't need to re-export them.
  const assignments = calleesToTransform
    .map(name => `${HOLDER_NAME}.${name} = ${name};`)
    .join('\n')
  const reExportNames = calleesToTransform
    .filter(name => constFns.has(name))
  const exportList = [HOLDER_NAME, ...reExportNames].join(', ')
  const trailer = `\n${assignments}\nexport { ${exportList} };\n`
  transformed = transformed + trailer

  return { transformedSource: transformed, holderName: HOLDER_NAME }
}

// ─── ESM temp file lifecycle (process-wide) ───────────────────────────────
//
// When capture.js transforms an ESM source, it writes the transformed source
// to a temp file in the SAME directory as the original (so relative imports
// resolve unchanged). The temp file is normally deleted in the per-cluster
// `finally` block — but if the process is killed (SIGINT, SIGTERM, crash)
// between the write and the finally, the temp file is orphaned forever.
//
// This section maintains a process-wide registry of all ESM transform temp
// files created by capture.js, and installs signal handlers that nuke them
// on abnormal exit. The handlers are idempotent and safe to call multiple
// times.
//
// Design notes:
//   - We do NOT use vm.Module (experimental SourceTextModule) because it
//     would require a custom linker to resolve relative imports, adding
//     fragility. Temp-file-in-source-dir + robust cleanup is more stable.
//   - We do NOT use a per-process temp directory under os.tmpdir() because
//     relative imports (`./helper.mjs`) would resolve relative to that dir
//     instead of the original source dir, breaking import resolution.
//   - Collision safety: name = `.regrets-transform-<pid>-<uuid>.mjs`. The
//     pid helps attribute leaks to a specific CI process; the UUID provides
//     cryptographic collision resistance across concurrent captures.
//   - Register-before-write ordering: capture.js registers the planned path
//     BEFORE calling writeFileSync, so the signal handler catches the file
//     even if SIGINT arrives between write and register.

const _esmTempFiles = new Set()
let _cleanupHandlersInstalled = false

/**
 * Idempotent cleanup of all registered temp files.
 * Safe to call from signal handlers (synchronous — only uses unlinkSync).
 *
 * @returns {number} Number of files actually deleted (vs already-gone)
 * @internal
 */
function _nukeAllTempFiles() {
  let deleted = 0
  for (const p of _esmTempFiles) {
    try {
      unlinkSync(p)
      deleted++
    } catch (e) {
      // ENOENT: file already gone — fine.
      // EACCES / other: best-effort, swallow to avoid masking the original
      // signal/crash reason.
    }
  }
  _esmTempFiles.clear()
  return deleted
}

/**
 * Install process-level cleanup handlers. Called once at module load.
 * Idempotent — safe to call multiple times (no-op after first call).
 *
 * Handlers:
 *   - SIGINT:  cleanup, then exit(130)  (default SIGINT exit code = 128+2)
 *   - SIGTERM: cleanup, then exit(143)  (default SIGTERM exit code = 128+15)
 *   - exit:    cleanup (must be synchronous; unlinkSync is sync, OK)
 *   - uncaughtException: cleanup, then re-throw (preserves Node's default
 *     crash behavior; the 'exit' handler will run next, idempotently)
 *
 * Note: adding a SIGINT/SIGTERM listener disables Node's default "exit on
 * signal" behavior — we MUST call process.exit() ourselves to terminate.
 * The 'exit' event then fires and runs the idempotent cleanup again.
 */
function installEsmTempFileCleanupHandlers() {
  if (_cleanupHandlersInstalled) return
  _cleanupHandlersInstalled = true

  process.on('SIGINT', () => {
    _nukeAllTempFiles()
    process.exit(130)
  })

  process.on('SIGTERM', () => {
    _nukeAllTempFiles()
    process.exit(143)
  })

  process.on('exit', () => {
    // 'exit' handler must be synchronous — unlinkSync is sync, OK.
    // This fires on both normal exit (process.exit / event loop drain) and
    // abnormal exit (SIGINT/SIGTERM → process.exit from our handler above,
    // or uncaughtException re-throw crash). The _nukeAllTempFiles call is
    // idempotent so re-entry is a no-op.
    _nukeAllTempFiles()
  })

  process.on('uncaughtException', (err) => {
    _nukeAllTempFiles()
    // Re-throw to preserve Node's default crash behavior. Without this,
    // the process would keep running (adding an uncaughtException listener
    // disables the default "print stack + exit" behavior).
    // The 'exit' handler will fire next, idempotently.
    throw err
  })
}

// Install eagerly at module load — guarantees handlers are in place before
// any temp file is created by capture.js.
installEsmTempFileCleanupHandlers()

/**
 * Register a temp file with the process-wide lifecycle manager.
 * The file will be deleted on SIGINT/SIGTERM/exit/uncaughtException if not
 * already removed via deleteEsmTempFile.
 *
 * capture.js should call this BEFORE writing the file, so the signal
 * handler catches the file even if SIGINT arrives between write and
 * register.
 *
 * @param {string} absPath - Absolute path to the temp file
 */
export function registerEsmTempFile(absPath) {
  _esmTempFiles.add(absPath)
}

/**
 * Delete a registered temp file and remove it from the registry.
 *
 * Safe to call multiple times for the same path (idempotent — the second
 * call finds the path already removed from the registry and the file
 * already unlinked, so it is a no-op).
 * Safe to call for a path that was never registered (swallows ENOENT).
 *
 * @param {string} absPath - Absolute path to the temp file
 * @returns {boolean} true if the file was deleted by THIS call (false if
 *   it was already gone before this call)
 * @throws {Error} Re-throws any non-ENOENT error from unlinkSync (e.g.
 *   EACCES) so the caller can log/warn appropriately.
 */
export function deleteEsmTempFile(absPath) {
  let deleted = false
  try {
    unlinkSync(absPath)
    deleted = true
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Unexpected error — unregister and re-throw so caller can log.
      _esmTempFiles.delete(absPath)
      throw e
    }
    // ENOENT is fine — file was already gone.
  } finally {
    _esmTempFiles.delete(absPath)
  }
  return deleted
}

/**
 * Delete ALL registered temp files. Intended for signal handlers and tests.
 * Idempotent — safe to call multiple times.
 *
 * @returns {number} Number of files actually deleted by THIS call
 */
export function cleanupAllEsmTempFiles() {
  return _nukeAllTempFiles()
}

/**
 * Generate a collision-safe temp file name for ESM transform output.
 *
 * Format: `.regrets-transform-<pid>-<uuid>.mjs`
 *
 * - `.regrets-transform-` prefix: keeps the existing convention so the
 *   e2e test (which scans for this prefix) still works.
 * - `<pid>`: helps attribute leaked files to a specific CI process and
 *   adds an extra layer of collision resistance across concurrent captures.
 * - `<uuid>`: cryptographically strong collision resistance (v4 UUID).
 *
 * The temp file is meant to be written in the same directory as the
 * original source file (so relative imports resolve unchanged). This
 * function returns just the file NAME — the caller is responsible for
 * joining it with the source directory.
 *
 * @returns {string} Temp file name (no path)
 */
export function generateEsmTempFileName() {
  return `.regrets-transform-${process.pid}-${randomUUID()}.mjs`
}
