// regret_fingerprint.scala — Scala port of scripts/fingerprint.js
//
// Cross-stack fingerprint parity contract:
//   fingerprint(input, output)
//   = sha256(stableStringify(input) + "|" + stableStringify(output))
//   → hex → BigInt → base36 → first 7 chars
//
// MUST produce byte-identical output to scripts/fingerprint.js (JS),
// scripts/fingerprint.py (Python), scripts/fingerprint_php.php (PHP),
// scripts/fingerprint_bash.sh (Bash).
//
// The module is self-contained: no external deps. We hand-roll stable JSON
// serialization so we can match JS byte-for-byte (e.g. NaN sentinel, integer
// vs float, key sorting).

package regrets

import java.math.BigInteger
import java.security.MessageDigest

/** A tiny JSON value tree — sufficient for our serialize needs. */
enum Json:
  case Null
  case Bool(b: Boolean)
  case IntNum(n: Long)
  case DoubleNum(d: Double)
  case Str(s: String)
  case Arr(items: Array[Json])
  case Obj(entries: Array[(String, Json)])

object Json:
  /** Parse a JSON string into our tree. */
  def parse(s: String): Json = JsonParser.parse(s)

  /** Build a JSON tree from a Scala Any (best-effort). */
  def from(a: Any): Json = a match
    case null                   => Null
    case j: Json                => j
    case b: Boolean             => Bool(b)
    case b: java.lang.Boolean   => Bool(b.booleanValue())
    case b: Byte                => IntNum(b.toLong)
    case s: Short               => IntNum(s.toLong)
    case i: Int                 => IntNum(i.toLong)
    case l: Long                => IntNum(l)
    case f: Float               => DoubleNum(f.toDouble)
    case d: Double              => DoubleNum(d)
    case s: String              => Str(s)
    case s: CharSequence        => Str(s.toString)
    case arr: Array[?]          => Arr(arr.map(from).asInstanceOf[Array[Json]])
    case seq: Seq[?]            => Arr(seq.map(from).toArray)
    case m: Map[?, ?]           =>
      val entries = m.toArray.map { case (k, v) => (k.toString, from(v)) }
      Obj(entries)
    case p: Product             =>
      val names = p.productElementNames.toArray
      val vals  = p.productIterator.toArray
      Obj(names.zip(vals).map { case (n, v) => (n, from(v)) })
    case other                  => Str(other.toString)
/** A minimal, strict JSON parser producing `Json` values. */
object JsonParser:
  import Json._

  def parse(s: String): Json =
    val p = new Parser(s)
    val v = p.skipWs().parseValue()
    p.skipWs()
    if p.pos < p.input.length then
      throw new RuntimeException(s"Trailing garbage at position ${p.pos}")
    v

  private class Parser(val input: String):
    var pos: Int = 0

    def skipWs(): this.type =
      while pos < input.length && (input.charAt(pos) match
          case ' ' | '\t' | '\n' | '\r' => true
          case _ => false
      ) do pos += 1
      this

    def parseValue(): Json =
      skipWs()
      if pos >= input.length then throw new RuntimeException("Unexpected EOF")
      input.charAt(pos) match
        case '"'  => Str(parseString())
        case '{'  => parseObject()
        case '['  => parseArray()
        case 't'  => parseLiteral("true", Bool(true))
        case 'f'  => parseLiteral("false", Bool(false))
        case 'n'  => parseLiteral("null", Null)
        case '-' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' =>
          parseNumber()
        case c => throw new RuntimeException(s"Unexpected char '$c' at $pos")

    def parseLiteral(lit: String, v: Json): Json =
      if input.regionMatches(pos, lit, 0, lit.length) then
        pos += lit.length
        v
      else throw new RuntimeException(s"Expected '$lit' at $pos")

    def parseString(): String =
      // Assumes current char is '"'
      pos += 1
      val sb = new StringBuilder
      var escape = false
      var done = false
      while pos < input.length && !done do
        val c = input.charAt(pos); pos += 1
        if escape then
          escape = false
          c match
            case '"'  => sb.append('"')
            case '\\' => sb.append('\\')
            case '/'  => sb.append('/')
            case 'b'  => sb.append('\b')
            case 'f'  => sb.append('\f')
            case 'n'  => sb.append('\n')
            case 'r'  => sb.append('\r')
            case 't'  => sb.append('\t')
            case 'u'  =>
              if pos + 4 > input.length then throw new RuntimeException("Bad \\u escape")
              val hex = input.substring(pos, pos + 4)
              pos += 4
              sb.append(Integer.parseInt(hex, 16).toChar)
            case _ => throw new RuntimeException(s"Bad escape '\\$c'")
        else c match
          case '"'  => done = true
          case '\\' => escape = true
          case _    => sb.append(c)
      if !done then throw new RuntimeException("Unterminated string")
      sb.toString

    def parseNumber(): Json =
      val start = pos
      if input.charAt(pos) == '-' then pos += 1
      while pos < input.length && input.charAt(pos).isDigit do pos += 1
      var isDouble = false
      if pos < input.length && input.charAt(pos) == '.' then
        isDouble = true
        pos += 1
        while pos < input.length && input.charAt(pos).isDigit do pos += 1
      if pos < input.length && (input.charAt(pos) == 'e' || input.charAt(pos) == 'E') then
        isDouble = true
        pos += 1
        if pos < input.length && (input.charAt(pos) == '+' || input.charAt(pos) == '-') then pos += 1
        while pos < input.length && input.charAt(pos).isDigit do pos += 1
      val text = input.substring(start, pos)
      if isDouble then DoubleNum(text.toDouble)
      else
        try IntNum(text.toLong)
        catch case _: Exception => DoubleNum(text.toDouble)

    def parseArray(): Json =
      pos += 1 // skip [
      skipWs()
      val items = scala.collection.mutable.ArrayBuffer[Json]()
      if pos < input.length && input.charAt(pos) == ']' then
        pos += 1
        return Arr(items.toArray)
      var done = false
      while !done do
        items += parseValue()
        skipWs()
        if pos >= input.length then throw new RuntimeException("Unterminated array")
        input.charAt(pos) match
          case ',' => pos += 1; skipWs()
          case ']' => pos += 1; done = true
          case _   => throw new RuntimeException(s"Expected ',' or ']' at $pos")
      Arr(items.toArray)

    def parseObject(): Json =
      pos += 1 // skip {
      skipWs()
      val entries = scala.collection.mutable.ArrayBuffer[(String, Json)]()
      if pos < input.length && input.charAt(pos) == '}' then
        pos += 1
        return Obj(entries.toArray)
      var done = false
      while !done do
        skipWs()
        if pos >= input.length || input.charAt(pos) != '"' then
          throw new RuntimeException(s"Expected string key at $pos")
        val key = parseString()
        skipWs()
        if pos >= input.length || input.charAt(pos) != ':' then
          throw new RuntimeException(s"Expected ':' at $pos")
        pos += 1
        val v = parseValue()
        entries += (key -> v)
        skipWs()
        if pos >= input.length then throw new RuntimeException("Unterminated object")
        input.charAt(pos) match
          case ',' => pos += 1
          case '}' => pos += 1; done = true
          case _   => throw new RuntimeException(s"Expected ',' or '}' at $pos")
      Obj(entries.toArray)

// ─── Stable serialization (parity with JS stableStringify) ────────────────

object StableStringify:
  /** Serialize a Json value into a stable, byte-deterministic JSON string. */
  def apply(v: Json): String =
    val sb = new StringBuilder
    render(v, sb)
    sb.toString

  private def render(v: Json, sb: StringBuilder): Unit = v match
    case Json.Null          => sb.append("null")
    case Json.Bool(true)    => sb.append("true")
    case Json.Bool(false)   => sb.append("false")
    case Json.IntNum(n)     => sb.append(n.toString)
    case Json.DoubleNum(d)  =>
      if java.lang.Double.isNaN(d)        then sb.append("\"__nan__\"")
      else if d == Double.PositiveInfinity then sb.append("\"__infinity__\"")
      else if d == Double.NegativeInfinity then sb.append("\"__neg_infinity__\"")
      else sb.append(formatDouble(d))
    case Json.Str(s)        => renderString(s, sb)
    case Json.Arr(items)    =>
      sb.append('[')
      var first = true
      for it <- items do
        if !first then sb.append(',')
        first = false
        render(it, sb)
      sb.append(']')
    case Json.Obj(entries)  =>
      val sorted = entries.sortBy(_._1)
      sb.append('{')
      var first = true
      for (k, v) <- sorted do
        if !first then sb.append(',')
        first = false
        renderString(k, sb)
        sb.append(':')
        render(v, sb)
      sb.append('}')

  private def renderString(s: String, sb: StringBuilder): Unit =
    sb.append('"')
    var i = 0
    while i < s.length do
      val c = s.charAt(i)
      c match
        case '"'  => sb.append("\\\"")
        case '\\' => sb.append("\\\\")
        case '\b' => sb.append("\\b")
        case '\f' => sb.append("\\f")
        case '\n' => sb.append("\\n")
        case '\r' => sb.append("\\r")
        case '\t' => sb.append("\\t")
        case _ =>
          if c < 0x20 then
            sb.append("\\u")
            sb.append(f"${c.toInt}%04x")
          else
            sb.append(c)
      i += 1
    sb.append('"')

  /** Format a Double to match JSON.stringify output. */
  private def formatDouble(d: Double): String =
    if (d == math.floor(d)) && !java.lang.Double.isInfinite(d) && math.abs(d) < 1e21 then
      new java.math.BigDecimal(d.toLong).toPlainString
    else
      val s = d.toString
      // Scala: 1.0E7 / 1.0E-7  →  JS: 1e+7 / 1e-7
      s.replace("E", "e+").replace("e+-", "e-")

// ─── Fingerprint (parity with JS fingerprint.js) ─────────────────────────

object Fingerprint:
  /** Compute the 7-char base36 fingerprint for an (input, output) pair. */
  def apply(input: Json, output: Json): String =
    val combined = StableStringify(input) + "|" + StableStringify(output)
    val md = MessageDigest.getInstance("SHA-256")
    val bytes = md.digest(combined.getBytes("UTF-8"))
    val hex = bytes.map(b => f"${b & 0xff}%02x").mkString
    val big = new BigInteger(hex, 16)
    val b36 = big.toString(36)
    if b36.length >= 7 then b36.substring(0, 7) else b36
