# CSS Stack Guide

Regression fingerprinting for CSS transformation tools — PostCSS plugins, Sass/SCSS compilers, CSS-in-JS output, custom property resolvers, and pure functions that return CSS strings or objects.

CSS clusters use the **JS runner** (`capture.js` / `validate.js`). No separate binary or runtime is needed — your CSS tool is treated as a JavaScript function that takes CSS input and returns transformed CSS output.

---

## Why CSS Needs Regression Testing

CSS tools are code transformers. Like any compiler or transpiler, they can silently break when refactored. A PostCSS plugin that reorders rules, a Sass function that miscalculates a color, or a CSS-in-JS library that drops a media query — these are output regressions that Regrets catches.

Common scenarios where CSS regression testing matters:

- **PostCSS plugins**: Custom transforms that rewrite declarations, add vendor prefixes, or optimize selectors. A refactor could silently drop a declaration or change specificity.
- **Sass/SCSS functions**: Functions that compute values (color manipulation, responsive math, fluid typography). A variable rename or mixin change can alter compiled output.
- **CSS-in-JS**: Libraries like Emotion or styled-components that generate CSS from JavaScript objects. Changes to the style object or theme resolver can produce different class names or rule orderings.
- **Custom property resolvers**: Tools that resolve `var(--custom-prop)` to concrete values for older browsers. A resolver bug can swap colors or spacing.
- **CSS frameworks**: Build-time CSS generation where input config produces a stylesheet. Changing the config schema or default values alters output.

---

## Quick Start

1. Write your CSS transformer as a pure JavaScript function (exported from a .js file)
2. Run `node scripts/regret.js init --stack css`
3. Edit `regrets/manifest.json` with your cluster definitions
4. Run `node scripts/regret.js capture` to capture fingerprints
5. Run `node scripts/regret.js validate` to validate

---

## Manifest for CSS Clusters

CSS clusters use `"stack": "css"` and follow the same manifest format as JS clusters. The `file` field points to a JavaScript module that exports your CSS transformation function.

```json
{
  "clusters": [
    {
      "id": "postcss-color-replacer",
      "entry": "transform",
      "watches": ["transform"],
      "file": "plugins/color-replacer.js",
      "stack": "css",
      "fingerprintLevel": "entry",
      "description": "Replaces hex colors with RGB values in CSS declarations",
      "inputs": [
        { "css": ".btn { color: #ff0000; background: #00ff00; }", "opts": {} },
        { "css": ".card { border: 1px solid #333; }", "opts": { "preserveHex": true } }
      ]
    }
  ]
}
```

### CSS-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | Yes | Must be `"css"` |
| `file` | Yes | Path to the JS module exporting your CSS function |
| `entry` | Yes | Name of the exported function to call |
| `watches` | Yes | Array of function names to instrument (usually same as `entry`) |
| `fingerprintLevel` | No | `"entry"` (default) or `"schema"` |
| `normalize` | No | Normalization rules for non-deterministic output (see below) |
| `ignoreFields` | No | Fields to exclude from fingerprint |
| `seed` | No | RNG seed for deterministic output in randomized CSS transforms |

---

## Pattern 1: PostCSS Plugin

PostCSS plugins are functions that receive a CSS AST and return a transformed AST. To fingerprint them, wrap the core transform logic in a pure function.

### Setup

```javascript
// plugins/my-postcss-plugin.js
import postcss from 'postcss'

/**
 * Pure transform function — takes CSS string + options, returns CSS string.
 * This is what Regrets fingerprints.
 */
export function transform({ css, opts = {} }) {
  const result = postcss([myPlugin(opts)]).process(css, { from: undefined })
  return result.css
}

/**
 * The actual PostCSS plugin — only used in production, not fingerprinted directly.
 */
function myPlugin(opts = {}) {
  return {
    postcssPlugin: 'my-plugin',
    Rule(rule) {
      // Your transform logic here
      if (opts.sortDeclarations) {
        rule.nodes.sort((a, b) => a.prop.localeCompare(b.prop))
      }
    }
  }
}
myPlugin.postcss = true
```

### Manifest

```json
{
  "id": "my-postcss-plugin",
  "entry": "transform",
  "watches": ["transform"],
  "file": "plugins/my-postcss-plugin.js",
  "stack": "css",
  "fingerprintLevel": "entry",
  "inputs": [
    { "css": ".a { color: red; font-size: 12px; }", "opts": { "sortDeclarations": true } },
    { "css": ".b { margin: 0; padding: 0; }", "opts": { "sortDeclarations": false } }
  ]
}
```

### Key Point

The `transform` function is pure: same CSS input + same options always produce the same CSS output. The PostCSS plugin internals can be refactored freely — as long as `transform` still returns the same CSS string, the fingerprint matches.

---

## Pattern 2: Sass/SCSS Compilation

Sass compilation is a pure function: source string in, CSS string out. This is a natural fit for Regrets.

### Setup

```javascript
// src/sass-compiler.js
import sass from 'sass'

/**
 * Compile Sass source to CSS string.
 * Pure function: same source + same options = same CSS output.
 */
export function compileSass({ source, style = 'expanded' }) {
  const result = sass.compileString(source, { style })
  return result.css
}

/**
 * Compile with custom importer — useful for testing @use and @forward.
 */
export function compileWithImports({ source, importMap = {} }) {
  const result = sass.compileString(source, {
    importer: {
      findFileUrl(url) {
        if (importMap[url]) return new URL(`file://${importMap[url]}`)
        return null
      }
    }
  })
  return result.css
}
```

### Manifest

```json
{
  "id": "sass-compile",
  "entry": "compileSass",
  "watches": ["compileSass"],
  "file": "src/sass-compiler.js",
  "stack": "css",
  "inputs": [
    { "source": "$primary: #333; .btn { color: $primary; }", "style": "expanded" },
    { "source": "@mixin flex { display: flex; } .container { @include flex; }", "style": "compressed" }
  ]
}
```

### Normalization for Sass Output

Sass output may include comments with file paths or timestamps. Use `normalize` rules to strip non-deterministic parts:

```json
{
  "normalize": ["absPaths", "timestamps"],
  "ignoreFields": ["sourceMap"]
}
```

---

## Pattern 3: CSS-in-JS (Emotion / styled-components)

CSS-in-JS libraries generate CSS from JavaScript style objects. The output includes generated class names and serialized rules. To fingerprint, extract the pure style resolution function.

### Setup: Emotion

```javascript
// src/emotion-serializer.js
import { serializeStyles } from '@emotion/serialize'

/**
 * Pure function: takes a style object, returns the serialized CSS string.
 * The class name is deterministic for the same style input.
 */
export function serializeEmotionStyles({ styles, name = 'css' }) {
  const serialized = serializeStyles([styles])
  return {
    styles: serialized.styles,
    name: serialized.name
  }
}
```

### Setup: styled-components

```javascript
// src/styled-resolver.js

/**
 * Resolve a styled-components style object to a CSS string.
 * Pure function: same input theme + styles = same CSS output.
 */
export function resolveStyledComponent({ styles, theme = {} }) {
  // Execute the style function with the theme
  const resolvedStyles = typeof styles === 'function' ? styles(theme) : styles
  // Flatten to CSS string
  return flattenStylesToCSS(resolvedStyles)
}

function flattenStylesToCSS(obj) {
  return Object.entries(obj)
    .map(([key, value]) => {
      if (typeof value === 'object') {
        return `${key} { ${flattenStylesToCSS(value)} }`
      }
      return `${key}: ${value};`
    })
    .join(' ')
}
```

### Manifest

```json
{
  "id": "emotion-serialize",
  "entry": "serializeEmotionStyles",
  "watches": ["serializeEmotionStyles"],
  "file": "src/emotion-serializer.js",
  "stack": "css",
  "fingerprintLevel": "entry",
  "inputs": [
    { "styles": { "color": "red", "fontSize": "16px" }, "name": "css" },
    { "styles": { "display": "flex", "alignItems": "center" }, "name": "css" }
  ]
}
```

### Normalization for CSS-in-JS

Generated class names may be non-deterministic (hash-based). Use `normalize` to stabilize:

```json
{
  "normalize": ["dynamicClasses"],
  "ignoreFields": ["generatedClassName"]
}
```

---

## Pattern 4: Pure CSS Function

Any JavaScript function that takes input and returns a CSS string or object can be fingerprinted directly. No framework integration needed.

### Example: Responsive Clamp Calculator

```javascript
// src/responsive-clamp.js

/**
 * Calculate a CSS clamp() value for fluid typography.
 * Pure function: same parameters always produce the same clamp() string.
 */
export function fluidClamp({ minPx, maxPx, minVw, maxVw, property = 'font-size' }) {
  const slope = (maxPx - minPx) / (maxVw - minVw)
  const intercept = minPx - slope * minVw
  const slopeVw = (slope * 100).toFixed(4)
  const interceptRem = (intercept / 16).toFixed(4)
  const minRem = (minPx / 16).toFixed(4)
  const maxRem = (maxPx / 16).toFixed(4)
  return {
    [property]: `clamp(${minRem}rem, ${interceptRem}rem + ${slopeVw}vw, ${maxRem}rem)`
  }
}
```

### Manifest

```json
{
  "id": "fluid-clamp",
  "entry": "fluidClamp",
  "watches": ["fluidClamp"],
  "file": "src/responsive-clamp.js",
  "stack": "css",
  "fingerprintLevel": "entry",
  "inputs": [
    { "minPx": 16, "maxPx": 24, "minVw": 320, "maxVw": 1200, "property": "font-size" },
    { "minPx": 12, "maxPx": 16, "minVw": 768, "maxVw": 1440, "property": "line-height" }
  ]
}
```

---

## Normalization: CSS-Specific Patterns

CSS output can contain non-deterministic values that change between runs even when the transform is correct. Use normalization rules to stabilize fingerprints.

| Non-Deterministic Source | CSS Example | Normalization Rule | Replacement |
|--------------------------|-------------|-------------------|-------------|
| Source map comments | `/*# sourceMappingURL=... */` | `"absPaths"` | `<ROOT>/...` |
| Timestamps in comments | `/* Generated: 2025-01-15 */` | `"timestamps"` | `<TIMESTAMP>` |
| Hash-based class names | `.css-1a2b3c` | `"ignoreFields"` on that key | Excluded |
| File paths in errors | `/home/user/project/src/style.css` | `"absPaths"` | `<ROOT>/...` |
| Random color order | Generated color palettes | `"seed": 42` | Deterministic |

### Example: Normalizing a PostCSS Plugin

```json
{
  "id": "postcss-autoprefixer",
  "entry": "transform",
  "watches": ["transform"],
  "file": "plugins/autoprefix.js",
  "stack": "css",
  "normalize": ["absPaths"],
  "ignoreFields": ["sourceMap"],
  "inputs": [
    { "css": ".btn { display: flex; }", "opts": { "browsers": ["last 2 versions"] } }
  ]
}
```

---

## Rules for CSS Cluster Design

1. **Only fingerprint pure transforms** — functions that take CSS input and return CSS output without side effects (no file writes, no HTTP requests, no DOM manipulation).
2. **Wrap framework APIs** — PostCSS plugins, Sass compilers, and CSS-in-JS resolvers should be wrapped in a pure function that the Regrets runner calls directly.
3. **Avoid fingerprinting the full framework pipeline** — fingerprint the specific transform, not the build system. A PostCSS plugin's `transform` function is the right granularity; the entire PostCSS runner is not.
4. **Normalize source maps and file paths** — these change between environments and should be excluded via `ignoreFields` or `normalize` rules.
5. **Use `seed` for randomized output** — if your CSS transform uses randomness (color palette generators, randomized class names), set `seed` for deterministic output.
6. **Return structured output** — prefer returning `{ css: "...", warnings: [...] }` over a bare CSS string. This makes `ignoreFields` on `warnings` possible.

---

## Full Workflow Example

```bash
# 1. Initialize with CSS stack
node scripts/regret.js init --stack css

# 2. Edit manifest with your CSS cluster definitions
#    (see patterns above)

# 3. Capture fingerprints
node scripts/regret.js capture

# 4. Validate
node scripts/regret.js validate

# 5. Drift detection (5 runs)
node scripts/regret.js drift

# 6. Health check
node scripts/regret.js health

# 7. Refactor your CSS tool freely

# 8. Re-validate after refactor
node scripts/regret.js validate
```

---

## Compatibility with Other Stacks

CSS clusters can coexist with JS, TypeScript, Python, and other stacks in the same `manifest.json`. The capture/validate scripts dispatch by `stack` field:

```json
{
  "clusters": [
    {
      "id": "postcss-transform",
      "entry": "transform",
      "stack": "css",
      "file": "plugins/my-plugin.js"
    },
    {
      "id": "date-formatter",
      "entry": "formatDate",
      "stack": "js",
      "file": "src/date-utils.js"
    },
    {
      "id": "python-encoder",
      "entry": "encode",
      "stack": "python",
      "module": "my_package.encoder"
    }
  ]
}
```

- `capture.js` processes `stack: "js"`, `stack: "ts"`, and `stack: "css"` clusters
- `capture.py` processes `stack: "python"` clusters
- `capture_rust.sh` processes `stack: "rust"` clusters
- `capture_go.sh` processes `stack: "go"` clusters
- `health.js` reads the same `audit.log` — health reports cover all stacks

---

## Real-World Use Cases

### PostCSS Plugin: `postcss-preset-env`

Fingerprint the cascade layer transform to ensure browser fallbacks are generated correctly:

```json
{
  "id": "postcss-preset-env-cascade-layers",
  "entry": "transform",
  "watches": ["transform"],
  "file": "plugins/cascade-layers-plugin.js",
  "stack": "css",
  "normalize": ["absPaths"],
  "ignoreFields": ["sourceMap"],
  "inputs": [
    { "css": "@layer base, components; @layer base { .btn { color: red; } }", "opts": { "stage": 2 } }
  ]
}
```

### Sass Function: Color Manipulation

Fingerprint a Sass color function to ensure the darken/lighten math is correct:

```json
{
  "id": "sass-color-manipulation",
  "entry": "compileSass",
  "watches": ["compileSass"],
  "file": "src/sass-compiler.js",
  "stack": "css",
  "inputs": [
    { "source": "@use 'sass:color'; .alert { color: color.adjust(#ff0000, $lightness: -20%); }" },
    { "source": "@use 'sass:color'; .info { color: color.adjust(#00ff00, $alpha: -0.5); }" }
  ]
}
```

### CSS-in-JS: Theme Resolution

Fingerprint the theme resolver to ensure design tokens resolve correctly:

```json
{
  "id": "theme-resolver",
  "entry": "resolveThemeTokens",
  "watches": ["resolveThemeTokens"],
  "file": "src/theme-resolver.js",
  "stack": "css",
  "inputs": [
    { "theme": { "colors": { "primary": "#007bff" } }, "tokens": ["colors.primary"] }
  ]
}
```
