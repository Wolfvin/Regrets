//! regret-verify — Independent verification fixture for the Rust Regrets stack (PR #355).
//!
//! The 5 functions here are DELIBERATELY DIFFERENT from the ones in
//! `references/rust/src/lib.rs` (add, mul, is_even, reverse_string, fibonacci)
//! to avoid the confirmation-bias trap documented in CONTEXT.md "Lesson Learned":
//! "test ditulis dengan pattern yang sama dengan implementasi".
//!
//! Each function targets a different Rust idiom:
//!   - slugify        : char-by-char transform with String allocation
//!   - base64_encode  : bitwise ops + lookup table (no stdlib base64)
//!   - crc32          : table-driven checksum (no stdlib hash)
//!   - fnv1a          : multiply + XOR per byte
//!   - is_valid_ipv4  : byte-index parser + range check

// ─── Fingerprint module ──────────────────────────────────────────────────────
// COPIED VERBATIM from references/rust/src/lib.rs (PR #355) — the fingerprint
// module is not exposed as a public crate, so each consumer crate must include
// its own copy. The algorithm MUST be byte-identical across all stacks for
// cross-stack .regret parity to hold.

pub mod fingerprint {
    use std::collections::BTreeMap;

    /// Stable JSON stringify — keys sorted recursively.
    /// Must produce identical output to JS stableStringify() and Python stable_dumps().
    pub fn stable_stringify(obj: &serde_json::Value) -> String {
        match obj {
            serde_json::Value::Null => "null".to_string(),
            serde_json::Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
            serde_json::Value::Number(n) => {
                if n.is_i64() {
                    n.as_i64().unwrap().to_string()
                } else if n.is_u64() {
                    n.as_u64().unwrap().to_string()
                } else {
                    let f = n.as_f64().unwrap();
                    if f == f.floor() && f.is_finite() {
                        format!("{}", f as i64)
                    } else {
                        format!("{}", f)
                    }
                }
            }
            serde_json::Value::String(s) => {
                serde_json::to_string(s).unwrap()
            }
            serde_json::Value::Array(arr) => {
                let parts: Vec<String> = arr.iter().map(stable_stringify).collect();
                format!("[{}]", parts.join(","))
            }
            serde_json::Value::Object(map) => {
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
    pub fn to_base36(limbs: [u64; 4]) -> String {
        const CHARS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        const BASE: u64 = 36;

        if limbs.iter().all(|&l| l == 0) {
            return "0".to_string();
        }

        let mut n = limbs;
        let mut result = Vec::new();

        while !n.iter().all(|&l| l == 0) {
            let mut remainder: u64 = 0;
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
    pub fn compute(input: &serde_json::Value, output: &serde_json::Value) -> String {
        let combined = format!("{}|{}", stable_stringify(input), stable_stringify(output));
        let hash = sha256_hex(&combined);

        let mut limbs = [0u64; 4];
        for i in 0..4 {
            let hex_part = &hash[i * 16..(i + 1) * 16];
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
}

// ─── Fresh pure functions (deliberately different from references/rust/) ──────

/// Slugify: lowercase ASCII alphanumerics, replace non-alnum runs with '-',
/// trim leading/trailing '-'. Returns "" for empty input.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_sep = true; // start as sep so leading '-' is trimmed
    for r in s.chars() {
        if r.is_alphanumeric() {
            for lc in r.to_lowercase() {
                out.push(lc);
            }
            last_sep = false;
        } else {
            if !last_sep {
                out.push('-');
                last_sep = true;
            }
        }
    }
    // Trim trailing '-'
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Base64-encode a byte slice using standard base64 alphabet with '=' padding.
/// Empty input returns "". Implemented from scratch (not using base64 crate)
/// to exercise bit manipulation code paths.
pub fn base64_encode(s: &str) -> String {
    let data = s.as_bytes();
    if data.is_empty() {
        return String::new();
    }
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((data.len() + 2) / 3) * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() { data[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3F) as usize] as char);

        if i + 1 < data.len() {
            out.push(ALPHABET[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < data.len() {
            out.push(ALPHABET[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }

        i += 3;
    }
    out
}

/// CRC32 (zlib/zip polynomial 0xEDB88320) of the input string's bytes.
/// Returns the standard 32-bit checksum (initial 0xFFFFFFFF, final XOR 0xFFFFFFFF).
/// Implemented from scratch (not using crc32fast crate) to exercise unsigned
/// arithmetic + table initialization.
pub fn crc32(s: &str) -> u32 {
    let data = s.as_bytes();
    let mut table = [0u32; 256];
    for i in 0..256u32 {
        let mut c = i;
        for _ in 0..8 {
            if c & 1 == 1 {
                c = 0xEDB88320 ^ (c >> 1);
            } else {
                c = c >> 1;
            }
        }
        table[i as usize] = c;
    }
    let mut crc: u32 = 0xFFFFFFFF;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFFFFFF
}

/// FNV-1a 32-bit hash of the input string's bytes.
/// Different algorithm than CRC32 — exercises a different bit-manipulation
/// pattern (multiply + XOR per byte).
pub fn fnv1a(s: &str) -> u32 {
    const OFFSET_BASIS: u32 = 2166136261;
    const PRIME: u32 = 16777619;
    let mut h = OFFSET_BASIS;
    for &b in s.as_bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(PRIME);
    }
    h
}

/// Validate an IPv4 dotted-quad. Returns true iff s is a valid dotted-quad:
/// exactly 4 octets 0-255 separated by single '.', no leading zeros (except
/// "0" itself), no trailing junk. Rejects "01.2.3.4", "1.2.3.4x", "1.2.3", etc.
pub fn is_valid_ipv4(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let bytes = s.as_bytes();
    let mut octets = 0;
    let mut val: u32 = 0;
    let mut digits = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_digit() {
            if digits == 1 && val == 0 {
                return false; // leading zero
            }
            if digits >= 3 {
                return false;
            }
            val = val * 10 + (c - b'0') as u32;
            digits += 1;
            if val > 255 {
                return false;
            }
        } else if c == b'.' {
            if digits == 0 {
                return false; // empty octet
            }
            octets += 1;
            if octets > 4 {
                return false;
            }
            // Next char must be a digit
            if i + 1 >= bytes.len() || !bytes[i + 1].is_ascii_digit() {
                return false;
            }
            val = 0;
            digits = 0;
        } else {
            return false; // invalid char
        }
        i += 1;
    }
    if digits == 0 {
        return false;
    }
    octets += 1;
    octets == 4
}
