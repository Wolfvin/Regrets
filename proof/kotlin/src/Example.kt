// Example.kt — minimal Kotlin source for the Regrets Kotlin stack proof-of-concept.
//
// Two pure top-level functions:
//   - add(a: Int, b: Int): Int
//   - greet(name: String, excited: Boolean): String
//
// These are the "functions under fingerprint". They are intentionally trivial
// so the focus stays on demonstrating the capture→refactor→validate flow,
// not on the business logic.
//
// After `regret capture`, a refactor that preserves the input→output contract
// (e.g. rewriting `a + b` to `b + a`) should PASS validate. A breaking
// refactor (e.g. returning `a - b` instead of `a + b`) should FAIL validate.

package regrets.example

fun add(a: Int, b: Int): Int = a + b

fun greet(name: String, excited: Boolean): String {
    val base = "Hello, $name"
    return if (excited) "$base!" else base
}

/**
 * Title-case the first letter of each word. Used to demonstrate a function
 * that takes a single String input and returns a String output.
 */
fun titleCaseWords(input: String): String =
    input.split(" ").joinToString(" ") { word ->
        if (word.isEmpty()) word
        else word.substring(0, 1).uppercase() + word.substring(1).lowercase()
    }
