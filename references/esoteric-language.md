# Esoteric Language Interpreter Testing Pattern

Testing an esoteric programming language interpreter (esolang) with Regrets presents unique challenges: the interpreter typically uses class-based APIs, outputs to STDOUT, uses non-deterministic operations, and may call `sys.exit()` on errors. This reference documents the pure logic extraction pattern proven on the Chef esolang interpreter.

## The Challenge

Esolang interpreters like Chef, Brainfuck, Befunge, and Malbolge share common patterns that make them difficult to fingerprint directly:

1. **Class-based API**: The interpreter is typically a class with stateful methods
2. **STDOUT output**: Results are printed via `print()` rather than returned
3. **sys.exit() on errors**: Syntax/runtime errors terminate the process
4. **Non-deterministic operations**: Some esolangs include random instructions
5. **STDIN input**: User input is read interactively

These patterns violate Regrets' requirements for pure, deterministic functions that return values.

## Solution: Pure Logic Extraction + Adapter Functions

Extract the computational core into a pure logic class, then create adapter functions that Regrets can fingerprint.

### Step 1: Extract Pure Logic Class

```python
# chef_logic.py — Pure logic extraction

class ChefLogic:
    """
    Pure logic version — all side effects removed.
    - print() → self.output list
    - sys.exit() → raise exceptions
    - input() → injected via parameter
    - random.shuffle() → seeded RNG
    """
    def __init__(self, script, fridge_inputs=None, random_seed=42):
        self._script = script
        self.output = []  # Captured output instead of print()
        self._fridge_inputs = fridge_inputs or []
        self._rng = random.Random(random_seed)  # Deterministic randomness
        # ...

    def compute_serve(self):
        """Returns output list instead of printing."""
        result = []
        for j in self.baking_dishes[i][::-1]:
            value = j[0]
            if j[1] == "liquid":
                value = chr(value)
            result.append(value)
        self.output = result
        return result
```

### Step 2: Create Adapter Functions

```python
# Adapter functions — the entry points Regrets fingerprints

def run_hello_world():
    """Run the Hello World Souffle recipe."""
    with open("recipes/helloworld.chef", "r", encoding='utf-8') as f:
        script = f.read()
    return run_chef_script(script)

def run_factorial(n):
    """Run the Factorial and Fish recipe with input n."""
    with open("recipes/factorial_fish.chef", "r", encoding='utf-8') as f:
        script = f.read()
    return run_chef_script(script, fridge_inputs=[n])
```

### Step 3: Manifest Configuration

```json
{
  "clusters": [
    {
      "id": "hello-world-souffle",
      "entry": "run_hello_world",
      "watches": ["run_hello_world"],
      "module": "chef_logic",
      "pythonPath": ".",
      "stack": "python",
      "fingerprintLevel": "entry",
      "description": "Hello World Souffle — brute force character output"
    },
    {
      "id": "factorial-fish",
      "entry": "run_factorial",
      "watches": ["run_factorial"],
      "module": "chef_logic",
      "pythonPath": ".",
      "stack": "python",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "description": "Factorial computation with loop and fridge input",
      "inputs": [[1], [5], [10]]
    }
  ]
}
```

## Key Patterns Documented

### STDOUT → Return Value

Replace `print(value)` with collecting values into a list:

```python
# BEFORE (untestable)
def serve(self):
    for j in self.baking_dishes[i][::-1]:
        value = j[0]
        if j[1] == "liquid": value = chr(value)
        print(value)

# AFTER (fingerprintable)
def compute_serve(self):
    result = []
    for j in self.baking_dishes[i][::-1]:
        value = j[0]
        if j[1] == "liquid": value = chr(value)
        result.append(value)
    self.output = result
    return result
```

### sys.exit() → Exception

Replace fatal exits with catchable exceptions:

```python
# BEFORE (kills the process)
def syntax_error(self, message):
    logger.error(message)
    sys.exit(-1)

# AFTER (testable)
class ChefSyntaxError(ChefError): pass

def syntax_error(self, message):
    raise ChefSyntaxError(f"Syntax error in {self.recipename}: {message}")
```

### input() → Injected Parameter

Replace interactive input with injected values:

```python
# BEFORE (blocks for user input)
self.ingredients[name][0] = int(input(name + ": "))

# AFTER (deterministic)
if self._fridge_index < len(self._fridge_inputs):
    self.ingredients[name][0] = self._fridge_inputs[self._fridge_index]
    self._fridge_index += 1
```

### random.shuffle() → Seeded RNG

Replace global randomness with deterministic seeded RNG:

```python
# BEFORE (non-deterministic)
random.shuffle(self.mixing_bowls[bowl_number])

# AFTER (deterministic with seed)
self._rng = random.Random(random_seed)  # In __init__
self._rng.shuffle(self.mixing_bowls[bowl_number])
```

## Handler Dispatch Refactoring Pattern

When refactoring a monolithic instruction parser into individual handler methods, the return value convention is critical:

```python
# CORRECT return convention for handler dispatch:
# - None = didn't match (try next handler)
# - False = matched and handled normally
# - True = special signal (set_aside / refrigerate — break loop)

def _handle_put(self, instruction):
    match = re.search(r"Put ...", instruction)
    if match is not None:
        self.put(...)
        return False  # Normal handling, NOT True!
    return None

def _handle_set_aside(self, instruction):
    if instruction == "Set aside.":
        return True  # Special signal — break loop
    return None

# The dispatcher:
def parse_instruction(self, instruction):
    for handler in handlers:
        result = handler(instruction)
        if result is not None:  # Catches both True and False
            return result
    self.syntax_error(f"Instruction not recognised: {instruction}")
```

**Critical**: If handlers return `True` for normal handling, `cook_loop` will interpret it as "Set aside was called" and exit the loop prematurely. This was a real bug caught during the cooking-with-python proof.

## Short-Form Instruction Support

Many esolang specs allow short forms of instructions where optional parts are omitted. For example, Chef allows "Add ingredient." (without "to mixing bowl"), defaulting to the 1st mixing bowl. Add both forms:

```python
def _handle_add(self, instruction):
    # Long form: "Add ingredient to [nth] mixing bowl"
    match = re.search(r"Add (.+?) to ... mixing bowl", instruction)
    if match is not None:
        self.addingredient(match.group(1), bowl)
        return False

    # Short form: "Add ingredient." — defaults to 1st bowl
    match = re.search(r"Add ([a-zA-Z0-9 ]+)\.", instruction)
    if match is not None:
        self.addingredient(match.group(1), DEFAULT_BOWL)
        return False

    return None
```

## Real-World Case Study: cooking-with-python

The `stephenfmann/cooking-with-python` Chef esolang interpreter was used as a proof-of-concept:

- **3 clusters** created from recipe execution (Hello World, Hello Sous-chef, Factorial)
- **Pure logic extraction** from 1624-line `chefint.py` class to `chef_logic.py` + adapter functions
- **5-run drift detection**: All PASS+STABLE
- **3-verification refactor proof**: Refactored monolithic `parse_instruction()` into 19 handler methods
  - Regrets GREEN ✅
  - Raw output matches KEBENARAN 1 ✅
  - Fingerprint matches KEBENARAN 2 ✅
- **Bug caught**: Handler return value convention (`True` vs `False`) caused premature loop exit — caught by Regrets validation

This proves that Regrets works reliably on esoteric language interpreters through pure logic extraction + adapter functions.
