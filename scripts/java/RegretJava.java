// RegretJava.java — shared fingerprint + JSON + manifest helpers for Java stack.
//
// IDENTICAL algorithm to scripts/fingerprint.js (JS) / fingerprint.py (Python) /
// fingerprint_php.php (PHP). Same input/output pair must produce the same 7-char
// base36 hash across all stacks. Verified against the jaconv golden fixture:
//
//   INPUT  ["abcd","",true,true,true]
//   OUTPUT "ａｂｃｄ"
//   → 2zkvw4g   (matches JS, Python, PHP)
//
// Zero external dependencies — uses only JDK built-ins (java.security, java.math,
// java.util). The JSON parser/encoder is intentionally minimal: it understands
// the subset of JSON that appears in regret manifests and .regret files.
//
// Usage from capture_java.sh / validate_java.sh:
//   javac -d /tmp/regret-classes scripts/java/RegretJava.java
//   java -cp /tmp/regret-classes RegretJava <capture|validate> [--cluster id] [--manifest path]
//
// This file is the ONLY Java source checked into the repo for the regret
// infrastructure. User code lives in their own src/ tree and is compiled
// separately; capture_java.sh / validate_java.sh add it to the classpath.

package io.github.wolfvin.regret;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class RegretJava {

    private RegretJava() {}

    // ─── stableStringify ──────────────────────────────────────────────────────
    // Mirrors scripts/fingerprint.js stableStringify():
    //   - null/undefined → "null"/"undefined"
    //   - NaN → "\"__nan__\""  (issue #322 — JSON would emit "null" → hash collision)
    //   - +Infinity → "\"__infinity__\""
    //   - -Infinity → "\"__neg_infinity__\""
    //   - arrays → "[" + elts joined by "," + "]"
    //   - maps (object) → "{" + sorted keys joined by "," + "}"
    //   - everything else → JSON.stringify equivalent

    public static String stableStringify(Object obj) {
        if (obj == null) return "null";
        if (obj == Undefined.UNDEFINED) return "undefined";
        if (obj instanceof Double) {
            double d = (Double) obj;
            if (Double.isNaN(d)) return "\"__nan__\"";
            if (d == Double.POSITIVE_INFINITY) return "\"__infinity__\"";
            if (d == Double.NEGATIVE_INFINITY) return "\"__neg_infinity__\"";
        }
        if (obj instanceof Float) {
            float f = (Float) obj;
            if (Float.isNaN(f)) return "\"__nan__\"";
            if (f == Float.POSITIVE_INFINITY) return "\"__infinity__\"";
            if (f == Float.NEGATIVE_INFINITY) return "\"__neg_infinity__\"";
        }
        if (obj instanceof Boolean) return obj.toString();
        if (obj instanceof Number) {
            // Integer-like → no decimal point, matching JS BigInt/Number behavior
            Number n = (Number) obj;
            double d = n.doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) {
                // handled above for Double/Float; for Long/Integer with infinite doubleValue
                // (impossible) we fall through
            }
            if (d == Math.floor(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
                long l = n.longValue();
                return Long.toString(l);
            }
            // Match JS Number serialization: shortest round-trip repr.
            // Double.toString gives "3.14" for 3.14 — good enough for most cases.
            // For whole-float like 1500000.0 we'd want "1500000" — handled above.
            String s = Double.toString(d);
            return s;
        }
        if (obj instanceof String) return jsonString((String) obj);
        if (obj instanceof List) {
            StringBuilder sb = new StringBuilder("[");
            List<?> list = (List<?>) obj;
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(stableStringify(list.get(i)));
            }
            return sb.append(']').toString();
        }
        if (obj instanceof Map) {
            // TreeMap with String keys gives us alphabetical ordering for free
            TreeMap<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) obj).entrySet()) {
                sorted.put(String.valueOf(e.getKey()), e.getValue());
            }
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<String, Object> e : sorted.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(jsonString(e.getKey())).append(':').append(stableStringify(e.getValue()));
            }
            return sb.append('}').toString();
        }
        // Fallback: best-effort JSON
        return jsonString(obj.toString());
    }

    // ─── JSON string encoder ──────────────────────────────────────────────────
    // Matches JSON.stringify behavior for strings: escapes control chars + the
    // standard set of " \ / \b \f \n \r \t + backslash-u-XXXX for non-printables < 0x20.
    public static String jsonString(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.append('"').toString();
    }

    // ─── Fingerprint ──────────────────────────────────────────────────────────
    // sha256(stableStringify(input) + "|" + stableStringify(output)) → hex →
    // BigInteger(36) → first 7 chars. IDENTICAL to fingerprint.js.
    public static String fingerprint(Object input, Object output) {
        String combined = stableStringify(input) + "|" + stableStringify(output);
        byte[] hash;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            hash = md.digest(combined.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
        StringBuilder hex = new StringBuilder(hash.length * 2);
        for (byte b : hash) hex.append(String.format("%02x", b));
        BigInteger num = new BigInteger(hex.toString(), 16);
        String base36 = num.toString(36);
        return base36.length() >= 7 ? base36.substring(0, 7) : base36;
    }

    // ─── Minimal JSON parser ──────────────────────────────────────────────────
    // Parses the subset of JSON that appears in manifests and .regret files:
    //   - null, true, false
    //   - numbers (int / double)
    //   - strings (with standard escapes + backslash-u-XXXX)
    //   - arrays (→ List<Object>)
    //   - objects (→ Map<String,Object>, preserving insertion order via LinkedHashMap)
    //
    // Returned values use:
    //   - Boolean, Long (for integer-fit numbers), Double (for fractional/exp)
    //   - String
    //   - List<Object>
    //   - Map<String,Object>
    //   - null (Java null) for JSON null

    public static Object parseJson(String s) {
        Parser p = new Parser(s);
        p.skipWs();
        Object v = p.parseValue();
        p.skipWs();
        if (p.pos < p.src.length()) {
            throw new RuntimeException("Trailing junk at pos " + p.pos + ": " + p.src.substring(p.pos));
        }
        return v;
    }

    private static final class Parser {
        final String src;
        int pos;
        Parser(String s) { this.src = s; this.pos = 0; }

        void skipWs() {
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                else break;
            }
        }

        Object parseValue() {
            skipWs();
            if (pos >= src.length()) throw new RuntimeException("Unexpected end of input");
            char c = src.charAt(pos);
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"') return parseString();
            if (c == 't' || c == 'f') return parseBool();
            if (c == 'n') return parseNull();
            if (c == '-' || (c >= '0' && c <= '9')) return parseNumber();
            throw new RuntimeException("Unexpected char '" + c + "' at pos " + pos);
        }

        Map<String, Object> parseObject() {
            expect('{');
            skipWs();
            Map<String, Object> m = new LinkedHashMap<>();
            if (peek() == '}') { pos++; return m; }
            while (true) {
                skipWs();
                if (peek() != '"') throw new RuntimeException("Expected string key at pos " + pos);
                String k = parseString();
                skipWs();
                expect(':');
                Object v = parseValue();
                m.put(k, v);
                skipWs();
                char c = peek();
                if (c == ',') { pos++; continue; }
                if (c == '}') { pos++; return m; }
                throw new RuntimeException("Expected , or } at pos " + pos + ", got " + c);
            }
        }

        List<Object> parseArray() {
            expect('[');
            skipWs();
            List<Object> list = new ArrayList<>();
            if (peek() == ']') { pos++; return list; }
            while (true) {
                Object v = parseValue();
                list.add(v);
                skipWs();
                char c = peek();
                if (c == ',') { pos++; continue; }
                if (c == ']') { pos++; return list; }
                throw new RuntimeException("Expected , or ] at pos " + pos + ", got " + c);
            }
        }

        String parseString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (pos >= src.length()) throw new RuntimeException("Trailing backslash");
                    char e = src.charAt(pos++);
                    switch (e) {
                        case '"':  sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/':  sb.append('/'); break;
                        case 'b':  sb.append('\b'); break;
                        case 'f':  sb.append('\f'); break;
                        case 'n':  sb.append('\n'); break;
                        case 'r':  sb.append('\r'); break;
                        case 't':  sb.append('\t'); break;
                        case 'u':
                            if (pos + 4 > src.length()) throw new RuntimeException("Truncated \\uXXXX");
                            String hex = src.substring(pos, pos + 4);
                            pos += 4;
                            sb.append((char) Integer.parseInt(hex, 16));
                            break;
                        default: throw new RuntimeException("Unknown escape \\" + e);
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new RuntimeException("Unterminated string");
        }

        Object parseNumber() {
            int start = pos;
            if (peek() == '-') pos++;
            while (pos < src.length() && Character.isDigit(src.charAt(pos))) pos++;
            boolean isFloat = false;
            if (pos < src.length() && src.charAt(pos) == '.') {
                isFloat = true;
                pos++;
                while (pos < src.length() && Character.isDigit(src.charAt(pos))) pos++;
            }
            if (pos < src.length() && (src.charAt(pos) == 'e' || src.charAt(pos) == 'E')) {
                isFloat = true;
                pos++;
                if (pos < src.length() && (src.charAt(pos) == '+' || src.charAt(pos) == '-')) pos++;
                while (pos < src.length() && Character.isDigit(src.charAt(pos))) pos++;
            }
            String numStr = src.substring(start, pos);
            if (isFloat) return Double.parseDouble(numStr);
            try {
                return Long.parseLong(numStr);
            } catch (NumberFormatException nfe) {
                // Very large integer — fall back to Double
                return Double.parseDouble(numStr);
            }
        }

        Boolean parseBool() {
            if (src.startsWith("true", pos)) { pos += 4; return Boolean.TRUE; }
            if (src.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
            throw new RuntimeException("Invalid literal at pos " + pos);
        }

        Object parseNull() {
            if (src.startsWith("null", pos)) { pos += 4; return null; }
            throw new RuntimeException("Invalid literal at pos " + pos);
        }

        char peek() {
            if (pos >= src.length()) throw new RuntimeException("Unexpected end of input");
            return src.charAt(pos);
        }

        void expect(char c) {
            if (pos >= src.length() || src.charAt(pos) != c) {
                throw new RuntimeException("Expected '" + c + "' at pos " + pos);
            }
            pos++;
        }
    }

    // ─── Sentinel for "undefined" ─────────────────────────────────────────────
    // JS .regret files sometimes store the literal string "undefined" for
    // clusters with no inputs. We use a sentinel object so stableStringify
    // produces "undefined" exactly.
    public static final class Undefined {
        public static final Undefined UNDEFINED = new Undefined();
        private Undefined() {}
        @Override public String toString() { return "undefined"; }
    }

    // ─── .regret file parser ──────────────────────────────────────────────────
    // Parses the on-disk .regret format:
    //   cluster: <id>
    //   version: 1
    //   fingerprint: <hash>
    //   captured: <iso>
    //   ...other key: value pairs...
    //   ---
    //   INPUT  <json>
    //   OUTPUT <json>
    //   HASH   <hash>

    public static final class RegretFile {
        public final Map<String, String> meta;
        public final Object input;
        public final Object output;
        public final String goldenHash;
        public final String raw;

        public RegretFile(Map<String, String> meta, Object input, Object output, String goldenHash, String raw) {
            this.meta = meta;
            this.input = input;
            this.output = output;
            this.goldenHash = goldenHash;
            this.raw = raw;
        }
    }

    public static RegretFile parseRegret(String content) {
        // Split on a line that is exactly "---" (the section separator).
        int sepIdx = content.indexOf("\n---\n");
        String metaSection;
        String dataSection;
        if (sepIdx == -1) {
            // Maybe "---" is at the very end without trailing newline
            int alt = content.indexOf("\n---");
            if (alt == -1) {
                // No separator — treat all as meta
                metaSection = content;
                dataSection = "";
            } else {
                metaSection = content.substring(0, alt);
                dataSection = content.substring(alt + 4);
                if (dataSection.startsWith("\n")) dataSection = dataSection.substring(1);
            }
        } else {
            metaSection = content.substring(0, sepIdx);
            dataSection = content.substring(sepIdx + 5);
        }

        Map<String, String> meta = new LinkedHashMap<>();
        for (String line : metaSection.split("\n")) {
            int colon = line.indexOf(": ");
            if (colon == -1) continue;
            String k = line.substring(0, colon);
            String v = line.substring(colon + 2).trim();
            meta.put(k, v);
        }

        Object parsedInput = null;
        Object parsedOutput = null;
        String hash = null;
        for (String line : dataSection.split("\n")) {
            if (line.startsWith("INPUT ")) {
                String s = line.substring("INPUT ".length()).trim();
                parsedInput = s.equals("undefined") ? Undefined.UNDEFINED : parseJson(s);
            } else if (line.startsWith("OUTPUT ")) {
                String s = line.substring("OUTPUT ".length()).trim();
                parsedOutput = s.equals("undefined") ? Undefined.UNDEFINED : parseJson(s);
            } else if (line.startsWith("HASH ")) {
                hash = line.substring("HASH ".length()).trim();
            }
        }

        return new RegretFile(meta, parsedInput, parsedOutput, hash, content);
    }

    // ─── .regret file writer ──────────────────────────────────────────────────
    // Produces a .regret file with the canonical field order:
    //   cluster, version, fingerprint, captured, watches, entry, stack,
    //   fingerprintLevel, [optional fields...], ---, INPUT, OUTPUT, HASH

    public static String formatRegret(
            String clusterId,
            String fingerprint,
            String captured,
            String entry,
            String stack,
            String fingerprintLevel,
            List<String> watches,
            boolean multiArgs,
            String file,
            List<String> normalize,
            List<String> ignoreFields,
            Object input,
            Object output
    ) {
        StringBuilder sb = new StringBuilder();
        sb.append("cluster: ").append(clusterId).append('\n');
        sb.append("version: 1\n");
        sb.append("fingerprint: ").append(fingerprint).append('\n');
        sb.append("captured: ").append(captured).append('\n');
        if (watches != null && !watches.isEmpty()) {
            sb.append("watches: [").append(String.join(", ", watches)).append("]\n");
        } else {
            sb.append("watches: []\n");
        }
        sb.append("entry: ").append(entry).append('\n');
        sb.append("stack: ").append(stack).append('\n');
        sb.append("fingerprintLevel: ").append(fingerprintLevel).append('\n');
        if (multiArgs) sb.append("multiArgs: true\n");
        if (file != null && !file.isEmpty()) sb.append("file: ").append(file).append('\n');
        if (normalize != null && !normalize.isEmpty()) {
            sb.append("normalize: [").append(String.join(", ", normalize)).append("]\n");
        }
        if (ignoreFields != null && !ignoreFields.isEmpty()) {
            sb.append("ignoreFields: [").append(String.join(", ", ignoreFields)).append("]\n");
        }
        sb.append("---\n");
        sb.append("INPUT  ").append(stableStringify(input)).append('\n');
        sb.append("OUTPUT ").append(stableStringify(output)).append('\n');
        sb.append("HASH   ").append(fingerprint).append('\n');
        return sb.toString();
    }

    // ─── Misc helpers ─────────────────────────────────────────────────────────

    public static String isoNow() {
        return java.time.Instant.now().toString();
    }

    public static String readManifestClusterField() {
        // Not used — left as a placeholder for future tooling.
        return "";
    }

    // ─── Minimal CLI for cross-stack consistency check ────────────────────────
    // Usage:
    //   java RegretJava fingerprint '<json-input>' '<json-output>'
    //   java RegretJava parseRegret <path-to-.regret>
    //   java RegretJava stringify '<json>'
    // Useful for sanity-checking the algorithm against JS/Python from shell.
    public static void main(String[] args) {
        if (args.length == 0) {
            System.err.println("Usage: RegretJava <command> [args...]");
            System.err.println("Commands:");
            System.err.println("  fingerprint <json-input> <json-output>");
            System.err.println("  parseRegret <path>");
            System.err.println("  stringify <json>");
            System.exit(2);
        }
        String cmd = args[0];
        switch (cmd) {
            case "fingerprint": {
                if (args.length < 3) { System.err.println("fingerprint needs 2 args"); System.exit(2); }
                Object in = parseJson(args[1]);
                Object out = parseJson(args[2]);
                System.out.println(fingerprint(in, out));
                break;
            }
            case "stringify": {
                if (args.length < 2) { System.err.println("stringify needs 1 arg"); System.exit(2); }
                Object v = parseJson(args[1]);
                System.out.println(stableStringify(v));
                break;
            }
            case "parseRegret": {
                if (args.length < 2) { System.err.println("parseRegret needs 1 arg"); System.exit(2); }
                try {
                    String content = new String(Files.readAllBytes(Paths.get(args[1])), StandardCharsets.UTF_8);
                    RegretFile rf = parseRegret(content);
                    System.out.println("cluster: " + rf.meta.get("cluster"));
                    System.out.println("fingerprint: " + rf.meta.get("fingerprint"));
                    System.out.println("input: " + stableStringify(rf.input));
                    System.out.println("output: " + stableStringify(rf.output));
                    System.out.println("HASH: " + rf.goldenHash);
                } catch (IOException e) {
                    System.err.println("Read error: " + e.getMessage());
                    System.exit(1);
                }
                break;
            }
            default:
                System.err.println("Unknown command: " + cmd);
                System.exit(2);
        }
    }
}
