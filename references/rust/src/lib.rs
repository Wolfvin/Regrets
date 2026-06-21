//! regret-example — Example pure functions for Regrets regression testing.
//!
//! These functions demonstrate the capture + validate workflow for Rust.
//! Each function is a pure function with deterministic output, making it
//! ideal for fingerprint-based regression testing.

// ─── Fingerprint module ──────────────────────────────────────────────────────
// Implements the same fingerprint algorithm as fingerprint.js / fingerprint.py /
// capture_go.sh: SHA-256(stableStringify(input) + "|" + stableStringify(output))
// → base36 → first 7 chars.
//
// The stableStringify implementation must produce identical output across all
// stacks for the same input. This is the core contract that makes cross-stack
// .regret files possible.

pub mod fingerprint {
    use std::collections::BTreeMap;

    /// Stable JSON stringify — keys sorted recursively.
    /// Must produce identical output to JS stableStringify() and Python stable_dumps().
    pub fn stable_stringify(obj: &serde_json::Value) -> String {
        match obj {
            serde_json::Value::Null => "null".to_string(),
            serde_json::Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
            serde_json::Value::Number(n) => {
                // Match JS/Python number formatting:
                // Integers print without decimal, floats use minimal representation
                if n.is_i64() {
                    n.as_i64().unwrap().to_string()
                } else if n.is_u64() {
                    n.as_u64().unwrap().to_string()
                } else {
                    // Float — use Python-like repr format
                    let f = n.as_f64().unwrap();
                    if f == f.floor() && f.is_finite() {
                        // Whole number float — format without decimal
                        format!("{}", f as i64)
                    } else {
                        format!("{}", f)
                    }
                }
            }
            serde_json::Value::String(s) => {
                // Use serde_json to get properly escaped JSON string
                serde_json::to_string(s).unwrap()
            }
            serde_json::Value::Array(arr) => {
                let parts: Vec<String> = arr.iter().map(stable_stringify).collect();
                format!("[{}]", parts.join(","))
            }
            serde_json::Value::Object(map) => {
                // Sort keys for deterministic output — BTreeMap gives sorted iteration
                let sorted: BTreeMap<_, _> = map.iter().collect();
                let parts: Vec<String> = sorted
                    .iter()
                    .map(|(k, v)| {
                        let key_str = serde_json::to_string(*k).unwrap();
                        format!("{}:{}", key_str, stable_stringify(v))
                    })
                    .collect();
                format!("{{{}}}", parts.join(","))
            }
        }
    }

    /// Convert a 256-bit big integer (represented as 4 u64 limbs, little-endian)
    /// to base36 string (lowercase).
    /// Must produce identical output to JS BigInt.toString(36) and Python to_base36().
    pub fn to_base36(limbs: [u64; 4]) -> String {
        const CHARS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        const BASE: u64 = 36;

        // Check for zero
        if limbs.iter().all(|&l| l == 0) {
            return "0".to_string();
        }

        let mut n = limbs;
        let mut result = Vec::new();

        // Repeated division by 36 on our 256-bit number
        while !n.iter().all(|&l| l == 0) {
            let mut remainder: u64 = 0;
            // Process from most significant limb to least significant
            for i in (0..4).rev() {
                let cur = (remainder << 32) | (n[i] >> 32);
                let new_high = cur / BASE;
                remainder = cur % BASE;
                let cur2 = (remainder << 32) | (n[i] & 0xFFFFFFFF);
                let new_low = cur2 / BASE;
                remainder = cur2 % BASE;
                n[i] = (new_high << 32) | new_low;
            }
            result.push(CHARS[remainder as usize] as char);
        }

        result.reverse();
        result.into_iter().collect()
    }

    /// Compute the 7-char base36 fingerprint.
    /// IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint.go:
    ///   sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars
    pub fn compute(input: &serde_json::Value, output: &serde_json::Value) -> String {
        let combined = format!("{}|{}", stable_stringify(input), stable_stringify(output));
        let hash = sha256_hex(&combined);

        // Convert full 256-bit hex hash to 4 x u64 limbs (little-endian)
        let mut limbs = [0u64; 4];
        for i in 0..4 {
            let hex_part = &hash[i * 16..(i + 1) * 16];
            // Read as big-endian hex, store in limb index 3-i so limb[0] is least significant
            limbs[3 - i] = u64::from_str_radix(hex_part, 16).unwrap();
        }
        let b36 = to_base36(limbs);
        if b36.len() >= 7 {
            b36[..7].to_string()
        } else {
            b36
        }
    }

    /// SHA-256 digest, returning hex string.
    pub fn sha256_hex(input: &str) -> String {
        let bytes = sha256_raw(input.as_bytes());
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    // Minimal pure-Rust SHA-256 implementation
    // (avoids adding sha2 as a dependency to keep the example self-contained)
    fn sha256_raw(message: &[u8]) -> [u8; 32] {
        let mut h: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ];
        let k: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
            0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
            0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
            0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
            0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ];

        let mut msg = message.to_vec();
        let bit_len = message.len() as u64 * 8;
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0x00);
        }
        msg.extend_from_slice(&bit_len.to_be_bytes());

        for chunk in msg.chunks(64) {
            let mut w = [0u32; 64];
            for i in 0..16 {
                w[i] = u32::from_be_bytes([
                    chunk[i * 4],
                    chunk[i * 4 + 1],
                    chunk[i * 4 + 2],
                    chunk[i * 4 + 3],
                ]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
            }

            let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;

            for i in 0..64 {
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let ch = (e & f) ^ ((!e) & g);
                let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(k[i]).wrapping_add(w[i]);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let maj = (a & b) ^ (a & c) ^ (b & c);
                let temp2 = s0.wrapping_add(maj);

                hh = g;
                g = f;
                f = e;
                e = d.wrapping_add(temp1);
                d = c;
                c = b;
                b = a;
                a = temp1.wrapping_add(temp2);
            }

            h[0] = h[0].wrapping_add(a);
            h[1] = h[1].wrapping_add(b);
            h[2] = h[2].wrapping_add(c);
            h[3] = h[3].wrapping_add(d);
            h[4] = h[4].wrapping_add(e);
            h[5] = h[5].wrapping_add(f);
            h[6] = h[6].wrapping_add(g);
            h[7] = h[7].wrapping_add(hh);
        }

        let mut result = [0u8; 32];
        for i in 0..8 {
            result[i * 4..i * 4 + 4].copy_from_slice(&h[i].to_be_bytes());
        }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn test_stable_stringify_simple() {
            assert_eq!(stable_stringify(&json!("hello")), "\"hello\"");
            assert_eq!(stable_stringify(&json!(42)), "42");
            assert_eq!(stable_stringify(&json!(true)), "true");
            assert_eq!(stable_stringify(&json!(null)), "null");
        }

        #[test]
        fn test_stable_stringify_sorted_keys() {
            let obj = json!({"b": 2, "a": 1});
            let result = stable_stringify(&obj);
            assert_eq!(result, "{\"a\":1,\"b\":2}");
        }

        #[test]
        fn test_stable_stringify_array() {
            let arr = json!([1, "two", true]);
            assert_eq!(stable_stringify(&arr), "[1,\"two\",true]");
        }

        #[test]
        fn test_base36() {
            assert_eq!(to_base36([0, 0, 0, 0]), "0");
            assert_eq!(to_base36([1, 0, 0, 0]), "1");
            assert_eq!(to_base36([35, 0, 0, 0]), "z");
            assert_eq!(to_base36([36, 0, 0, 0]), "10");
        }

        #[test]
        fn test_fingerprint_deterministic() {
            let input = json!(5783);
            let output = json!(false);
            let fp1 = compute(&input, &output);
            let fp2 = compute(&input, &output);
            assert_eq!(fp1, fp2);
            assert_eq!(fp1.len(), 7);
        }

        #[test]
        fn test_sha256_empty() {
            // Known test vector: SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
            let result = sha256_hex("");
            assert_eq!(result, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        }
    }
}

// ─── Example pure functions ──────────────────────────────────────────────────
// These are the functions we'll capture and validate with Regrets.
// They are intentionally simple, deterministic, and pure (no side effects).

/// Add two integers. Classic pure function.
pub fn add(a: i64, b: i64) -> i64 {
    a + b
}

/// Multiply two integers.
pub fn mul(a: i64, b: i64) -> i64 {
    a * b
}

/// Check if a number is even.
pub fn is_even(n: i64) -> bool {
    n % 2 == 0
}

/// Reverse a string.
pub fn reverse_string(s: &str) -> String {
    s.chars().rev().collect()
}

/// Compute the nth Fibonacci number (0-indexed).
pub fn fibonacci(n: u32) -> u64 {
    if n == 0 { return 0; }
    if n == 1 { return 1; }
    let mut a = 0u64;
    let mut b = 1u64;
    for _ in 2..=n {
        let temp = a + b;
        a = b;
        b = temp;
    }
    b
}

#[cfg(test)]
mod example_tests {
    use super::*;

    #[test]
    fn test_add() {
        assert_eq!(add(1, 2), 3);
        assert_eq!(add(-1, 1), 0);
        assert_eq!(add(0, 0), 0);
    }

    #[test]
    fn test_mul() {
        assert_eq!(mul(3, 4), 12);
        assert_eq!(mul(-2, 5), -10);
        assert_eq!(mul(0, 100), 0);
    }

    #[test]
    fn test_is_even() {
        assert!(is_even(4));
        assert!(!is_even(7));
        assert!(is_even(0));
    }

    #[test]
    fn test_reverse_string() {
        assert_eq!(reverse_string("hello"), "olleh");
        assert_eq!(reverse_string(""), "");
        assert_eq!(reverse_string("a"), "a");
    }

    #[test]
    fn test_fibonacci() {
        assert_eq!(fibonacci(0), 0);
        assert_eq!(fibonacci(1), 1);
        assert_eq!(fibonacci(10), 55);
        assert_eq!(fibonacci(20), 6765);
    }
}
