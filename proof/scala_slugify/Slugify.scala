// Slugify.scala — proof-of-concept Scala function for the Regrets Scala stack.
//
// Pure function: lowercase, replace non-alphanumeric runs with single hyphens,
// strip leading/trailing hyphens. Deterministic, referentially transparent,
// no side effects — perfect fingerprint target.
//
// Exposed via the `Slugify` object so Regrets can call it as
//   Slugify.slugify(Array("Hello World!"))
// via reflection from the harness.
//
// IMPORTANT: the entry method signature MUST be
//   def <entry>(args: Array[Object]): Any
// because the harness uses reflection with that exact signature. The function
// receives args as boxed Java objects (String, java.lang.Long, etc.) and
// returns Any (also boxed). The harness re-converts to Json for fingerprinting.

object Slugify:

  /** Pure entry-point for Regrets capture/validate.
    * Accepts an Array[Object] (reflection-friendly). For multiArgs=false
    * the array contains exactly one element (the input). For multiArgs=true
    * the array contains N positional arguments.
    *
    * Returns String (or Any) — the harness re-serializes to Json.
    */
  def slugify(args: Array[Object]): Any =
    require(args.length >= 1, "slugify requires at least 1 argument")
    val input = args(0) match
      case s: String => s
      case other     => other.toString
    slugifyString(input)

  /** The actual implementation — pure function, easy to refactor without
    * changing the contract. Refactors to this method should preserve
    * the fingerprint; changes that alter output will FAIL validation.
    */
  def slugifyString(input: String): String =
    val lower = input.toLowerCase
    // Replace runs of non-alphanumeric chars with a single hyphen
    val sb = new StringBuilder
    var prevWasHyphen = false
    var started = false
    for c <- lower do
      if c.isLetterOrDigit then
        sb.append(c)
        prevWasHyphen = false
        started = true
      else
        if started && !prevWasHyphen then
          sb.append('-')
          prevWasHyphen = true
    // Trim trailing hyphen
    var result = sb.toString
    while (result.endsWith("-")) result = result.substring(0, result.length - 1)
    result

  /** Sample test vector for cross-stack parity verification.
    * The same input/output pair should produce the same fingerprint in
    * JS, Python, PHP, and Scala. Verified by run_demo.sh.
    */
  val parityVector: (String, String) =
    ("Hello, World! This is a TEST.", "hello-world-this-is-a-test")
