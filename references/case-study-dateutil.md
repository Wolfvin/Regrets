# Case Study: python-dateutil

## Repo

**python-dateutil** — https://github.com/dateutil/dateutil
Useful extensions to the standard Python datetime features.

**Stars**: 2622 | **Language**: Python | **License**: BSD-3-Clause

## Why This Repo?

python-dateutil is a foundational Python library with unique challenges that
previous Regrets case studies (encoding/transliteration libraries) never encountered:

1. **Datetime return types** — Not JSON-serializable by default
2. **Non-deterministic defaults** — `parse()` and `rrule()` use `datetime.now()`
3. **Unbounded lazy iterators** — `rrule` objects may produce infinite sequences
4. **Complex timezone objects** — System-dependent `tzlocal`, `tzfile`
5. **God objects** — `rrule.__init__` (270 lines), `rrule._iter` (254 lines)
6. **Stateful singletons** — `DEFAULTPARSER`, `DEFAULT_ISOPARSER`, `UTC`

## Gaps Discovered in Regrets (Pre-Refactor)

| Gap | Discovery | Fix |
|-----|-----------|-----|
| deep_clone fails for datetime | Trying to capture easter() output | `_serialize_datetime()` |
| json_serialize crashes | Writing .regret files | deep_clone datetime dict |
| No outputTransform: isoformat | Wanting readable .regret files | New transform option |
| No normalize: datetimeNow | parse() using datetime.now() | New normalize rule |
| materialize_output has no limit | rrule hanging capture | maxYields/materializeLimit |
| No datetime docs | No guidance for datetime libraries | datetime-objects.md |
| _chain_step.py crashes | Chain validation of datetime clusters | deep_clone in chain step |

## Gaps Discovered During Refactoring (Post-Refactor)

| Gap | Moment | Fix |
|-----|--------|-----|
| Rebase can silently drop improvements | After another agent merged PRs, our _serialize_datetime was lost | This case study documents the risk; agents must verify improvements after rebase |
| "Uncalled watches" false positive | When entry == watch name, warning fires incorrectly | Known minor issue; not blocking |
| Chain fingerprints unstable across Regrets updates | When fingerprint.py itself changes, all chain hashes become invalid | Agents must re-capture chains after Regrets updates |

## Improvements Summary

| Improvement | Files | Type |
|---|---|---|
| `_serialize_datetime()` | scripts/fingerprint.py | New function |
| `datetimeNow` normalize rule | fingerprint.py, fingerprint.js | New feature |
| `isoformat` outputTransform | capture.py, validate.py, outputTransform.js | New feature |
| `materializeLimit` alias | capture.py, validate.py | New alias |
| Custom iterable detection | fingerprint.py | Enhancement |
| `_chain_step.py` deep_clone | scripts/_chain_step.py | Bug fix |
| datetime-objects.md | references/ | Documentation |

## Key Takeaway

Previous case studies involved string-returning libraries. python-dateutil returns
datetime objects — requiring new serialization, normalization, and materialization
strategies. These improvements make Regrets usable for any datetime-heavy Python
library (arrow, pendulum, maya, cftime, astropy.time, etc.).
