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

"""Luhn Validation Functions.

The luhn algorithm has a variety of applications, including in credit cards and IMEI numbers.

"""

from checkdigit._data import cleanse, missing_template


def _double_and_sum(digit: int, position: int) -> int:
    """Double even-positioned digits (from right) and sum their digits.

    In the Luhn algorithm, every second digit from the right is doubled.
    If the doubled value is >= 10, its digits are summed (equivalent to subtracting 9).

    Args:
        digit: A single digit (0-9)
        position: Position from the right (0-indexed)

    Returns:
        int: The processed digit value
    """
    if position % 2 == 0:
        # Double the digit and handle two-digit results
        doubled = digit * 2
        return doubled - 9 if doubled > 9 else doubled
    return digit


def calculate(data: str) -> str:
    """Calculates the luhn check digit.

    Args:
        data: A block of data without the check digit

    Returns:
        str: A string representing the missing check digit

    Examples:
        >>> from checkdigit import luhn
        >>> luhn.calculate("53251309870224")
        '3'
        >>> luhn.calculate("950123440000")
        '8'

    """
    data = cleanse(data)
    # Process digits from right to left, doubling every other digit
    digits_reversed = [int(d) for d in data[::-1]]
    total = sum(_double_and_sum(d, pos) for pos, d in enumerate(digits_reversed))
    # The check digit is (10 - (total % 10)) % 10
    # Equivalently: (total * 9) % 10
    return str((total * 9) % 10)


def validate(data: str) -> bool:
    """Validates a luhn check digit.

    Args:
        data: A string of characters representing a full luhn code

    Returns:
        bool: A boolean representing whether the check digit validates the data or not

    Examples:
        >>> from checkdigit import luhn
        >>> luhn.validate("541756116585277")
        True
        >>> luhn.validate("79927398713")
        True
        >>> luhn.validate("49927398717")
        False
        >>> luhn.validate("1234567812345678")
        False

    """
    data = cleanse(data)
    # Determines if calculated Check Digit of the data is the last digit given
    return calculate(data[:-1]) == data[-1]


def missing(data: str) -> str:
    """Calculates a missing digit in a luhn code.

    Args:
        data: A string of characters representing a full luhn code
            with a question mark for a missing character

    Returns:
        str: The missing value that should've been where the question mark was

    Examples:
        >>> from checkdigit import luhn
        >>> luhn.missing("54175611658527?")
        '7'
        >>> luhn.missing("515853022?76176")
        '1'
        >>> luhn.missing("78369216316")
        'Invalid'

    """
    return missing_template(data, "luhn")
