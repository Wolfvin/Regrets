use regret_example::fingerprint;
use serde_json::json;

fn main() {
    // Simulate a breaking refactor: add() now returns wrong value
    let input = json!([1, 2]);
    let correct_output = json!(3);
    let broken_output = json!(-1); // add(1,2) returns -1 after "refactor"

    let correct_fp = fingerprint::compute(&input, &correct_output);
    let broken_fp = fingerprint::compute(&input, &broken_output);

    println!("Correct: fingerprint([1,2], 3) = {}", correct_fp);
    println!("Broken:  fingerprint([1,2], -1) = {}", broken_fp);
    println!("Fingerprints differ: {}", correct_fp != broken_fp);

    if broken_fp != correct_fp {
        println!("VALIDATION: FAIL — fingerprint mismatch detected breaking change!");
    }
}
