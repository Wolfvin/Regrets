# Dart Stack — Regrets Proof

Example Dart functions used to verify the capture + validate pipeline.

## Functions

| Function | Signature | Description |
|---|---|---|
| `add` | `int add(int a, int b)` | Add two integers (multiArgs) |
| `factorial` | `int factorial(int n)` | Compute factorial |
| `isPrime` | `bool isPrime(int n)` | Check if number is prime |
| `reverseString` | `String reverseString(String s)` | Reverse a string |
| `fibonacci` | `int fibonacci(int n)` | Fibonacci number at position n |

## Running

```bash
# Capture
bash scripts/capture_dart.sh --manifest proof/dart/manifest.json

# Validate (should PASS)
bash scripts/validate_dart.sh --manifest proof/dart/manifest.json

# Validate with breaking change (should FAIL for modified function)
# Edit math_utils.dart, then:
bash scripts/validate_dart.sh --manifest proof/dart/manifest.json
```

## Fingerprint Compatibility

The Dart fingerprint implementation produces **identical** results to the JS and Python
implementations. Verified cross-platform:

```
fingerprint(2, 5)            = 2xpj8i4   (Dart == JS == Python)
fingerprint("hello", "olleh") = 5nssd6s   (Dart == JS == Python)
```
