// regret_proof_rust — proof-of-concept binary for the Regrets Rust validator.
//
// CONTRACT (must match what scripts/validate_rust_runner.mjs expects):
//   - Reads a single JSON object from stdin: { "cluster": "<id>", "input": <value> }
//   - Writes a single JSON object to stdout: { "output": <value> }
//   - On error: writes { "error": "<message>" } and exits non-zero.
//
// The binary dispatches to the right function based on the `cluster` field.
// In a real Rust project, the dispatch table is the only place that knows
// which Regrets cluster id maps to which function — the functions themselves
// stay pure (no I/O) so they can be fingerprinted.

use std::io::{self, Read};
use std::process;

// ─── Pure functions under regression contract ──────────────────────────────
// These are the functions we fingerprint. They MUST stay pure (no I/O, no
// global state, no SystemTime) so the same input always produces the same
// output. Side effects (DB, HTTP, file writes) belong in a separate shell
// module — see references/rust.md#pure-function-extraction-in-rust.

/// Convert a tax period string from "YYYY_MM" to "MMYYYY".
/// Example: "2025_05" → "052025"
pub fn format_period(period: &str) -> String {
    // Split on '_' — expects exactly two parts: year and month.
    let parts: Vec<&str> = period.split('_').collect();
    if parts.len() != 2 {
        return String::new();
    }
    let year = parts[0];
    let month = parts[1];
    format!("{}{}", month, year)
}

/// Sanitize a string for use as a filename: replace unsafe characters with '_'
/// and prepend a prefix. Multi-argument version (takes prefix + base).
/// Example: ("FPK-", "2025-05") → "FPK-2025_05"
pub fn sanitize_filename(prefix: &str, base: &str) -> String {
    let sanitized: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{}{}", prefix, sanitized)
}

// ─── JSON parsing ──────────────────────────────────────────────────────────
// We hand-roll a minimal JSON parser here to keep the proof project zero-dep.
// In a real project you'd pull in `serde_json` — see references/rust.md.

fn parse_json_value(s: &str) -> Result<serde_lite::Value, String> {
    let mut parser = serde_lite::Parser::new(s);
    parser.skip_ws();
    parser.parse_value()
}

fn serialize_json_value(v: &serde_lite::Value) -> String {
    serde_lite::serialize(v)
}

// ─── Dispatch table ────────────────────────────────────────────────────────
// Map cluster id → function. Each cluster in regrets/manifest.json must have
// an entry here. The function takes the input Value and returns the output
// Value (or an error string).

fn dispatch(cluster: &str, input: &serde_lite::Value) -> Result<serde_lite::Value, String> {
    match cluster {
        "rust-format-period" => {
            let s = match input {
                serde_lite::Value::String(s) => s.as_str(),
                _ => return Err("expected string input".to_string()),
            };
            let out = format_period(s);
            Ok(serde_lite::Value::String(out))
        }
        "rust-sanitize-filename" => {
            // multiArgs: input is a JSON array [prefix, base]
            let arr = match input {
                serde_lite::Value::Array(a) => a,
                _ => return Err("expected array input".to_string()),
            };
            if arr.len() != 2 {
                return Err(format!("expected 2 args, got {}", arr.len()));
            }
            let prefix = match &arr[0] {
                serde_lite::Value::String(s) => s.as_str(),
                _ => return Err("prefix must be string".to_string()),
            };
            let base = match &arr[1] {
                serde_lite::Value::String(s) => s.as_str(),
                _ => return Err("base must be string".to_string()),
            };
            let out = sanitize_filename(prefix, base);
            Ok(serde_lite::Value::String(out))
        }
        _ => Err(format!("unknown cluster: {}", cluster)),
    }
}

// ─── main: stdin → stdout JSON bridge ──────────────────────────────────────

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        eprintln!("{{\"error\":\"failed to read stdin: {}\"}}", e);
        process::exit(1);
    }

    let parsed = match parse_json_value(&input) {
        Ok(v) => v,
        Err(e) => {
            println!("{{\"error\":\"invalid JSON input: {}\"}}", e);
            process::exit(1);
        }
    };

    let cluster = match parsed.get("cluster").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            println!("{{\"error\":\"missing 'cluster' field\"}}");
            process::exit(1);
        }
    };

    let input_val = match parsed.get("input") {
        Some(v) => v.clone(),
        None => {
            println!("{{\"error\":\"missing 'input' field\"}}");
            process::exit(1);
        }
    };

    match dispatch(&cluster, &input_val) {
        Ok(out) => {
            let resp = format!("{{\"output\":{}}}", serialize_json_value(&out));
            println!("{}", resp);
        }
        Err(e) => {
            println!("{{\"error\":\"{}\"}}", e.replace('"', "\\\""));
            process::exit(1);
        }
    }
}

// ─── Minimal JSON module (serde_lite) — zero-dep JSON for the proof ────────
// In a real project, replace this with `serde_json`. It's only here so the
// proof project can compile without external crates.

mod serde_lite {
    #[derive(Debug, Clone, PartialEq)]
    pub enum Value {
        Null,
        Bool(bool),
        Number(f64),
        String(String),
        Array(Vec<Value>),
        Object(Vec<(String, Value)>),
    }

    impl Value {
        pub fn get(&self, key: &str) -> Option<&Value> {
            match self {
                Value::Object(entries) => entries
                    .iter()
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| v),
                _ => None,
            }
        }
        pub fn as_str(&self) -> Option<&str> {
            match self {
                Value::String(s) => Some(s.as_str()),
                _ => None,
            }
        }
    }

    pub fn serialize(v: &Value) -> String {
        match v {
            Value::Null => "null".to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => {
                if n.fract() == 0.0 && n.is_finite() {
                    format!("{}", *n as i64)
                } else {
                    format!("{}", n)
                }
            }
            Value::String(s) => format!("\"{}\"", escape_str(s)),
            Value::Array(arr) => {
                let items: Vec<String> = arr.iter().map(serialize).collect();
                format!("[{}]", items.join(","))
            }
            Value::Object(entries) => {
                let items: Vec<String> = entries
                    .iter()
                    .map(|(k, v)| format!("\"{}\":{}", escape_str(k), serialize(v)))
                    .collect();
                format!("{{{}}}", items.join(","))
            }
        }
    }

    fn escape_str(s: &str) -> String {
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t")
    }

    pub struct Parser<'a> {
        chars: Vec<char>,
        pos: usize,
        _phantom: std::marker::PhantomData<&'a str>,
    }

    impl<'a> Parser<'a> {
        pub fn new(s: &'a str) -> Self {
            Self {
                chars: s.chars().collect(),
                pos: 0,
                _phantom: std::marker::PhantomData,
            }
        }

        pub fn skip_ws(&mut self) {
            while self.pos < self.chars.len() && self.chars[self.pos].is_whitespace() {
                self.pos += 1;
            }
        }

        pub fn parse_value(&mut self) -> Result<Value, String> {
            self.skip_ws();
            if self.pos >= self.chars.len() {
                return Err("unexpected EOF".to_string());
            }
            match self.chars[self.pos] {
                '"' => self.parse_string().map(Value::String),
                '{' => self.parse_object(),
                '[' => self.parse_array(),
                't' | 'f' => self.parse_bool(),
                'n' => self.parse_null(),
                '-' | '0'..='9' => self.parse_number(),
                c => Err(format!("unexpected char '{}'", c)),
            }
        }

        fn parse_string(&mut self) -> Result<String, String> {
            // Skip opening quote
            self.pos += 1;
            let mut result = String::new();
            while self.pos < self.chars.len() {
                let c = self.chars[self.pos];
                if c == '"' {
                    self.pos += 1;
                    return Ok(result);
                }
                if c == '\\' {
                    self.pos += 1;
                    if self.pos >= self.chars.len() {
                        return Err("unexpected EOF in escape".to_string());
                    }
                    let esc = self.chars[self.pos];
                    let unescaped = match esc {
                        '"' => '"',
                        '\\' => '\\',
                        '/' => '/',
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        _ => return Err(format!("unsupported escape '\\{}'", esc)),
                    };
                    result.push(unescaped);
                    self.pos += 1;
                } else {
                    result.push(c);
                    self.pos += 1;
                }
            }
            Err("unterminated string".to_string())
        }

        fn parse_object(&mut self) -> Result<Value, String> {
            // Skip '{'
            self.pos += 1;
            let mut entries = Vec::new();
            self.skip_ws();
            if self.pos < self.chars.len() && self.chars[self.pos] == '}' {
                self.pos += 1;
                return Ok(Value::Object(entries));
            }
            loop {
                self.skip_ws();
                if self.pos >= self.chars.len() || self.chars[self.pos] != '"' {
                    return Err("expected string key".to_string());
                }
                let key = self.parse_string()?;
                self.skip_ws();
                if self.pos >= self.chars.len() || self.chars[self.pos] != ':' {
                    return Err("expected ':' after key".to_string());
                }
                self.pos += 1;
                let value = self.parse_value()?;
                entries.push((key, value));
                self.skip_ws();
                if self.pos >= self.chars.len() {
                    return Err("unexpected EOF in object".to_string());
                }
                match self.chars[self.pos] {
                    ',' => {
                        self.pos += 1;
                        continue;
                    }
                    '}' => {
                        self.pos += 1;
                        return Ok(Value::Object(entries));
                    }
                    c => return Err(format!("expected ',' or '}}', got '{}'", c)),
                }
            }
        }

        fn parse_array(&mut self) -> Result<Value, String> {
            self.pos += 1;
            let mut items = Vec::new();
            self.skip_ws();
            if self.pos < self.chars.len() && self.chars[self.pos] == ']' {
                self.pos += 1;
                return Ok(Value::Array(items));
            }
            loop {
                let value = self.parse_value()?;
                items.push(value);
                self.skip_ws();
                if self.pos >= self.chars.len() {
                    return Err("unexpected EOF in array".to_string());
                }
                match self.chars[self.pos] {
                    ',' => {
                        self.pos += 1;
                        continue;
                    }
                    ']' => {
                        self.pos += 1;
                        return Ok(Value::Array(items));
                    }
                    c => return Err(format!("expected ',' or ']', got '{}'", c)),
                }
            }
        }

        fn parse_bool(&mut self) -> Result<Value, String> {
            if self.chars[self.pos..].starts_with(&['t', 'r', 'u', 'e']) {
                self.pos += 4;
                Ok(Value::Bool(true))
            } else if self.chars[self.pos..].starts_with(&['f', 'a', 'l', 's', 'e']) {
                self.pos += 5;
                Ok(Value::Bool(false))
            } else {
                Err("invalid literal".to_string())
            }
        }

        fn parse_null(&mut self) -> Result<Value, String> {
            if self.chars[self.pos..].starts_with(&['n', 'u', 'l', 'l']) {
                self.pos += 4;
                Ok(Value::Null)
            } else {
                Err("invalid literal".to_string())
            }
        }

        fn parse_number(&mut self) -> Result<Value, String> {
            let start = self.pos;
            if self.chars[self.pos] == '-' {
                self.pos += 1;
            }
            while self.pos < self.chars.len()
                && (self.chars[self.pos].is_ascii_digit()
                    || self.chars[self.pos] == '.'
                    || self.chars[self.pos] == 'e'
                    || self.chars[self.pos] == 'E'
                    || self.chars[self.pos] == '+'
                    || self.chars[self.pos] == '-')
            {
                self.pos += 1;
            }
            let s: String = self.chars[start..self.pos].iter().collect();
            s.parse::<f64>()
                .map(Value::Number)
                .map_err(|e| format!("invalid number '{}': {}", s, e))
        }
    }
}
