# WORKERS.md

> **Looking for developer / contributor context?**
> See **[`_skills/context-snapshot/Regrets/CONTEXT.md`][_skills]** for the
> canonical worker context for this repo: architecture overview, manifest
> schema, callee contract model, ghost-proxy internals, golden rules, known
> gaps, and conventions.
>
> That file is maintained in the `worker-skills` repo and is the single
> source of truth for "how do I work on Regrets as a contributor / AI
> worker?" — `WORKERS.md` itself is intentionally a thin redirect so the
> context never drifts between this repo and the worker-skills repo.

[_skills]: https://github.com/Wolfvin/worker-skills/blob/main/context-snapshot/Regrets/CONTEXT.md

---

## Why a redirect?

The org standard is to ship a `WORKERS.md` at the repo root so new workers
can find the contributor context with `cat WORKERS.md`. Historically,
workers fell back to `AGENT_PROTOCOL.md`, which is the agent *interaction
contract* (how an AI agent invokes the Regrets skill from a host project)
— not the contributor context (how a worker modifies the Regrets codebase
itself). The two are different audiences:

| File | Audience | Question it answers |
|------|----------|---------------------|
| `WORKERS.md` (this file) | Contributors / workers on the Regrets codebase | "How do I work on Regrets itself?" → redirects to `_skills/.../CONTEXT.md` |
| [`AGENT_PROTOCOL.md`](AGENT_PROTOCOL.md) | AI agents invoking the Regrets skill from a host project | "How do I trigger capture / validate / update from outside?" |
| [`SKILL.md`](SKILL.md) | End users of the Regrets skill | "What is this skill and how do I use it?" |
| [`README.md`](README.md) | Anyone curious about the project | "What does this project do?" |

## Quick orientation for new workers

If you don't have the worker-skills repo cloned locally, you can read the
context directly on GitHub:

```bash
# Option 1: clone worker-skills (sparse)
git clone --filter=blob:none --no-checkout https://github.com/Wolfvin/worker-skills.git _skills
cd _skills && git sparse-checkout init --cone
git sparse-checkout set context-snapshot/Regrets
git checkout main
cat context-snapshot/Regrets/CONTEXT.md

# Option 2: read it on GitHub
open https://github.com/Wolfvin/worker-skills/blob/main/context-snapshot/Regrets/CONTEXT.md
```

## TL;DR

- **Stack:** Node.js (ESM + CJS mixed), Python.
- **Test runner:** `npm test` — must be green before every PR. The suite
  spans **82 test files** under `tests/` (plus `.regret`, `.go`, `.json`
  fixtures and helpers in the same directory).
- **3-phase workflow:** `regret capture` → refactor freely → `regret validate`.
- **Repo layout:** ~961 tracked files — 5 root markdowns (`README`,
  `SKILL`, `AGENT_PROTOCOL`, `WORKERS`, `VERIFY_REACT_STACK`), `scripts/`
  (the CLI + per-stack capture/validate glue), `references/` (130+ docs),
  `proof/` + `proofs/` (~50 proof projects), `tests/`, and `mcp/` (the
  MCP server that exposes Regrets as tools).
- **CLI surface:** **25 active commands** plus **8 deprecated** (still work,
  warn on use). See [`AGENT_PROTOCOL.md`](AGENT_PROTOCOL.md) for the full
  list with flags; `scripts/regret.js` is the dispatch source of truth.
- **Stacks:** **27 supported** (`awk`, `bash`, `c`, `cpp`, `crystal`,
  `csharp`, `css`, `dart`, `fsharp`, `go`, `haskell`, `java`, `jq`,
  `julia`, `kotlin`, `lua`, `make`, `nim`, `perl`, `php`, `react`,
  `ruby`, `rust`, `scala`, `sql`, `swift`, `tcl`, `vue`, `zig` — `js`/`ts`
  are handled by the un-suffixed `capture.js`/`validate.js`). See
  [`README.md`](README.md) for the stacks table.
- **Per-stack glue:** every supported stack ships
  `scripts/capture_<stack>.*` and `scripts/validate_<stack>.*` (extensions
  vary: `.sh`, `.py`, `.mjs`, `.lua`, `.pl`, `.php`, `.rb`, …).
- **The `regrets/` folder is sacred.** Never edit `.regret` files manually
  to make tests pass — regenerate them with `regret capture`.
- **Conventions:** branch from `feat/`, `fix/`, or `docs/`; never push to
  `main` directly. Commit messages follow `feat(scope):`, `fix(scope):`,
  `docs(scope):`.

For everything else (architecture, manifest schema, callee contract model,
analyzer capabilities, ghost proxy internals, known gaps), read the
[full context][_skills].

## Common pitfalls for new workers

- **Don't edit `.regret` files by hand.** The `regrets/` folder inside each
  proof project is the captured ground truth. If a test fails because of a
  `.regret` mismatch, the fix is to re-run `regret capture` after a
  deliberate behavior change — not to massage the fixture.
- **Don't add a stack half-way.** Supporting a new stack requires **four**
  coordinated additions: `scripts/capture_<stack>.*`, `scripts/validate_<stack>.*`,
  a dispatch case in `scripts/regret.js`, **and** a `references/<stack>.md`
  doc. Missing any one of them leaves the stack half-broken.
- **Don't conflate `WORKERS.md` and `AGENT_PROTOCOL.md`.** This file is the
  contributor context for hacking on Regrets itself; `AGENT_PROTOCOL.md` is
  the contract for AI agents *invoking* Regrets from a host project. Wrong
  audience → wrong edits.
- **Don't edit the root markdowns in isolation.** `README.md`,
  `AGENT_PROTOCOL.md`, and `SKILL.md` cross-reference each other and the
  `scripts/regret.js` command list. After edits, re-scan for dangling links
  and stale command/stack counts (e.g. the 25-active / 8-deprecated / 27-stack
  figures above).
- **Don't push to `main`.** Always work on `feat/`, `fix/`, or `docs/`
  branches and open a PR.
- **Don't open a PR with red tests.** Run `npm test` locally first — the
  82-file suite must be green. CI will block otherwise.
