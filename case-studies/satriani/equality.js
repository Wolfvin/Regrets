/**
 * equality.js — Rockstar equality comparison logic
 * Extracted from environment.js for clarity and testability.
 *
 * Rockstar has unusual equality semantics:
 * - false equals null and zero
 * - null/undefined equals zero for number comparisons
 * - Type coercion follows specific rules (not JS defaults)
 */

function eq(lhs, rhs) {
    if (typeof(lhs) == 'undefined') return(typeof(rhs) == 'undefined');
    if (typeof(rhs) == 'undefined') return(typeof(lhs) == 'undefined');

    if (typeof(lhs) == 'boolean') return(eq_boolean(lhs, rhs));
    if (typeof(rhs) == 'boolean') return(eq_boolean(rhs, lhs));
    if (typeof(lhs) == 'number') return(eq_number(lhs, rhs));
    if (typeof(rhs) == 'number') return(eq_number(rhs, lhs));

   return lhs == rhs;
}

function eq_number(number, other) {
   if (other == null || typeof(other) == 'undefined') return(number === 0);
   return(other == number);
}

function eq_boolean(bool, other) {
   // false equals null in Rockstar
   if (other == null) other = false;
   // false equals zero in Rockstar
   if(typeof(other) == 'number') other = (other !== 0);
   if (typeof(other) == 'string') other = (other !== "");
   return (bool == other);
}

module.exports = { eq, eq_number, eq_boolean };
