# Deep Structural Analysis — `regret analyze`

## Why This Exists

When analyzing gaigutherz/Akkademia (Akkadian cuneiform NLP transliteration), we found that Regrets' existing `regret scan` only detected surface-level function definitions. It missed critical structural risks:

1. **God functions**: `hmm_viterbi()` has 11 parameters, `overall_classifier()` has 21 parameters. These are the #1 refactoring risk but `scan` never flags them.

2. **Duplicate patterns**: `hmm_preprocess()` and `build_extra_decoding_arguments()` build nearly identical data structures (possible_tags, q_uni_counts, q_bi_counts, q_tri_counts) with copy-pasted loops. `scan` doesn't detect cross-module duplication.

3. **Cross-module watch gaps**: When `transliterate_hmm()` calls `hmm_viterbi()` which calls `increment_count()` from `data.py`, the agent needs to know which functions to watch across module boundaries. `scan` only suggests watches within the same file.

## Usage

```bash
# Analyze current directory
python scripts/analyze.py

# Analyze specific directory
python scripts/analyze.py src/

# JSON output for programmatic use
python scripts/analyze.py src/ --json

# Via unified runner
node scripts/regret.js analyze akkadian/
```

## What It Detects

### God Functions (>5 parameters or >50 lines)
Functions with excessive parameters indicate missing abstractions — parameter objects, classes, or context objects should group related parameters. These are the highest-priority refactoring targets because they're hardest to regression-test (too many input combinations).

### Duplicate Patterns
Functions across different modules that share: same parameter count, similar body size (±30%), and overlapping calls (>60%). These indicate copy-paste code that should be extracted into a shared utility.

### Cross-Module Watch Suggestions
When an entry function calls helpers in other modules, those helpers should be added as watches in the manifest. This is especially important for Python projects where imports cross package boundaries.

## Example Output (Akkademia)

```
🔴 GOD FUNCTIONS (21) — Refactoring Priority
  combine_algorithms.overall_classifier
    ⚠️  21 parameters (>6)
    ⚠️  75 lines (>50)
  hmm.hmm_viterbi
    ⚠️  11 parameters (>6)
    ⚠️  135 lines (>50)

🟡 POTENTIAL DUPLICATES (17) — Dedup Before Refactoring
  memm.build_extra_decoding_arguments
  ↔  hmm.hmm_preprocess
    params: 1, lines: 66 vs 75
    shared calls: add, append, increment_count, len, range

⛓  CROSS-MODULE WATCHES (45) — Extend Your Manifest
  Entry: transliterate.transliterate_hmm
    → combine_algorithms: watch sentence_to_HMM_format, list_to_tran
    → data: watch load_object_from_file
    → hmm: watch hmm_viterbi
```

## When to Use

Run `regret analyze` BEFORE `regret scan` when working with a codebase you've never seen before. It tells you where the structural risks are, so you can plan your manifest with confidence.

Run it AGAIN after refactoring to verify that god functions have been decomposed and duplicates have been eliminated.
