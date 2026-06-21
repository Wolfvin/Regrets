#!/usr/bin/env node
// capture_vue.mjs — Vue 3 component SSR capture
//
// Mirrors scripts/capture_react.mjs architecture but uses Vue 3 SSR
// (createSSRApp + renderToString from @vue/server-renderer) instead of
// React's renderToStaticMarkup.
//
// What gets fingerprinted:
//   input  = component props (JSON-serializable object from manifest.inputs)
//   output = normalized HTML string from renderToString
//   fingerprint = sha256(stableStringify(input) + '|' + stableStringify(output))
//                  → base36 → first 7 chars (identical to JS/Python/Go/Rust
//                  stacks because we delegate to scripts/fingerprint.js)
//
// Supported component formats (first release):
//   - .js / .mjs file exporting a Vue 3 component object via defineComponent
//     or as a plain { setup, props } object, OR a render function component.
//     (Mirrors capture_react.mjs which imports .js/.jsx directly without
//     a build step.)
//   - .vue Single-File Components are NOT supported in this release — they
//     require @vue/compiler-sfc + a compile step. See references/vue.md.
//
// Usage:
//   node scripts/capture_vue.mjs
//   node scripts/capture_vue.mjs --cluster invoice-card-render
//   node scripts/capture_vue.mjs --manifest ./regrets/manifest.json

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { fingerprint, normalize, stableStringify, extractSchema } from './fingerprint.js'
import { deepClone, normalizeHtml } from './ghost.js'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function getArg(flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}
const clusterFilter = getArg('--cluster')
const manifestPath = getArg('--manifest') ?? resolve(process.cwd(), 'regrets/manifest.json')

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  console.error(`   ${err.message}`)
  process.exit(1)
}

const clusters = clusterFilter
  ? manifest.clusters.filter(c => c.id === clusterFilter)
  : manifest.clusters.filter(c => c.stack === 'vue')

if (!clusters.length) {
  console.log('No Vue clusters found in manifest.')
  process.exit(0)
}

// ─── Resolve component module ─────────────────────────────────────────────────
//
// Same resolution precedence as capture_react.mjs:
//   1. Try manifest `file` path as-is
//   2. Fall back to .js if original was .vue (SFC → hand-written render fn)
//   3. Fall back to js/ mirror directory
//
// .vue SFC files require @vue/compiler-sfc to compile (not in scope for v1).
// We surface a clear error pointing the user at references/vue.md if they
// try to capture a .vue file directly.

function resolveComponentPath(file) {
  let absPath = resolve(process.cwd(), file)

  // Reject .vue SFCs up front — they need a compile step we don't ship in v1.
  if (absPath.endsWith('.vue')) {
    const jsFallback = absPath.replace(/\.vue$/, '.js')
    try {
      readFileSync(jsFallback)
      return jsFallback
    } catch { /* fall through to error */ }
    const mjsFallback = absPath.replace(/\.vue$/, '.mjs')
    try {
      readFileSync(mjsFallback)
      return mjsFallback
    } catch { /* fall through to error */ }
    throw new Error(
      `.vue Single-File Components require a compile step. ` +
      `Either pre-compile to .js (see references/vue.md) or use a render-function ` +
      `component in .js/.mjs. Looked for: ${jsFallback}, ${mjsFallback}`)
  }

  try {
    readFileSync(absPath)
    return absPath
  } catch { /* fall through */ }

  // Last resort: js/ mirror (matches capture_react.mjs line 78)
  const jsMirror = resolve(process.cwd(), 'js',
    file.replace(/^src\//, '').replace(/\.(vue|tsx|jsx)$/, '.js'))
  return jsMirror
}

// ─── Render a Vue component with props to static HTML ─────────────────────────
//
// Vue 3 SSR pattern:
//   const app = createSSRApp({ render: () => h(Component, props) })
//   const html = await renderToString(app)
//
// We wrap the user's component in a root app that passes props through,
// so users define their component exactly as they would in any Vue 3
// project (defineComponent, plain object, or render fn).

async function renderComponent(Component, props) {
  const app = createSSRApp({
    render: () => h(Component, props),
  })
  const rawHtml = await renderToString(app)
  return rawHtml
}

// ─── Compute fingerprint ──────────────────────────────────────────────────────
//
// Mirrors capture_react.mjs's fingerprint logic exactly. Default mode is
// "value" (fingerprint the normalized HTML string). Schema / mixed modes
// kept for parity, though the common case is value.

function computeFingerprint(input, html, clusterConfig = {}) {
  const {
    normalize: normRules = [],
    ignoreFields = [],
    fingerprintMode,
    valuePaths = [],
  } = clusterConfig

  if (fingerprintMode === 'schema') {
    const schema = extractSchema(html)
    return fingerprint(input, schema, { normalize: normRules, ignoreFields })
  }
  if (fingerprintMode === 'mixed') {
    const schema = extractSchema(html)
    const selectedValues = {}
    const combined = { schema, values: selectedValues }
    return fingerprint(input, combined, { normalize: normRules, ignoreFields })
  }
  // Default: value mode — fingerprint the normalized HTML string itself
  return fingerprint(input, html, { normalize: normRules, ignoreFields })
}

// ─── Capture Vue clusters ─────────────────────────────────────────────────────

const outDir = resolve(process.cwd(), 'regrets')
mkdirSync(outDir, { recursive: true })

let captured = 0
let failed = 0

for (const cluster of clusters) {
  const {
    id,
    entry,
    file,
    stripAttrs = [],
    normalize: normRules = [],
    ignoreFields = [],
    fingerprintMode,
    valuePaths = [],
    fingerprintLevel = 'entry',
    inputs,
  } = cluster

  console.log(`\n📡 Capturing Vue: ${id}`)
  console.log(`   Component: ${entry}`)
  console.log(`   File: ${file}`)

  try {
    const absPath = resolveComponentPath(file)
    const moduleUrl = pathToFileURL(absPath).href
    const mod = await import(moduleUrl)

    // Component lookup precedence: named export → default.named → default
    const Component = mod[entry] ?? mod.default?.[entry] ?? mod.default
    if (!Component) {
      throw new Error(`Component "${entry}" not found in ${file}`)
    }

    const testInputs = inputs ?? [{}]
    const results = []

    for (const input of testInputs) {
      const rawHtml = await renderComponent(Component, input)
      const html = normalizeHtml(rawHtml, stripAttrs)

      const fp = computeFingerprint(input, html, {
        normalize: normRules,
        ignoreFields,
        fingerprintMode,
        valuePaths,
      })

      results.push({ input, output: html, fp })
    }

    // Use first result as golden (mirrors capture_react.mjs)
    const { input, output, fp } = results[0]
    const regretPath = join(outDir, `${id}.regret`)
    const timestamp = new Date().toISOString()

    const content = [
      `cluster: ${id}`,
      `version: 1`,
      `fingerprint: ${fp}`,
      `captured: ${timestamp}`,
      `watches: [${entry}]`,
      `entry: ${entry}`,
      `stack: vue`,
      `renderMode: ssr`,
      normRules.length ? `normalize: [${normRules.join(', ')}]` : null,
      ignoreFields.length ? `ignoreFields: [${ignoreFields.join(', ')}]` : null,
      stripAttrs.length ? `stripAttrs: [${stripAttrs.join(', ')}]` : null,
      fingerprintMode ? `fingerprintMode: ${fingerprintMode}` : null,
      `---`,
      `INPUT  ${JSON.stringify(input)}`,
      `OUTPUT ${JSON.stringify(output)}`,
      `HASH   ${fp}`,
    ].filter(Boolean).join('\n')

    writeFileSync(regretPath, content, 'utf8')
    console.log(`   ✅ Fingerprint: ${fp}`)
    console.log(`   📄 Saved: regrets/${id}.regret`)
    captured++

  } catch (err) {
    console.error(`   ❌ Capture failed: ${err.message}`)
    failed++
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Vue capture complete: ${captured} captured, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
