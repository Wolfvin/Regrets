# Update Protocol — Safe Fingerprint Update

## When to Update

Only update a `.regret` fingerprint when behavior **intentionally changed** — not to make a failing test pass after a buggy refactor.

Valid reasons:
- Business rule changed (tax rate, fee structure, format)
- API contract version bump (agreed with stakeholders)
- Bug fix that intentionally changes output (the old output was wrong)

Invalid reasons:
- "The refactor changed it" — that's a bug, fix the code
- "I want the test to pass" — that's cheating the contract
- Vague: "behavior updated" — not specific enough

---

## Command

```bash
node scripts/validate.js --update <cluster-id> --reason "<specific reason>"
```

### Rules for `--reason`

- Minimum 4 words (enforced)
- Must describe WHAT changed and WHY
- Will be permanently written to audit.log
- Future AI sessions will read this to understand contract history

Good reasons:
```
"tax rate updated from 11% to 12% per government regulation effective 2024-04"
"invoice code format changed from USR-INV-00042 to INV-USR-042 per design v2"
"normalize now rounds to nearest 500 instead of 1000 per finance team request"
```

Bad reasons (rejected):
```
"behavior changed"           ← too vague
"updated"                    ← no context
"fix"                        ← means nothing
```

---

## What Happens Internally

1. Runs the cluster with golden input
2. Captures new live output + new fingerprint
3. Rewrites `.regret` file:
   - Updates `fingerprint:` field
   - Updates `captured:` timestamp
   - Updates `OUTPUT` line
   - Updates `HASH` line
4. Appends to `regrets/audit.log` (append-only):

```
2024-03-01T09:00:00Z  UPDATE  transform-user-data
  old: 9jadb
  new: x3kp1
  reason: tax rate updated from 11% to 12% per government regulation
  by: AI refactor session
```

---

## Audit Log

`regrets/audit.log` is the permanent history of all intentional contract changes.

- **Never delete** this file
- **Never edit** this file (append-only)
- Commit it to git alongside `.regret` files
- Future AI sessions can read it to understand why contracts evolved

Reading the audit log:
```bash
cat regrets/audit.log
```

Checking history for one cluster:
```bash
grep -A4 "UPDATE  my-cluster" regrets/audit.log
```

---

## After Update

Run validate to confirm the new fingerprint is stable:

```bash
node scripts/validate.js --runs 3
```

All runs must produce identical hash. If drift is detected post-update, the new behavior has non-determinism — add `normalize` rules to manifest before proceeding.
