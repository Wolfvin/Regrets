// analyzer.js — Static analyzer backed by web-tree-sitter
//
// Extracts function definitions and call edges from source files using
// tree-sitter AST parsing. Replaces the regex-based extractor in scan.js
// when the file's language is supported (JavaScript, TypeScript, Python).
//
// WASM grammar files are committed under scripts/wasm/. The parser is
// lazily initialized on first use and reused across calls.
//
// Fallback contract: any error (unsupported language, parse failure, I/O
// error, malformed AST) returns { functions: [], edges: [] } so that
// scan.js can fall through to its regex extractor. Nothing throws.

import { extname, dirname, join } from 'path'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

// ─── Module state (lazy init) ────────────────────────────────────────────────
//
// web-tree-sitter ships as CommonJS .cjs even though this project is ESM.
// Use createRequire() to load it once. Parser/Language are cached on
// first call; grammar WASM files are loaded per-language on demand and
// cached too.

const _require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const WASM_DIR = join(__dirname, 'wasm')

let _parser = null
let _initPromise = null
const _loadedLanguages = new Map() // language name -> tree-sitter Language

async function getParser() {
  if (_parser) return _parser
  if (!_initPromise) {
    const wts = _require('web-tree-sitter')
    // Parser.init() is async — it bootstraps the WASM runtime. Cache the
    // promise so concurrent first-callers all await the same init.
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

// ─── Language config ─────────────────────────────────────────────────────────
//
// Each language defines:
//   - grammarName: file name in scripts/wasm/ (without .wasm)
//   - functionKinds: AST node types that declare a function
//   - functionKindHandlers: per-kind handler to extract the name (some kinds
//     store the name in a different child, e.g. lexical_declaration +
//     variable_declarator for `const fn = () => {}`)
//   - callKinds: AST node types that represent a function call
//   - calleeField: field name on the call node pointing to the callee
//
// Method calls (obj.method()) are intentionally NOT handled here — the
// callee field points to a member_expression whose text is "obj.method",
// which is not a stable identifier across files. Tracking them would
// require resolving the receiver type. Logged as TODO.

const LANG_CONFIG = {
  javascript: {
    grammarName: 'javascript',
    functionKinds: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    // `const fn = () => {}` and `let fn = function () {}` — the name lives
    // on the variable_declarator child of the lexical_declaration.
    declarationKinds: ['lexical_declaration', 'variable_declaration'],
    callKinds: ['call_expression'],
    calleeField: 'function',
  },
  typescript: {
    grammarName: 'typescript',
    functionKinds: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    declarationKinds: ['lexical_declaration', 'variable_declaration'],
    callKinds: ['call_expression'],
    calleeField: 'function',
  },
  python: {
    grammarName: 'python',
    functionKinds: ['function_definition'],
    declarationKinds: [], // Python has no `const fn = () => {}` equivalent at module scope
    callKinds: ['call'],
    calleeField: 'function',
  },
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect source language from a file path.
 *
 * @param {string} filePath
 * @returns {Promise<'javascript' | 'typescript' | 'python' | 'unknown'>}
 */
export async function detectLanguage(filePath) {
  const ext = extname(filePath).toLowerCase()
  const map = {
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
  }
  return map[ext] || 'unknown'
}

/**
 * Analyze a file for function definitions and call edges.
 *
 * Behavior:
 *   - If scopePath is a directory, the function still operates on a single
 *     file today. Directory traversal is left to the caller (scan.js).
 *     For a directory input, returns empty arrays (TODO: walk the dir).
 *   - If the language is unknown or unsupported, returns empty arrays.
 *   - If the file cannot be read or parsed, returns empty arrays.
 *   - Method calls (obj.method()) are skipped — callee is filtered to
 *     bare identifiers only.
 *
 * @param {string} scopePath - absolute path to a file (or folder — folder
 *   input currently returns empty arrays)
 * @returns {Promise<{functions: Array<{name: string, file: string, line: number}>, edges: Array<{from: string, to: string}>}>}
 */
export async function analyzeScope(scopePath) {
  const lang = await detectLanguage(scopePath)
  if (lang === 'unknown') return { functions: [], edges: [] }

  const config = LANG_CONFIG[lang]
  if (!config) return { functions: [], edges: [] }

  // Read file. Any I/O error → empty arrays (no throw).
  let source
  try {
    source = readFileSync(scopePath, 'utf8')
  } catch {
    return { functions: [], edges: [] }
  }

  // Load grammar. Any failure → empty arrays.
  let language
  try {
    language = await loadLanguage(config.grammarName)
  } catch {
    return { functions: [], edges: [] }
  }

  const parser = await getParser()
  parser.setLanguage(language)

  let tree
  try {
    tree = parser.parse(source)
  } catch {
    return { functions: [], edges: [] }
  }
  if (!tree) return { functions: [], edges: [] }

  try {
    const root = tree.rootNode
    const functions = []
    const edges = []

    // Collect function-like nodes with their byte ranges so we can resolve
    // enclosing functions for call sites via ancestor walk.
    const funcRanges = []

    walk(root, (node) => {
      // Direct function declarations: function_declaration, method_definition,
      // function_definition (Python), generator_function_declaration.
      if (config.functionKinds.includes(node.type)) {
        const name = readNameField(node)
        if (name) {
          functions.push({ name, file: scopePath, line: node.startPosition.row + 1 })
          funcRanges.push({
            name,
            startByte: node.startIndex,
            endByte: node.endIndex,
          })
        }
        return
      }

      // `const fn = () => {}` / `let fn = function () {}` — the function is
      // the value of a variable_declarator inside a lexical/variable
      // declaration. Walk one level: declaration → declarator → value.
      // Only register if the value is an arrow_function or function
      // expression; plain `const x = 5` is not a function.
      if (config.declarationKinds.includes(node.type)) {
        for (let i = 0; i < node.childCount; i++) {
          const declarator = node.child(i)
          if (!declarator || declarator.type !== 'variable_declarator') continue
          const nameNode = declarator.childForFieldName('name')
          const valueNode = declarator.childForFieldName('value')
          if (!nameNode || !valueNode) continue
          if (
            valueNode.type === 'arrow_function' ||
            valueNode.type === 'function_expression' ||
            valueNode.type === 'function'
          ) {
            const name = nameNode.text
            if (name) {
              functions.push({ name, file: scopePath, line: node.startPosition.row + 1 })
              funcRanges.push({
                name,
                startByte: node.startIndex,
                endByte: node.endIndex,
              })
            }
          }
        }
      }
    })

    // Second pass: find call sites and resolve their enclosing function.
    // Use ancestor walk via tree-sitter's parentNode (cheaper than
    // range-scan for trees of any meaningful depth).
    walk(root, (node) => {
      if (!config.callKinds.includes(node.type)) return

      const calleeNode = node.childForFieldName(config.calleeField)
      if (!calleeNode) return

      // TODO: handle method calls. When the callee is a member_expression
      // (e.g. `obj.method()`), the text is "obj.method" — not a stable
      // identifier. We skip these until receiver-type resolution lands.
      // For now, only bare identifier callees (`foo()`) are tracked.
      if (calleeNode.type !== 'identifier') return

      const calleeName = calleeNode.text
      if (!calleeName) return

      // Find enclosing function by walking up the parent chain.
      let parent = node.parent
      let fromName = null
      while (parent) {
        // Case 1: direct function declaration (function_declaration,
        // method_definition, function_definition, generator_function_declaration).
        if (config.functionKinds.includes(parent.type)) {
          fromName = readNameField(parent)
          break
        }
        // Case 2: `const fn = () => { ... }` or `let fn = function () { ... }`.
        // Only treat the lexical/variable declaration as the enclosing
        // function if its declarator's value is itself a function-like node.
        // A `const r = add(1, 2)` line is NOT an enclosing function — keep
        // walking up to find the real caller.
        if (config.declarationKinds.includes(parent.type) &&
            isFunctionBearingDeclaration(parent)) {
          fromName = readDeclarationFunctionName(parent, node)
          break
        }
        parent = parent.parent
      }

      edges.push({ from: fromName, to: calleeName })
    })

    return { functions, edges }
  } catch {
    return { functions: [], edges: [] }
  } finally {
    tree.delete()
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursive pre-order walk. Calls fn(node) for every node, including
 * the root. tree-sitter nodes are cheap to traverse (no allocation per
 * node on the JS side — they're views into the WASM heap).
 */
function walk(node, fn) {
  fn(node)
  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), fn)
  }
}

/**
 * Read the "name" field from a function-like node. Returns null if the
 * field is missing (anonymous arrow functions, generators without names).
 */
function readNameField(node) {
  const nameNode = node.childForFieldName('name')
  return nameNode ? nameNode.text : null
}

/**
 * True if the given lexical/variable declaration has at least one
 * variable_declarator whose value is an arrow_function or function
 * expression — i.e., this declaration is binding a function to a name.
 * Used to distinguish `const fn = () => {}` (enclosing function) from
 * `const r = add(1, 2)` (NOT an enclosing function).
 */
function isFunctionBearingDeclaration(declNode) {
  for (let i = 0; i < declNode.childCount; i++) {
    const declarator = declNode.child(i)
    if (!declarator || declarator.type !== 'variable_declarator') continue
    const valueNode = declarator.childForFieldName('value')
    if (!valueNode) continue
    if (
      valueNode.type === 'arrow_function' ||
      valueNode.type === 'function_expression' ||
      valueNode.type === 'function'
    ) {
      return true
    }
  }
  return false
}

/**
 * For a `const fn = () => { foo() }` declaration that we already know is
 * function-bearing, return the name of the declarator whose value's byte
 * range contains the call node. If the call lives outside any function
 * value (e.g. inside `const r = add(1, 2)` on the same declaration line
 * — shouldn't happen given isFunctionBearingDeclaration, but be safe),
 * return null.
 */
function readDeclarationFunctionName(declNode, callNode) {
  for (let i = 0; i < declNode.childCount; i++) {
    const declarator = declNode.child(i)
    if (!declarator || declarator.type !== 'variable_declarator') continue
    const valueNode = declarator.childForFieldName('value')
    if (!valueNode) continue
    if (
      (valueNode.type === 'arrow_function' ||
        valueNode.type === 'function_expression' ||
        valueNode.type === 'function') &&
      callNode.startIndex >= valueNode.startIndex &&
      callNode.endIndex <= valueNode.endIndex
    ) {
      const nameNode = declarator.childForFieldName('name')
      return nameNode ? nameNode.text : null
    }
  }
  return null
}
