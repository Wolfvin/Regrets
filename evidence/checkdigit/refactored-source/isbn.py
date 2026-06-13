# /usr/bin/env python

# This file is part of checkdigit.

# checkdigit is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

# checkdigit is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.

# You should have received a copy of the GNU General Public License
# along with checkdigit.  If not, see <http://www.gnu.org/licenses/>.

"""International Standard Book Number.

ISBN codes are product identifiers used predominantly for books.
Support is provided for both ISBN-10 and ISBN-13.

"""

from checkdigit._data import cleanse, convert, missing_template


def _calculate_isbn10(data: str) -> str:
    """Calculate check digit for ISBN-10 (9-digit input without check digit).

    ISBN-10 uses weighted sum with weights 10, 9, 8, ..., 2 and mod-11.
    A result of 10 is represented as 'X'.

    Args:
        data: 9-digit string (without check digit)

    Returns:
        str: The check digit ('0'-'9' or 'X')
    """
    weighted_sum = sum(
        int(digit) * weight for digit, weight in zip(data, range(10, 1, -1))
    )
    return convert(11 - (weighted_sum % 11))


def _calculate_isbn13(data: str) -> str:
    """Calculate check digit for ISBN-13 (12-digit input without check digit).

    ISBN-13 uses alternating weights of 1 and 3, with mod-10.

    Args:
        data: 12-digit string (without check digit)

    Returns:
        str: The check digit ('0'-'9')
    """
    weighted_sum = sum(
        int(data[i]) * (3 if i % 2 else 1) for i in range(len(data))
    )
    return convert(10 - (weighted_sum % 10), False)


def calculate(data: str) -> str:
    """Calculates ISBN Check Digits.

    Args:
        data: A string of characters representing an ISBN code without the check digit

    Returns:
        str: The check digit that was missing

    Examples:
        >>> from checkdigit import isbn
        >>> # ISBN-10
        >>> isbn.calculate("043942089")
        'X'
        >>> # ISBN-13
        >>> isbn.calculate("978-1-86197-876")
        '9'
    """
    data = cleanse(data)

    if len(data) == 9:
        return _calculate_isbn10(data)
    if len(data) == 12:
        return _calculate_isbn13(data)
    return "Invalid"


def validate(data: str) -> bool:
    """Validates ISBN check digits.

    Args:
        data: A string of characters representing a fall ISBN code

    Returns:
        bool: A boolean representing whether the
            check digit validates the data or non

    Examples:
        >>> from checkdigit import isbn
        >>> # ISBN-10
        >>> isbn.validate("0198526636")
        True
        >>> # ISBN-13
        >>> isbn.validate("978-1-56619-909-4")
        True
    """
    # The calculate method already cleanses the data.
    # If the return result is 'Invalid', it won't match the check digit (hence false).
    return calculate(data[:-1]) == data[-1]


def missing(data: str) -> str:
    """Calculates a missing digit in an ISBN Code represented by a question mark.

    Args:
        data: A string of characters representing a full ISBN code
            with a question mark representing a missing character

    Returns:
        str: The missing value that should've been where the question mark was

    Examples:
        >>> from checkdigit import isbn
        >>> # ISBN-10
        >>> isbn.missing("15688?111X")
        '1'
        >>> # ISBN-13
        >>> isbn.missing("978186197876?")
        '9'
        >>> isbn.missing("023456789128")
        'Invalid'
    """
    return missing_template(data, "isbn")
