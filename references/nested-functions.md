# Nested Function Watch Limitation

## The Problem

When a function contains a nested helper (closure), the Ghost Proxy cannot wrap it because nested functions are not accessible at module level. This affects both JS (Proxy pattern) and Python (decorator pattern).

## Example

```python
def h2z(text, ignore='', kana=True, ascii=False, digit=False):
    def _conv_dakuten(text):
        """Nested helper — cannot be watched by Ghost"""
        text = text.replace('ｶﾞ', 'ガ')
        # ... more replacements
        return text

    if kana:
        text = _conv_dakuten(text)  # Called internally
    return _convert(text, h2z_map)
```

In this case, adding `"_conv_dakuten"` to `watches` in the manifest will produce:

```
⚠️  Watch target "_conv_dakuten" is not callable — skipping
```

## Impact

- **Minimal for `fingerprintLevel: "entry"`** (default): Only the entry function's output is fingerprinted, so the nested helper is captured implicitly through the entry's output
- **Significant for `fingerprintLevel: "full"` or `"watched"`**: The nested function's calls will not be recorded, leading to incomplete call sequences

## Recommendations

1. **Use `fingerprintLevel: "entry"`** when the target function contains nested helpers — this is the default and most permissive mode
2. **Do not add nested function names to `watches`** — they will be skipped and the warning is misleading
3. **If you need full call sequence tracking**, refactor the nested function to module level first, then add it to `watches`
4. **The capture script should differentiate** between "function not found" (error) and "function is nested/not accessible" (informational) in its warning messages

## Case Study: jaconv

The `h2z()` function in [ikegami-yukino/jaconv](https://github.com/ikegami-yukino/jaconv) contains `_conv_dakuten()` as a nested helper. Initially, the manifest included `_conv_dakuten` in watches, producing warnings. Removing it from watches and using `fingerprintLevel: "entry"` produced clean captures with no warnings, and the fingerprints correctly captured the full behavior through the entry function's output.

All 14 clusters in jaconv are SOLID with this approach.
