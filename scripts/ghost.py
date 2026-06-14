#!/usr/bin/env python3
# ghost.py — Python Ghost Proxy
# Equivalent of ghost.js for the Python stack.
#
# Transparently wraps module-level functions, class instances,
# and constructors to record (fn, args, result) tuples.
#
# Design:
#   JS uses ES6 Proxy to intercept property access transparently.
#   Python has no equivalent, so we use **in-place module mutation**:
#   replace watched functions on the module object itself, so that
#   internal calls between watched functions go through the ghost wrapper.
#   After capture, original functions are restored.
#
# This mirrors the JS behavior where `this.siblingMethod()` on the
# proxied module resolves to the wrapped version.

import copy
import types
import inspect
from functools import wraps


# ─── Deep clone ────────────────────────────────────────────────────────────
# Re-use fingerprint.deep_clone if available; fall back to copy.deepcopy.
# This avoids a hard circular import (fingerprint imports nothing from ghost).

def deep_clone(val):
    """Deep clone a value for recording. Uses fingerprint.deep_clone if available."""
    try:
        from fingerprint import deep_clone as _fp_deep_clone
        return _fp_deep_clone(val)
    except ImportError:
        return copy.deepcopy(val)


# ─── Snapshot instance ────────────────────────────────────────────────────

def snapshot_instance(instance):
    """Snapshot data properties of a class instance for recording.

    Only captures own attributes that are not callables.
    Mirrors JS snapshotInstance() in ghost.js.
    """
    snapshot = {}
    for key in vars(instance):
        try:
            val = getattr(instance, key)
            if not callable(val):
                snapshot[key] = deep_clone(val)
        except Exception:
            pass
    return snapshot


# ─── Call maybe async ────────────────────────────────────────────────────

def call_maybe_async(fn, *args, **kwargs):
    """Call fn with args/kwargs. If fn is a coroutine, run it in an event loop."""
    result = fn(*args, **kwargs)
    if inspect.iscoroutine(result):
        import asyncio
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(asyncio.run, result)
                return future.result()
        else:
            return asyncio.run(result)
    return result


# ─── GhostModule ──────────────────────────────────────────────────────────

class GhostModule:
    """Module-like namespace with ghost-wrapped watched functions.

    Unlike the old approach (copy attrs into a plain namespace), this
    class supports attribute re-resolution: when a watched function
    internally calls another watched function via the module, the call
    goes through the ghost wrapper because we mutate the real module.

    Attributes:
        _module: The original module (for attribute pass-through)
        _originals: Dict of fn_name → original function (for restore)
        _recorder: List to append call records to
        _instance_methods: Map of class_name → method names to watch
    """

    def __init__(self, module, watch_list, recorder, instance_methods=None):
        self._module = module
        self._originals = {}
        self._recorder = recorder
        self._instance_methods = instance_methods or {}
        self._watch_list = watch_list

        # Mutate the module in-place: replace watched functions with ghost wrappers.
        # This ensures that internal calls between watched functions (e.g.,
        # hira2kata calling _translate) go through the ghost wrapper.
        for fn_name in watch_list:
            original = getattr(module, fn_name, None)
            if original is None or not callable(original):
                print(f"  ⚠️  Watch target \"{fn_name}\" is not callable — skipping")
                continue

            self._originals[fn_name] = original
            methods_to_watch = self._instance_methods.get(fn_name, [])

            wrapper = self._make_ghost_wrapper(original, fn_name, methods_to_watch)
            # Replace on the real module so internal calls are intercepted
            setattr(module, fn_name, wrapper)

    def _make_ghost_wrapper(self, original, fn_name, methods_to_watch=None):
        """Create a ghost wrapper for a function or class.

        For classes (constructors), intercepts __init__ and wraps
        instance methods. For plain functions, records args+result.
        """
        methods_to_watch = methods_to_watch or []
        recorder = self._recorder

        # Detect if original is a class (constructor)
        if isinstance(original, type):
            OriginalClass = original

            class GhostClass(OriginalClass):
                """Subclass that records construction and wraps instance methods."""
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    # Record the construction with a snapshot of initial state
                    snapshot = snapshot_instance(self)
                    recorder.append({
                        'fn': fn_name,
                        'args': deep_clone(args),
                        'result': snapshot,
                        'construct': True,
                    })

                    # Wrap instance methods if specified
                    if methods_to_watch:
                        for method_name in methods_to_watch:
                            orig_method = getattr(self, method_name, None)
                            if orig_method is not None and callable(orig_method):
                                wrapped = _wrap_instance_method(
                                    self, method_name, orig_method, recorder, fn_name
                                )
                                setattr(self, method_name, wrapped)

            GhostClass.__name__ = OriginalClass.__name__
            GhostClass.__qualname__ = OriginalClass.__qualname__
            GhostClass.__module__ = OriginalClass.__module__
            return GhostClass

        # Plain function wrapper
        @wraps(original)
        def wrapper(*args, **kwargs):
            try:
                result = call_maybe_async(original, *args, **kwargs)
                recorder.append({
                    'fn': fn_name,
                    'args': deep_clone(args),
                    'result': deep_clone(result),
                })
                return result
            except Exception as err:
                recorder.append({
                    'fn': fn_name,
                    'args': deep_clone(args),
                    'error': str(err),
                })
                raise

        # Ensure wrapper has a meaningful name (for lambda-assigned functions)
        if getattr(wrapper, '__name__', '') == '<lambda>':
            wrapper.__name__ = fn_name
            wrapper.__qualname__ = fn_name

        return wrapper

    def restore(self):
        """Restore original functions on the module after capture."""
        for fn_name, original in self._originals.items():
            setattr(self._module, fn_name, original)

    def __getattr__(self, name):
        """Pass-through: non-watched attributes come from the real module."""
        if name.startswith('_'):
            raise AttributeError(name)
        return getattr(self._module, name)


def _wrap_instance_method(instance, method_name, orig_method, recorder, class_name):
    """Wrap a single instance method with recording.

    Mirrors the JS construct trap's instance method proxy.
    Records args, result, and a post-call instance snapshot.
    """
    @wraps(orig_method)
    def wrapper(*args, **kwargs):
        try:
            result = call_maybe_async(orig_method, *args, **kwargs)
            post_snapshot = snapshot_instance(instance)
            recorder.append({
                'fn': f'{class_name}.{method_name}',
                'args': deep_clone(args),
                'result': deep_clone(result),
                'instanceSnapshot': post_snapshot,
            })
            return result
        except Exception as err:
            recorder.append({
                'fn': f'{class_name}.{method_name}',
                'args': deep_clone(args),
                'error': str(err),
            })
            raise
    return wrapper


# ─── Public API ────────────────────────────────────────────────────────────

def create_ghost(module, watch_list, recorder, instance_methods=None):
    """Create a Ghost Proxy wrapper for watched functions on a module.

    Mirrors the JS createGhost() API from ghost.js:
      createGhost(module, watchList, recorder, instanceMethods)

    This mutates the module in-place (replacing watched functions with
    ghost wrappers) and returns a GhostModule namespace. After capture,
    call ghost.restore() to put the original functions back.

    Args:
        module: The Python module containing the functions to wrap
        watch_list: List of function names to monitor
        recorder: List to push call records into
        instance_methods: Optional dict of class_name → [method_names] to watch
                         on constructed instances (mirrors JS construct trap)

    Returns:
        GhostModule instance with:
          - Watched functions replaced by ghost wrappers (on the real module)
          - Non-watched attributes pass through to the original module
          - .restore() method to put original functions back
    """
    return GhostModule(module, watch_list, recorder, instance_methods)


def create_instance_ghost(instance, watch_list, recorder):
    """Wrap watched methods on a class instance with recording decorators.

    Unlike create_ghost which wraps module-level functions, this wraps
    bound methods on an instance. This is needed for class-based APIs
    where the entry point is a method like mesh.area.

    The instance is modified in-place — methods are swapped with wrappers.
    After capture, call restore_instance(instance, originals) to restore.

    Args:
        instance: The class instance whose methods to wrap
        watch_list: List of method names to monitor
        recorder: List to push call records into

    Returns:
        Tuple of (instance, originals_dict) where originals_dict maps
        method_name → original_bound_method for later restoration.
    """
    originals = {}

    for fn_name in watch_list:
        original = getattr(instance, fn_name, None)
        if original is None:
            print(f"  ⚠️  Watch target \"{fn_name}\" not found on instance — skipping")
            continue
        if not callable(original):
            print(f"  ⚠️  Watch target \"{fn_name}\" is not callable (probably a property) — skipping")
            continue

        originals[fn_name] = original

        def make_ghost(orig, name, rec):
            @wraps(orig)
            def wrapper(*args, **kwargs):
                try:
                    result = orig(*args, **kwargs)
                    rec.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'result': deep_clone(result),
                    })
                    return result
                except Exception as err:
                    rec.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'error': str(err),
                    })
                    raise
            return wrapper

        setattr(instance, fn_name, make_ghost(original, fn_name, recorder))

    return instance, originals


def restore_instance(instance, originals):
    """Restore original methods on an instance after ghost capture."""
    for name, original in originals.items():
        setattr(instance, name, original)
