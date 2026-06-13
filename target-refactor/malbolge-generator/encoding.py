# SPDX-License-Identifier: MIT
"""Translation helpers between ASCII and Malbolge instruction sets."""

from __future__ import annotations

import functools
from collections.abc import Iterable

NORMAL_TRANSLATE = (
    "+b(29e*j1VMEKLyC})8&m#~W>qxdRp0wkrUo[D7,XTcA\"lI.v%{gJh4G\\-=O@5`_3i<?Z'"
    ";FNQuY]szf$!BS/|t:Pn6^Ha"
)
ENCRYPTION_TRANSLATE = (
    "5z]&gqtyfr$(we4{WP)H-Zn,[%\\3dL+Q;>U!pJS72FhOA1CB6v^=I_0/8|jsb9m<.TVa"
    "`uY*MK'X~xDl}REokN:#?G\"i@"
)
VALID_INSTRUCTIONS = "i</*jpov"
MAX_PROGRAM_LENGTH = 59049

# Pre-compute the set for O(1) membership checks
_VALID_INSTRUCTION_SET = frozenset(VALID_INSTRUCTIONS)


class InvalidProgramError(ValueError):
    """Raised when a program cannot be normalized."""


def _validate_length(length: int, context: str = "Program") -> None:
    """Raise InvalidProgramError if the length exceeds Malbolge's maximum."""
    if length > MAX_PROGRAM_LENGTH:
        raise InvalidProgramError(
            f"{context} exceeds Malbolge maximum length ({MAX_PROGRAM_LENGTH})."
        )


def normalize(instruction_list: Iterable[str]) -> list[str]:
    """Convert ASCII characters to Malbolge opcodes.

    Only opcodes in ``VALID_INSTRUCTIONS`` are preserved; others are
    discarded to remain compatible with legacy behaviour.

    Args:
        instruction_list: An iterable of ASCII characters to translate.

    Returns:
        A list of valid Malbolge opcodes.

    Raises:
        InvalidProgramError: If the input exceeds ``MAX_PROGRAM_LENGTH``.
    """
    chars = list(instruction_list)
    _validate_length(len(chars), "Program")

    return [
        NORMAL_TRANSLATE[(ord(ch) + idx - 33) % 94]
        for idx, ch in enumerate(chars)
        if NORMAL_TRANSLATE[(ord(ch) + idx - 33) % 94] in _VALID_INSTRUCTION_SET
    ]


@functools.cache
def _opcode_offset(opcode: str, index: int) -> int:
    """Compute the ASCII character that maps to *opcode* at *index*."""
    return (NORMAL_TRANSLATE.index(opcode) - index) % 94


def reverse_normalize(
    instruction_list: Iterable[str],
    *,
    start_index: int = 0,
) -> list[str]:
    """Encode Malbolge opcodes back into printable ASCII characters.

    Args:
        instruction_list: An iterable of valid Malbolge opcodes.
        start_index: The tape offset at which encoding begins.

    Returns:
        A list of printable ASCII characters.

    Raises:
        InvalidProgramError: If the output would exceed ``MAX_PROGRAM_LENGTH``
            or an invalid opcode is encountered.
    """
    opcodes = list(instruction_list)
    total_length = start_index + len(opcodes)
    _validate_length(total_length, "Program")

    return [
        chr(_opcode_offset(ch, start_index + offset) + 33)
        for offset, ch in enumerate(opcodes)
    ]
