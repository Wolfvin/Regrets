# SPDX-License-Identifier: MIT
"""Utility functions that implement Malbolge arithmetic primitives."""

from __future__ import annotations

from collections.abc import Sequence

MAX_ADDRESS_SPACE = 59049
TERNARY_DIGITS = 10
POWERS_OF_THREE: tuple[int, ...] = tuple(3**i for i in range(TERNARY_DIGITS))
MAX_TERNARY_POWER: int = POWERS_OF_THREE[-1]

# Malbolge's "crazy operation" truth table: index = (first_digit * 3 + second_digit)
# Each entry maps a pair of ternary digits (first, second) to an output digit.
_CRZY: tuple[int, ...] = (1, 1, 2, 0, 0, 2, 0, 2, 1)


def convert_to_base3(value: int, digits: int = TERNARY_DIGITS) -> list[int]:
    """Return the ternary representation (least significant digit first).

    Args:
        value: A non-negative integer to convert.
        digits: Number of ternary digits in the output (padded with leading zeros).

    Returns:
        A list of ternary digits, least significant first, of length ``digits``.

    Raises:
        ValueError: If ``value`` is negative.
    """
    if value < 0:
        raise ValueError("Malbolge numbers must be non-negative.")

    result: list[int] = [0] * digits
    current = value
    idx = 0
    while current and idx < digits:
        current, remainder = divmod(current, 3)
        result[idx] = remainder
        idx += 1

    return result


def convert_to_base10(values: Sequence[int]) -> int:
    """Convert a sequence of ternary digits (LSB first) back to base 10.

    Args:
        values: Ternary digits, least significant digit first.

    Returns:
        The base-10 integer equivalent.
    """
    total = 0
    for index, digit in enumerate(values):
        total += digit * POWERS_OF_THREE[index]
    return total


def ternary_rotate(value: int) -> int:
    """Rotate the ternary representation left by one position.

    The least significant ternary digit becomes the most significant,
    and all other digits shift one position toward lower significance.

    Args:
        value: The integer whose ternary form should be rotated.

    Returns:
        The rotated integer.
    """
    lsb = value % 3
    shifted = value // 3
    return shifted + (lsb * MAX_TERNARY_POWER)


def crazy_operation(first: int, second: int) -> int:
    """Execute the Malbolge 'crazy' operation on two values.

    The transformation is defined digit-wise using Malbolge's custom truth
    table.  For each ternary digit position, the output digit is looked up
    from ``_CRZY`` using the index ``(first_digit * 3 + second_digit)``.

    Args:
        first: The first operand.
        second: The second operand.

    Returns:
        The result of applying the crazy operation digit-by-digit.
    """
    total = 0
    power = 1
    a = first
    b = second
    for _ in range(TERNARY_DIGITS):
        total += _CRZY[(a % 3) * 3 + (b % 3)] * power
        a //= 3
        b //= 3
        power *= 3
    return total
