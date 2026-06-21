use regret_example::fingerprint;
use serde_json::json;

fn main() {
    let fp1 = fingerprint::compute(&json!(5783), &json!(false));
    let fp2 = fingerprint::compute(&json!([1, 2]), &json!(3));
    let fp3 = fingerprint::compute(&json!("hello"), &json!("olleh"));

    println!("Rust fingerprint(5783, false): {}", fp1);
    println!("Rust fingerprint([1,2], 3): {}", fp2);
    println!("Rust fingerprint(\"hello\", \"olleh\"): {}", fp3);

    // Compare with JS results
    assert_eq!(fp1, "5wtkimf", "Cross-stack mismatch: fingerprint(5783, false)");
    assert_eq!(fp2, "63qoext", "Cross-stack mismatch: fingerprint([1,2], 3)");
    assert_eq!(fp3, "5nssd6s", "Cross-stack mismatch: fingerprint(\"hello\", \"olleh\")");

    println!("All cross-stack fingerprint tests PASSED!");
}
