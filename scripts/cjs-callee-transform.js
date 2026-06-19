// cjs-callee-transform.js — Source transformer for CJS bare-name callees
//
// Background
// ─────────
// In CJS, when a module declares:
//
//   function add(a, b) { return a + b }
//   function main(x) { return add(x, 1) }
//   module.exports = { main, add }
//
// ...the call `add(x, 1)` inside `main` resolves to the LOCAL `add` binding
// (the function declaration), NOT to `module.exports.add`. So when wrapCallees
// reassigns `module.exports.add = proxy`, the internal call inside `main`
// still sees the original `add` — the proxy is never invoked.
//
// Closes #263: the previous behavior was to emit a misleading warning
// ("Callee 'add' was declared but never called during capture"), implying
// the callee wasn't called when in fact it WAS called but the proxy
// couldn't see it.
//
// Solution
// ─────────
// Before importing a CJS module that declares `callees`, we rewrite the
// source so that:
//   - A mutable holder object `__regretsHolder` is introduced at the top.
//   - Internal bare-name call sites `foo(...)` (inside function bodies only)
//     are rewritten to `__regretsHolder.foo(...)`.
//   - The holder is populated with the original function references at the
//     end of the module (after the user's code, before `module.exports`).
//   - The holder is attached to `module.exports.__regretsHolder` so
//     wrapCallees can reassign entries on it (mirroring the ESM path).
//
// This is the CJS analogue of esm-callee-transform.js. The transformer is
// opt-in — capture.js only calls it when:
//   1. The cluster declares `callees`.
//   2. The file is CJS (.cjs, or .js with `module.exports`/`exports.X =`).
//
// Supported CJS patterns
// ──────────────────────
//   1. `function foo() {}`                          (bare function declaration)
//   2. `const foo = (a, b) => a + b`                (arrow function)
//   3. `const foo = function(a, b) { ... }`         (function expression)
//
// Top-level only. Callees declared inside other functions (closures) are
// not transformable — the user gets the standard warning.
//
// Safety
// ─────
// The transformer is conservative — it aborts (returns null) on any of:
//   - Source is not CJS (.cjs always CJS; .js with `module.exports` is CJS;
//     .js with `export`/`import` is ESM and not handled here).
//   - Source cannot be parsed by tree-sitter.
//   - A callee name appears in a shadowing context anywhere in the file
//     (function parameter, non-function variable declaration, destructuring).
//   - No transformable top-level function declaration matches a callee name.
//   - No internal bare-name calls to rewrite.
//
// The original source file is NEVER modified. The transformed source lives
// only in a temp file in the same directory (so `require()` resolution
// still works for relative imports). The temp file is deleted in the
// capture.js `finally` block.

import { extname, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

// ─── Tree-sitter loader (duplicated from esm-callee-transform.js) ──────────
//
// We duplicate the loader for the same reason esm-callee-transform.js does:
// keeping this module self-contained without changing analyzer.js's
// module-private state.

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

/**
 * Name of the holder object attached to `module.exports` in transformed CJS
 * modules. Kept identical to the ESM transformer's HOLDER_NAME so the
 * wrapCallees logic (which looks up `targetModule[holderName]` on the
 * imported module) works uniformly across both module systems.
 */
export const HOLDER_NAME = '__regretsHolder'

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Detect if a source file is CJS (vs ESM).
 *
 *   .cjs → always CJS
 *   .mjs → always ESM (not CJS)
 *   .js  → heuristic: if source uses `module.exports` or `exports.X =`, CJS;
 *          else if source uses `export`/`import` keywords, ESM;
 *          else CJS (default Node behavior with no package.json type:module)
 *
 * @param {string} source - File source code
 * @param {string} ext - File extension including the dot (e.g. '.cjs', '.js')
 * @returns {boolean}
 */
export function isCjsSource(source, ext) {
  if (ext === '.cjs') return true
  if (ext === '.mjs') return false
  if (ext !== '.js' && ext !== '.ts' && ext !== '.tsx') return false

  // .js/.ts/.tsx: heuristic detection
  // Strong ESM signal — export/import statements
  if (/\bexport\b\s*(?:default\s+)?(?:function|const|let|var|class|async\s+function|\{|\*)/m.test(source)) return false
  if (/^\s*import\s(?:.+\sfrom\s)?['"]/m.test(source)) return false
  // Strong CJS signal — module.exports or exports.X =
  if (/module\.exports\s*=/.test(source)) return true
  if (/^\s*exports\.\w+\s*=/m.test(source)) return true
  // No signal → default to CJS (Node default)
  return true
}

/**
 * Transform CJS source so that bare-name function calls can be intercepted
 * by `wrapCallees`.
 *
 * @param {string} source - Original CJS source code
 * @param {string[]} calleeNames - Names of callees to make interceptable
 * @param {string} [ext='.cjs'] - File extension (for language detection)
 * @returns {Promise<{transformedSource: string, holderName: string} | null>}
 *   - On success: { transformedSource, holderName }
 *   - On abort: null (caller should fall back to the original import +
 *     wrapCallees warning)
 */
export async function transformCjsForCallees(source, calleeNames, ext = '.cjs') {
  if (!calleeNames || calleeNames.length === 0) return null

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
 * Collect all identifier text values inside a destructuring pattern.
 * (Mirrors the same helper in esm-callee-transform.js.)
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
 * Check if any callee name is shadowed anywhere in the file. Same semantics
 * as the ESM transformer's detectShadowing — if a callee name appears as a
 * function parameter, destructuring pattern, or non-function variable
 * declaration, we abort.
 */
function detectShadowing(root, calleeSet) {
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

    if (node.type === 'formal_parameters') {
      for (let i = 0; i < node.childCount; i++) {
        const param = node.child(i)
        if (!param) continue
        if (param.type === 'identifier' && calleeSet.has(param.text)) {
          shadowed = true
          return
        }
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

    if (node.type === 'variable_declarator') {
      const nameNode = node.childForFieldName('name')
      if (nameNode && nameNode.type === 'identifier' && calleeSet.has(nameNode.text)) {
        const fnAncestor = findAncestorOfType(node, FUNCTION_CONTEXT_TYPES)
        if (fnAncestor) {
          // Inside a function body → shadowing
          shadowed = true
          return
        }
        // Top-level — only flag if value is NOT a function-like.
        // Top-level `const add = () => ...` is the legitimate definition
        // (transformable), so we don't flag it.
        const valueNode = node.childForFieldName('value')
        if (!valueNode || !['arrow_function', 'function_expression', 'function'].includes(valueNode.type)) {
          shadowed = true
          return
        }
      }
      // Destructuring declaration
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
 * Collect the set of top-level function-bearing declarations we can
 * transform. Includes:
 *   - `function foo() {}`            (function_declaration)
 *   - `const foo = () => ...`        (lexical_declaration with arrow_function value)
 *   - `const foo = function() {...}` (lexical_declaration with function_expression value)
 *   - `let foo = ...` / `var foo = ...` (same as const, just different declaration kind)
 *
 * Returns a Set<name>. Unlike the ESM transformer, we don't need to know
 * the "kind" because CJS doesn't have the export-stripping complication —
 * all of these are local bindings, and we route the holder population
 * through the same end-of-module trailer regardless.
 */
function collectTopLevelFunctionDeclarations(root) {
  const names = new Set()
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)
    if (!child) continue

    // function foo() {} or function* foo() {}
    if (child.type === 'function_declaration' ||
        child.type === 'generator_function_declaration') {
      const nameNode = child.childForFieldName('name')
      if (nameNode && nameNode.text) names.add(nameNode.text)
      continue
    }

    // const/let/var foo = <arrow|function-expression>
    if (child.type === 'lexical_declaration' ||
        child.type === 'variable_declaration') {
      for (let j = 0; j < child.childCount; j++) {
        const decl = child.child(j)
        if (!decl || decl.type !== 'variable_declarator') continue
        const nameNode = decl.childForFieldName('name')
        const valueNode = decl.childForFieldName('value')
        if (!nameNode || nameNode.type !== 'identifier' || !nameNode.text) continue
        if (!valueNode) continue
        if (valueNode.type === 'arrow_function' ||
            valueNode.type === 'function_expression' ||
            valueNode.type === 'function') {
          names.add(nameNode.text)
        }
      }
    }
  }
  return names
}

/**
 * Find all bare-name call sites that need to be rewritten. Same logic as
 * the ESM transformer — only calls inside function bodies (not top-level
 * calls), and only bare identifier callees (not member expressions like
 * `module.exports.foo()`).
 *
 * This is the key piece: the user's existing `module.exports.foo(...)` calls
 * are NOT rewritten (they already work — wrapCallees intercepts them via
 * the live holder mechanism). Only the bare-name `foo(...)` calls that
 * resolve to the local binding are rewritten to go through the holder.
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

    const calleeNode = node.childForFieldName('function')
    if (!calleeNode || calleeNode.type !== 'identifier') return
    if (!calleeSet.has(calleeNode.text)) return

    // Must be inside a function body (any depth)
    const fnAncestor = findAncestorOfType(node, FUNCTION_CONTEXT_TYPES)
    if (!fnAncestor) return

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
 * In CJS there are usually no `import` statements (those are ESM), but there
 * can be `require()` calls at the top. We insert the holder at the very top
 * of the module (offset 0) — this is safe because CJS modules are evaluated
 * top-to-bottom, and the holder is just an empty object at this point. It
 * gets populated at the end of the module (after all function declarations
 * have been hoisted).
 */
function findHolderInsertOffset(root) {
  // Insert at the very top — CJS doesn't have ESM-style imports to skip past.
  // (We could try to skip past top-level `require()` calls for cleanliness,
  // but that's not strictly necessary — the holder is empty at this point.)
  return 0
}

/**
 * Perform the actual transformation. Returns null if any safety check fails.
 */
function doTransform(root, source, calleeNames) {
  const calleeSet = new Set(calleeNames)

  // Safety check 1: no shadowing
  if (detectShadowing(root, calleeSet)) return null

  // Safety check 2: callees must include at least one transformable top-level
  // function declaration.
  const topLevelFns = collectTopLevelFunctionDeclarations(root)
  const calleesToTransform = calleeNames.filter(name => topLevelFns.has(name))
  if (calleesToTransform.length === 0) return null

  // Find all call sites to rewrite
  const sites = findCallSitesToRewrite(root, new Set(calleesToTransform))
  // If there are no internal bare-name calls to rewrite, transformation is
  // pointless — return null so the caller falls back to the original
  // behavior. (If the user only calls via `module.exports.foo(...)`, the
  // existing wrapCallees mechanism handles it without source transformation.)
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

  // Step 2: insert holder declaration at the top.
  // Use a leading newline to keep the file readable (the first line stays
  // blank-ish, then the holder declaration, then the user's code).
  const insertOffset = findHolderInsertOffset(root)
  const holderDecl = `const ${HOLDER_NAME} = {};\n`
  transformed =
    transformed.slice(0, insertOffset) +
    holderDecl +
    transformed.slice(insertOffset)

  // Step 3: append holder population + attach to module.exports at the end.
  //
  // The trailer does two things:
  //   1. Populate the holder with the original function references. By
  //      appending this at the END of the module, all function declarations
  //      (which are hoisted) and all const/let/var assignments (which run
  //      top-to-bottom) have completed by the time we read them.
  //   2. Attach the holder to `module.exports.__regretsHolder` so wrapCallees
  //      can find it after the dynamic import. wrapCallees looks for
  //      `targetModule[holderName]` (or `targetModule.default[holderName]`
  //      for CJS-as-ESM-import), and we attach to BOTH `module.exports`
  //      (the CJS live object) and to `exports` (which is the same object
  //      in CJS, but be explicit in case the user reassigned one of them).
  const assignments = calleesToTransform
    .map(name => `${HOLDER_NAME}.${name} = ${name};`)
    .join('\n')
  const trailer = `\n${assignments}\nmodule.exports.${HOLDER_NAME} = ${HOLDER_NAME};\n`
  transformed = transformed + trailer

  return { transformedSource: transformed, holderName: HOLDER_NAME }
}
