# Case Study: MahjongRepository/mahjong — Riichi Mahjong Scoring Engine

## Repository

| Field     | Value                                  |
|-----------|----------------------------------------|
| Repo      | MahjongRepository/mahjong              |
| Domain    | Japanese riichi mahjong hand scoring   |
| Stack     | Python                                 |
| Stars     | 476                                    |
| License   | MIT                                    |
| Lines     | ~11,400                                |
| Files     | 105 Python files                       |

## Why This Repo?

MahjongRepository/mahjong is a scoring engine for Japanese riichi mahjong that computes hand values including yaku (winning pattern) detection, fu (minipoints) calculation, and shanten (tiles-to-win) numbers. It is one of the most complex niche scoring libraries on GitHub:

- **40+ yaku patterns** each with their own detection logic and interaction rules
- **Yakuman (limit hands)** with double-yakuman variants
- **Fu calculation** with 15+ conditional branches for wait types, meld states, and pair values
- **Shanten calculation** using depth-first search with mutable state
- **Hand decomposition** into all possible meld/pair combinations via backtracking

This complexity creates a rich surface for refactoring — duplicated patterns across yaku modules, god objects in HandCalculator, and deep nesting in shanten — while the pure-function nature (hand in, score out) makes it ideal for Regrets.

## Challenges for Regrets

### 1. Class-Based Entry Functions

The primary entry point `HandCalculator.estimate_hand_value()` is an instance method, not a module-level function. Regrets' Python capture script (`capture.py`) expects module-level callables via `getattr(module, entry_name)`.

**Solution**: Use the adapter pattern — create a thin wrapper module that instantiates the class and exposes a module-level function that delegates to it.

### 2. Keyword Arguments

`estimate_hand_value()` accepts keyword arguments (`melds=`, `dora_indicators=`, `config=`). Regrets' manifest only defines positional inputs. The adapter must bridge this gap by accepting structured input and unpacking it as kwargs.

### 3. Config Object Dependencies

Hand evaluation depends on `HandConfig` and `OptionalRules` objects. These must be constructed from serializable input data within the adapter, since Regrets can only store JSON-compatible input/output pairs.

### 4. Complex Output Structures

`estimate_hand_value()` returns a `HandResponse` object with nested attributes (`cost`, `fu_details`, `yaku`, `han`, `fu`, `error`). This must be serialized to a JSON-compatible dict for Regrets fingerprinting.

## Adapter Pattern

```python
# regret_adapters.py — thin wrapper for class-based entry functions
from mahjong.hand_calculating.hand import HandCalculator
from mahjong.hand_calculating.hand_config import HandConfig, OptionalRules
from mahjong.meld import Meld
from mahjong.tile import TilesConverter

_calculator = HandCalculator()

def estimate_hand_value_serialized(input_data):
    """
    Adapter: module-level function wrapping HandCalculator.estimate_hand_value.
    Accepts a JSON-serializable dict and returns a JSON-serializable dict.
    """
    tiles = TilesConverter.string_to_136_array(**input_data['tiles'])
    win_tile = input_data['win_tile']  # 136-format int
    melds = [Meld(**m) for m in input_data.get('melds', [])]
    dora_indicators = input_data.get('dora_indicators', [])

    config_data = input_data.get('config', {})
    options_data = config_data.get('options', {})
    options = OptionalRules(**options_data)
    config = HandConfig(options=options, **{k: v for k, v in config_data.items() if k != 'options'})

    result = _calculator.estimate_hand_value(
        tiles, win_tile,
        melds=melds,
        dora_indicators=dora_indicators,
        config=config,
    )

    return {
        'error': result.error,
        'han': result.han,
        'fu': result.fu,
        'yaku': [str(y) for y in result.yaku],
        'fu_details': [{'fu': f['fu'], 'reason': f['reason']} for f in result.fu_details],
        'cost': dict(result.cost) if result.cost else None,
    }
```

## Manifest Example

```json
{
  "clusters": [
    {
      "id": "tanyao-hand",
      "entry": "estimate_hand_value_serialized",
      "watches": ["estimate_hand_value_serialized"],
      "module": "regret_adapters",
      "file": "regret_adapters.py",
      "stack": "python",
      "kwargs": true,
      "fingerprintLevel": "entry",
      "inputs": [
        {
          "tiles": {"man": "234567", "pin": "234567", "honors": "88"},
          "win_tile": 36,
          "config": {"is_tsumo": false, "options": {"has_open_tanyao": true}}
        }
      ]
    }
  ]
}
```

## Key Insight: Regrets Needs Adapter Pattern Support for Class-Based Repos

Many Python libraries use classes as their primary API surface. Without an adapter pattern reference, agents using Regrets on class-based repos would struggle to write manifests. This case study documents the pattern for future agents.

## Lessons Learned

1. **Adapter modules are essential** for class-based Python repos. Without them, Regrets cannot capture fingerprints from the real API.
2. **Serialization adapters** must handle both input (dict → constructor kwargs) and output (object → JSON dict) conversions.
3. **Config objects** need a serialization strategy — flatten into dicts that `OptionalRules(**data)` can reconstruct.
4. **The adapter must be stored alongside the manifest** in the `regrets/` directory so it's version-controlled with the project.
