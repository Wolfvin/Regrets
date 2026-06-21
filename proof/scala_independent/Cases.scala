// proof/scala_independent/Cases.scala
// FRESH fixture (independent of PR #461's proof/scala_slugify/Slugify.scala)
// Different domain (string-casing utils + email validation) + different idioms
// (case class, Option, Either, pattern matching, recursion, List ops).

object Cases {

  // ─── Pattern 1: top-level def in object, simple String → String ─────────
  /** Convert snake_case → camelCase. */
  def camelCase(args: Array[Object]): Any = {
    val s = args(0).asInstanceOf[String]
    if (s.isEmpty) return ""
    val parts = s.split("_")
    val head = parts(0)
    val tail = parts.drop(1).map(p => p.capitalize)
    (head +: tail).mkString
  }

  // ─── Pattern 2: pure predicate, String → Boolean ────────────────────────
  /** Naive email validation: local@domain where both non-empty, domain has dot. */
  def isEmail(args: Array[Object]): Any = {
    val s = args(0).asInstanceOf[String]
    val atIdx = s.indexOf('@')
    if (atIdx <= 0) return false
    val local = s.substring(0, atIdx)
    val domain = s.substring(atIdx + 1)
    if (local.isEmpty || domain.isEmpty) return false
    val dotIdx = domain.indexOf('.')
    dotIdx > 0 && dotIdx < domain.length - 1
  }

  // ─── Pattern 3: number formatting, Int → String ─────────────────────────
  /** Format integer with thousands separator (comma). */
  def formatThousands(args: Array[Object]): Any = {
    val n = args(0) match {
      case x: Int    => x.toLong
      case x: Long   => x
      case x: Number => x.longValue()
      case other     => throw new IllegalArgumentException(s"expected number, got: $other")
    }
    val sign = if (n < 0) "-" else ""
    val digits = Math.abs(n).toString
    val grouped = digits.reverse.grouped(3).map(_.mkString).toList.reverse.mkString(",")
    sign + grouped
  }

  // ─── Pattern 4: recursive Levenshtein distance (Int, Int, Int) ──────────
  /** Classic Levenshtein distance between two strings. */
  def levenshtein(args: Array[Object]): Any = {
    val a = args(0).asInstanceOf[String]
    val b = args(1).asInstanceOf[String]
    lev(a, b)
  }

  private def lev(a: String, b: String): Int = {
    if (a.isEmpty) return b.length
    if (b.isEmpty) return a.length
    val cost = if (a.head == b.head) 0 else 1
    math.min(
      math.min(lev(a.tail, b) + 1, lev(a, b.tail) + 1),
      lev(a.tail, b.tail) + cost
    )
  }
}
