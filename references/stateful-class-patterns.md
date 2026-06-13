# Stateful Class Patterns with Regrets

## The Problem

When using Regrets on Python libraries that have stateful classes (like inflect's `engine`),
special care must be taken to avoid state leakage between cluster validations.

### Common Stateful Patterns

1. **Persistent Count** — Methods like `num()` set a persistent count that affects subsequent
   `plural()` calls. Example: `p.num(2); p.plural("cat")` → "cats" (uses persistent count).

2. **Configuration State** — Methods like `classical()` modify a dictionary of flags that
   affect inflection behavior. Example: `p.classical(names=True); p.plural_noun("Smith")`
   → "Smiths" (different from default "the Smiths").

3. **Gender State** — Methods like `gender()` set pronoun gender for singularization.
   Example: `p.gender("feminine"); p.singular_noun("they")` → "she" instead of "it".

4. **Hidden Counters** — Variables like `mill_count` that are mutated as side effects
   during computation. Example: `number_to_words()` increments `mill_count` during
   regex substitution, making it non-reentrant.

5. **User-Defined Lists** — Methods like `defnoun()` append to internal lists that
   persist across calls.

### Why This Matters for Regrets

Regrets creates a **fresh class instance** for each input in each cluster. This is correct
behavior — it prevents state from one input affecting the output of another. However, this
means:

- **Manual verification** must also use fresh instances. Reusing the same `engine()` instance
  across clusters will produce wrong results if `num()`, `classical()`, or `gender()` was
  called by a previous cluster.

- **Chain testing** with `setupSteps` is the correct way to test stateful sequences.
  Each chain step creates its own instance, then applies the setupSteps before calling
  the classMethod.

- **Drift detection** naturally handles statefulness because each run creates fresh instances.

### Warning Signs

When you see these patterns in a Python library, be alert:

1. `self.persistent_*` or `self.__*` attributes that are set outside of `__init__`
2. Methods that return `None` but modify `self` (setters/configurers)
3. `self.counter` or `self._count` variables that increment during computation
4. Any method whose output depends on what methods were called before it

### Best Practices

1. **Always use `classMethod` + `constructor`** for stateful classes in manifest.json
2. **Define `setup` steps** if a method needs state set before it's called
3. **Use chains with `setupSteps`** to test stateful method sequences
4. **Create fresh instances** when manually verifying output
5. **Run drift detection** (5+ runs) to catch hidden non-determinism from state
6. **Don't reuse instances** across different verification calls
