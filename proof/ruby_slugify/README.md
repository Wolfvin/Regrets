# proof/ruby_slugify — Ruby stack proof

A minimal but real Ruby codebase covered by Regrets. Two clusters, both
pure functions, captured and validated end-to-end with the Ruby stack
adapter.

This is the first proof that the Ruby stack adapter (`scripts/capture_ruby.rb`
+ `scripts/validate_ruby.rb`) actually works on real code.

## What's here

```
proof/ruby_slugify/
├── README.md              ← this file
├── PARITY.md              ← cross-stack hash parity table (Ruby vs JS/PHP/Python)
├── manifest.json          ← Regrets manifest: 2 clusters (slugify, slugify-batch)
├── lib/
│   └── slugify.rb         ← the real Ruby code under contract
├── regrets/
│   ├── slugify.regret     ← golden contract for slugify()
│   └── slugify-batch.regret ← golden contract for slugify_batch()
└── run_demo.sh            ← end-to-end demo: baseline → valid refactor → breaking refactor
```

## The functions

### `slugify(text) → String`

URL-safe slug generator. Downcases, replaces every run of non-`[a-z0-9]`
characters with a single hyphen, strips leading/trailing hyphens.

| Input             | Output            |
|-------------------|-------------------|
| `"Hello, World!"` | `"hello-world"`   |
| `"Café résumé"`   | `"caf-r-sum"`     |
| `"---trailing---"`| `"trailing"`      |
| `""`              | `""`              |
| `"!!!"`           | `""`              |

### `slugify_batch(texts) → Array<String>`

Applies `slugify` to every element of an array, preserving order and length.

## Running it

### Prerequisites

Ruby 3.x on PATH. If your system doesn't have Ruby:

```bash
# Debian/Ubuntu (with sudo):
sudo apt install ruby

# Without sudo — extract prebuilt Ruby into a local prefix:
apt-get download ruby3.3 libruby3.3
mkdir -p ~/ruby-root && cd ~/ruby-root
for deb in /tmp/ruby3.3_*.deb /tmp/libruby3.3_*.deb; do dpkg-deb -x "$deb" .; done
export RUBY_ROOT=~/ruby-root
export LD_LIBRARY_PATH=$RUBY_ROOT/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH
export PATH=$RUBY_ROOT/usr/bin:$PATH
export RUBYLIB=$RUBY_ROOT/usr/lib/ruby/3.3.0:$RUBY_ROOT/usr/lib/x86_64-linux-gnu/ruby/3.3.0
ruby --version  # → ruby 3.3.x
```

### Capture + validate

```bash
cd proof/ruby_slugify/

# Capture — writes regrets/slugify.regret + regrets/slugify-batch.regret
ruby ../../scripts/capture_ruby.rb --manifest ./manifest.json

# Validate — both clusters should PASS
ruby ../../scripts/validate_ruby.rb --manifest ./manifest.json
```

Expected:

```
🔍 Validating 2 cluster(s)...

  ✅ slugify-batch                       2tph9ny                PASS
  ✅ slugify                             615ytfn                PASS

────────────────────────────────────────────────────────────
✅ All 2 tests passed. Refactor is safe.
```

### End-to-end demo

```bash
bash run_demo.sh
```

This script runs three phases and asserts each produces the expected
PASS/FAIL outcome:

| Phase | What it does | Expected |
|-------|--------------|----------|
| 0 | Baseline capture + validate | ✅ PASS |
| 1 | Apply valid refactor (rename var, split regex, drop constant) | ✅ PASS — output unchanged |
| 2 | Apply breaking refactor (hyphen → underscore in output) | ❌ FAIL — Regrets catches the change |

If all three phases pass, the demo exits 0 and prints a summary.

## Why this proof matters

This is the FIRST proof that the Ruby stack adapter works on real Ruby
code. Before this PR, Ruby was completely unsupported by Regrets. After
this PR:

- `regret capture` works for Ruby clusters (writes valid `.regret` files)
- `regret validate` works for Ruby clusters (PASS for unchanged behavior,
  FAIL for changed behavior)
- The fingerprint hash is byte-for-byte identical to what JS/PHP/Python
  would produce for the same input/output pair (see `PARITY.md`)
- The dispatcher in `scripts/regret.js` + `scripts/regret.py` +
  `scripts/setup.js` routes `stack: "ruby"` to the new scripts

The demo proves the full Phase 1 → Phase 2 → Phase 3 workflow:
AUDIT (capture) → REFACTOR (modify `slugify.rb`) → VALIDATE (compare
fingerprints).
