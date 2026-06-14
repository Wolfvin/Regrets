# Lambda-Assigned Functions Pattern

## Problem

Some Python libraries — especially scientific, mathematical, and niche domain libraries — use lambda assignments instead of `def` statements for short functions:

```python
# Instead of def:
quadrants_of_the_raasi = lambda raasi: [(raasi+1)%12, (raasi+4)%12, (raasi+7)%12, (raasi+10)%12]
norm360 = lambda angle: angle % 360
```

These are fully callable and work identically to `def`-defined functions at runtime. However, they present unique challenges for regression testing tools:

### Challenge 1: AST Detection

The `regret scan` command uses Python's `ast.NodeVisitor` to discover functions. The standard `visit_FunctionDef` method only catches `def` statements — lambda assignments are `ast.Assign` nodes with `ast.Lambda` values, and are invisible to the standard visitor.

**Solution:** The scanner now includes `visit_Assign` which detects `name = lambda ...` patterns and includes them in scan results with `isLambda: True`.

### Challenge 2: `__name__` Attribute

Lambda functions have `__name__ == '<lambda>'`, which makes them indistinguishable from each other in traces and debugging. When the Ghost proxy wraps a lambda, `@wraps(orig)` copies `__name__` from the original, resulting in `<lambda>` for all of them.

**Solution:** The Ghost proxy in `capture.py` now detects when the wrapped function's `__name__` is `'<lambda>'` and replaces it with the variable name from the watch list. This ensures the recorder captures the meaningful name (e.g., `quadrants_of_the_raasi`) rather than `<lambda>`.

### Challenge 3: Manifest Configuration

Lambda-assigned functions work as entry points in manifests exactly the same as `def`-defined functions:

```json
{
  "id": "quadrants-of-the-raasi",
  "entry": "quadrants_of_the_raasi",
  "watches": ["quadrants_of_the_raasi"],
  "module": "jhora.horoscope.chart.house",
  "stack": "python",
  "inputs": [0, 5, 11]
}
```

The `entry` field uses the variable name, and `getattr(module, 'quadrants_of_the_raasi')` correctly retrieves the lambda.

## Case Study: PyJHora's house.py

PyJHora is a Vedic astrology calculation library with a `house.py` module containing ~30 lambda-assigned functions for house relationship calculations:

| Lambda Variable | Purpose |
|---|---|
| `get_relative_house_of_planet` | Relative house number between two houses |
| `trines_of_the_raasi` | Trikona (5th/9th) houses from a given sign |
| `quadrants_of_the_raasi` | Kendra (1st/4th/7th/10th) houses |
| `dushthanas_of_the_raasi` | Dusthana (6th/8th/12th) houses |
| `upachayas_of_the_raasi` | Upachaya (3rd/6th/10th/11th) houses |
| `panapharas_of_the_raasi` | Panaphara (2nd/5th/8th/11th) houses |
| `apoklimas_of_the_raasi` | Apoklima (3rd/6th/9th/12th) houses |
| `ketu` | 180° offset from Rahu longitude |
| `rahu` | 180° offset from Ketu longitude |

These are all pure functions ideal for Regrets fingerprinting — they take numeric inputs and return deterministic lists/floats with no side effects. Without the lambda detection improvement, `regret scan` would have reported zero cluster suggestions for this module, making it impossible for an agent to discover these functions.

## Impact on Other Domains

Lambda-assigned functions are common in:
- **Mathematical libraries** — short conversion formulas (degrees/radians, coordinate transforms)
- **Physics/engineering** — unit conversions, physical constants as functions
- **Game/animation** — easing functions, interpolation lambdas
- **Data science** — feature extraction lambdas, mapping/transformation pipelines
- **Niche domains** — astrology, music theory, typography calculations

Without this improvement, any project using lambda-assigned functions as part of its public API would be invisible to `regret scan`, and an agent would have to manually discover and document these functions — a gap that could easily lead to incomplete cluster coverage.
