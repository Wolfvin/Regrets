# Adapter Generation — From Scan to Working Cluster

When you run `regret scan --generate-adapters` on a TypeScript project, Regrets can
now auto-generate adapter modules and manifest skeletons. This reference explains
what gets generated, why, and what you need to fill in.

---

## Why Adapters?

Regrets fingerprints JSON-serializable input/output pairs. But many real-world APIs
don't fit this model directly:

1. **Static class methods** — `CronExpressionParser.parse()` is a static method,
   not a standalone function. Regrets can't call it with `entry: "parse"`.
2. **Stateful iterators** — `CronExpression.next()` returns different values each
   call. You need to materialize the sequence, not fingerprint a single call.
3. **Class instance output** — `CronDate` from `.next()` has private fields and
   methods. `JSON.stringify()` would lose data without `.toISOString()`.

Adapters bridge this gap: they take plain JSON inputs, call the real library, and
return plain JSON outputs that Regrets can fingerprint.

---

## What `--generate-adapters` Creates

### regret-adapters.mjs

```js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// TODO: Uncomment and adjust the import path to match your compiled output
// const module = require('./dist/index.js');

// Adapter for: CronExpressionParser.parse (static method)
export function adaptCronExpressionParserParse(input) {
  // TODO: Call CronExpressionParser.parse(input) and serialize result
  // const result = module.CronExpressionParser.parse(input.expression, input.options);
  // return result;
}

// Adapter for: CronExpression (stateful iterator)
export function adaptCronExpressionIterate(input) {
  // TODO: Construct iterator and call next() N times
  // const instance = module.CronExpressionParser.parse(input.expression, input.options);
  // const results = [];
  // for (let i = 0; i < input.iterations; i++) {
  //   results.push(instance.next().toISOString()); // Adjust serialization as needed
  // }
  // return results;
}
```

### regrets/manifest.json

```json
{
  "preBuild": "npm run build",
  "clusters": [
    {
      "id": "cron-expression-parser-parse",
      "entry": "adaptCronExpressionParserParse",
      "watches": ["adaptCronExpressionParserParse"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": []
    },
    {
      "id": "cron-expression-iterate",
      "entry": "adaptCronExpressionIterate",
      "watches": ["adaptCronExpressionIterate"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": []
    }
  ]
}
```

---

## What You Must Do After Generation

1. **Uncomment the import** — Adjust the path to your compiled output (e.g., `./dist/index.js`)
2. **Implement the adapter bodies** — Fill in the TODO sections with actual calls
3. **Add representative inputs** — Fill the `inputs` arrays in the manifest with
   meaningful test data that exercises different code paths
4. **Handle timezone/determinism** — For time-based libraries, force UTC or add
   `normalize` rules (see `references/stateful-iterator.md`)
5. **Run `regret capture`** — Capture fingerprints and verify all clusters are green
6. **Run `regret drift`** — Ensure stable fingerprints across multiple runs

---

## When NOT to Use Adapters

- Functions that already take and return plain JSON (strings, numbers, arrays, plain objects)
- Pure utility functions (formatters, parsers that return primitives)
- Functions with no class instances in their API

For these, use standard function-based clusters without adapters.

---

## Integration with TypeScript Detection

When `regret scan` detects a `tsconfig.json` in the project:

1. It prints a note about needing `preBuild`
2. `--format manifest` includes `"preBuild": "npm run build"` automatically
3. `--generate-adapters` includes the `preBuild` in the generated manifest

This prevents the common mistake of forgetting to rebuild TypeScript before
re-validating fingerprints, which would cause false negatives.
