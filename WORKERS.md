# Workers

This project uses a centralized worker context file maintained outside this repository.

**For architecture, conventions, and worker guidelines, see:**

> [`_skills/context-snapshot/Regrets/CONTEXT.md`](https://github.com/Wolfvin/worker-skills/blob/main/context-snapshot/Regrets/CONTEXT.md)

That file is the single source of truth for:

- **Architecture** — script roles, 3-phase workflow, manifest schema
- **Callee contracts** — wrapping patterns, depth limits, fallback behavior
- **Golden rules** — never edit `.regret` files manually, validate RED means fix code
- **Known gaps** — things not yet implemented or intentionally deferred
- **Conventions** — branch naming, commit format, PR requirements

If you are a worker bot or contributor, read `CONTEXT.md` before making any changes to this repo.
