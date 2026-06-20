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

import { extname, dirname, join, resolve } from 'path'
import { readFileSync, statSync, readdirSync } from 'fs'
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
// Method calls (obj.method()) are handled by extracting the property
// name from member_expression (JS/TS) or attribute (Python). The
// receiver object is not resolved — only the method name is captured.
// External method names (e.g. arr.map, arr.filter) that don't match
// any in-file function are filtered out by install.js automatically.

const LANG_CONFIG = {
  javascript: {
    grammarName: 'javascript',
    functionKinds: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    // `const fn = () => {}` and `let fn = function () {}` — the name lives
    // on the variable_declarator child of the lexical_declaration.
    declarationKinds: ['lexical_declaration', 'variable_declaration'],
    callKinds: ['call_expression'],
    calleeField: 'function',
    // Method call extraction: when calleeField yields a member_expression,
    // extract the method name from the `property` child.
    methodCalleeInfo: { nodeType: 'member_expression', propertyField: 'property' },
  },
  typescript: {
    grammarName: 'typescript',
    functionKinds: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    declarationKinds: ['lexical_declaration', 'variable_declaration'],
    callKinds: ['call_expression'],
    calleeField: 'function',
    methodCalleeInfo: { nodeType: 'member_expression', propertyField: 'property' },
  },
  python: {
    grammarName: 'python',
    functionKinds: ['function_definition'],
    declarationKinds: [], // Python has no `const fn = () => {}` equivalent at module scope
    callKinds: ['call'],
    calleeField: 'function',
    // Python attribute access: obj.method() → (attribute object: (identifier) attribute: (identifier))
    methodCalleeInfo: { nodeType: 'attribute', propertyField: 'attribute' },
  },
}

// ─── Directory traversal ─────────────────────────────────────────────────────
//
// Directories to skip when walking a directory tree in analyzeScope().
// Matches the filter used by scan.js and install.js.

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '__pycache__',
  'regrets', '.next', '.nuxt', 'coverage', '.cache', '.turbo',
])

/**
 * Recursively discover source files (JS/TS/Python) under a directory.
 * Skips SKIP_DIRS entries and hidden directories (starting with '.').
 *
 * @param {string} dir - absolute path to a directory
 * @returns {string[]} array of absolute file paths
 */
function discoverSourceFiles(dir) {
  const files = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.')) continue
        files.push(...discoverSourceFiles(join(dir, entry.name)))
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py'].includes(ext)) {
          files.push(join(dir, entry.name))
        }
      }
    }
  } catch {
    // unreadable dir → return what we have so far
  }
  return files
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
 * Analyze a file or directory for function definitions and call edges.
 *
 * Behavior:
 *   - If scopePath is a file → analyze that single file (original behavior).
 *   - If scopePath is a directory → recursively discover all JS/TS/Python
 *     files, analyze each one, and merge the results:
 *       - functions: concat all, dedup by (name + file)
 *       - edges: concat all (edges already carry file info via functions list)
 *   - Skip node_modules/, .git/, dist/, build/ and other non-source dirs.
 *   - If the language is unknown or unsupported, returns empty arrays.
 *   - If the file cannot be read or parsed, returns empty arrays.
 *   - Method calls (obj.method(), this.helper(), super.init()) are
 *     tracked by extracting the method name from the property/attribute
 *     child of the member_expression/attribute node. Receiver type is
 *     NOT resolved — only the method name is captured.
 *
 * @param {string} scopePath - absolute path to a file or directory
 * @returns {Promise<{functions: Array<{name: string, file: string, line: number}>, edges: Array<{from: string, to: string}>}>}
 */
export async function analyzeScope(scopePath) {
  // ── Directory mode: recursively walk and merge ──────────────────────────
  let isDir = false
  try {
    isDir = statSync(scopePath).isDirectory()
  } catch {
    // Cannot stat — treat as file; the file-read below will also fail
    // and return empty arrays.
  }

  if (isDir) {
    const sourceFiles = discoverSourceFiles(scopePath)
    const allFunctions = []
    const allEdges = []

    for (const filePath of sourceFiles) {
      const lang = await detectLanguage(filePath)
      if (lang === 'unknown') continue

      const result = await analyzeScope(filePath)
      allFunctions.push(...result.functions)
      allEdges.push(...result.edges)
    }

    // Dedup functions by (name + file) — same-named function in different
    // files is fine, but duplicate entries from the same file should not
    // appear (e.g. if discoverSourceFiles somehow lists a file twice).
    const seen = new Set()
    const dedupedFunctions = []
    for (const fn of allFunctions) {
      const key = `${fn.name}::${fn.file}`
      if (!seen.has(key)) {
        seen.add(key)
        dedupedFunctions.push(fn)
      }
    }

    return { functions: dedupedFunctions, edges: allEdges }
  }

  // ── File mode: original single-file behavior ───────────────────────────
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

    // #267: Check for parse errors in the tree. If the root has errors,
    // emit a warning so the user knows the analysis may be incomplete.
    // Individual function nodes are checked separately — their own
    // hasError flag indicates whether that specific function's subtree
    // contains errors (e.g. a malformed function body).
    if (root.hasError) {
      console.warn(
        `[analyzer] Parse errors detected in ${scopePath}. ` +
        `Functions with errors in their subtree will be excluded.`
      )
    }

    // Collect function-like nodes with their byte ranges so we can resolve
    // enclosing functions for call sites via ancestor walk.
    const funcRanges = []

    walk(root, (node) => {
      // Direct function declarations: function_declaration, method_definition,
      // function_definition (Python), generator_function_declaration.
      if (config.functionKinds.includes(node.type)) {
        const name = readNameField(node)
        if (name) {
          // #267: Skip functions whose subtree contains parse errors.
          // node.hasError is true when the function's own AST subtree
          // has ERROR nodes (e.g. malformed body), but false for
          // correctly-parsed functions that are merely siblings of errors.
          if (node.hasError) {
            console.warn(
              `[analyzer] Excluding function "${name}" at line ${node.startPosition.row + 1} — parse error in function subtree`
            )
            return
          }
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
              // #267: Skip declaration-based functions whose subtree has errors.
              if (node.hasError) {
                console.warn(
                  `[analyzer] Excluding function "${name}" at line ${node.startPosition.row + 1} — parse error in function subtree`
                )
                continue
              }
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

      // Resolve callee name: bare identifier or method call.
      // For bare calls like `foo()`, calleeNode.type === 'identifier'.
      // For method calls like `obj.method()` or `this.helper()`,
      // calleeNode is a member_expression (JS/TS) or attribute (Python).
      // We extract the property/attribute name as the callee.
      //
      // #287: Method calls are marked with isMethod: true so that downstream
      // consumers (install.js) can distinguish them from bare calls. This
      // prevents false-positive matching where obj.process() would collide
      // with a standalone function named "process".
      let calleeName
      let isMethodCall = false
      let methodReceiver = null
      if (calleeNode.type === 'identifier') {
        calleeName = calleeNode.text
      } else if (config.methodCalleeInfo && calleeNode.type === config.methodCalleeInfo.nodeType) {
        const propNode = calleeNode.childForFieldName(config.methodCalleeInfo.propertyField)
        calleeName = propNode ? propNode.text : null
        isMethodCall = true
        // Extract the receiver object name for context (e.g. "obj", "this", "super")
        const objectNode = calleeNode.childForFieldName('object')
        if (objectNode) {
          methodReceiver = objectNode.text
        }
      } else {
        return
      }
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

      const edge = { from: fromName, to: calleeName }
      // #287: Tag method calls so install.js can avoid false-positive
      // matching against bare functions with the same name.
      if (isMethodCall) {
        edge.isMethod = true
        edge.methodReceiver = methodReceiver
      }
      edges.push(edge)
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
