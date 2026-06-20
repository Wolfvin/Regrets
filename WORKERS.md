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

- **Stack:** Node.js (ESM + CJS mixed), Python
- **Test runner:** `npm test` (must be green before PR)
- **3-phase workflow:** `regret capture` → refactor freely → `regret validate`
- **The `regrets/` folder is sacred.** Never edit `.regret` files manually.
- **Conventions:** branch from `feat/`, `fix/`, or `docs/`; never push to `main` directly. Commit messages follow `feat(scope):`, `fix(scope):`, `docs(scope):`.

For everything else (architecture, manifest schema, callee contract model,
analyzer capabilities, ghost proxy internals, known gaps), read the
[full context][_skills].
