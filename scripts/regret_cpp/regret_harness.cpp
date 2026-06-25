// regret_harness.cpp — capture + validate regret contracts for C++ clusters.
//
// Single-file C++ harness. Compile with:
//
//     g++ -std=c++17 -O2 -rdynamic -o regret_runner
//         regret_harness.cpp user.cpp adapter.cpp
//         -lcrypto -ljson-c -ldl -lm
//
// Run:
//     ./regret_runner capture  [--cluster <id>] [--manifest <path>]
//     ./regret_runner validate [--cluster <id>] [--manifest <path>]
//
// Reads `regrets/manifest.json`, filters clusters with `stack: "cpp"`,
// invokes each cluster's `entry` symbol via dlsym(RTLD_DEFAULT, ...)
// with the cluster's INPUT (JSON string), receives the OUTPUT
// (JSON string), and computes the 7-char base36 fingerprint identical
// to fingerprint.js / fingerprint.py / regret_harness.c (C stack).
//
// C++-specific behavior:
//   - C++ exceptions thrown by adapter or user code are caught by the
//     harness and treated as a skip (matching JS "throws" trivial-input
//     guard).
//   - extern "C" linkage required for adapter functions so dlsym can
//     find them without name mangling.
//
// In capture mode, writes `<id>.regret` files in the standard format.
// In validate mode, re-invokes the entry, recomputes the hash, and
// compares against the golden HASH from the existing `.regret` file.
//
// Exit code: 0 = all clusters PASS, 1 = at least one FAIL or error.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <cmath>
#include <cerrno>
#include <cctype>
#include <string>
#include <vector>
#include <memory>
#include <unordered_set>

#include <unistd.h>
#include <dlfcn.h>
#include <openssl/sha.h>
#include <openssl/bn.h>
#include <json-c/json.h>
#include <json-c/json_object.h>

#include "regret.hpp"

// strdup is POSIX, not standard C++. Provide a wrapper.
namespace regret_detail {
inline char* strdup_compat(const char* s) {
    size_t len = std::strlen(s) + 1;
    char* p = static_cast<char*>(std::malloc(len));
    if (p) std::memcpy(p, s, len);
    return p;
}
}  // namespace regret_detail

// ─── RAII helpers for C library resources ──────────────────────────────────

struct JsonDeleter {
    void operator()(json_object* o) const { if (o) json_object_put(o); }
};
using JsonPtr = std::unique_ptr<json_object, JsonDeleter>;

struct FileCloser {
    void operator()(FILE* f) const { if (f) std::fclose(f); }
};
using FilePtr = std::unique_ptr<FILE, FileCloser>;

struct BnDeleter {
    void operator()(BIGNUM* bn) const { if (bn) BN_free(bn); }
};
using BnPtr = std::unique_ptr<BIGNUM, BnDeleter>;

// Malloc'd string RAII (for adapter return values)
struct CharDeleter {
    void operator()(char* p) const { std::free(p); }
};
using CharPtr = std::unique_ptr<char, CharDeleter>;

// ─── Helpers ──────────────────────────────────────────────────────────────

static void die(const char* msg) {
    std::fprintf(stderr, "❌ %s\n", msg);
    std::exit(2);
}

static std::string read_file(const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return "";
    std::fseek(f, 0, SEEK_END);
    long sz = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    std::string buf;
    buf.resize(sz);
    size_t n = std::fread(&buf[0], 1, sz, f);
    std::fclose(f);
    buf.resize(n);
    return buf;
}

static std::string iso_now() {
    std::time_t t = std::time(nullptr);
    struct tm tm_local;
    localtime_r(&t, &tm_local);
    long offset_secs = tm_local.tm_gmtoff;
    char sign = offset_secs >= 0 ? '+' : '-';
    long offset_mins = std::labs(offset_secs) / 60;
    int oh = static_cast<int>(offset_mins / 60);
    int om = static_cast<int>(offset_mins % 60);
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.000000%c%02d:%02d",
                  tm_local.tm_year + 1900, tm_local.tm_mon + 1, tm_local.tm_mday,
                  tm_local.tm_hour, tm_local.tm_min, tm_local.tm_sec,
                  sign, oh, om);
    return std::string(buf);
}

// ─── Stable stringify (byte-identical to fingerprint.js / regret_harness.c) ─

static int cmp_strptr(const void* a, const void* b) {
    const char* sa = *(const char* const*)a;
    const char* sb = *(const char* const*)b;
    return std::strcmp(sa, sb);
}

static void stable_write_string(const char* s, FILE* out) {
    std::fputc('"', out);
    for (const unsigned char* p = reinterpret_cast<const unsigned char*>(s); *p; p++) {
        unsigned char c = *p;
        switch (c) {
            case '"':  std::fputs("\\\"", out); break;
            case '\\': std::fputs("\\\\", out); break;
            case '\b': std::fputs("\\b", out); break;
            case '\f': std::fputs("\\f", out); break;
            case '\n': std::fputs("\\n", out); break;
            case '\r': std::fputs("\\r", out); break;
            case '\t': std::fputs("\\t", out); break;
            default:
                if (c < 0x20) {
                    std::fprintf(out, "\\u%04x", c);
                } else {
                    std::fputc(c, out);
                }
        }
    }
    std::fputc('"', out);
}

static void stable_write(json_object* obj, FILE* out) {
    if (obj == nullptr) { std::fputs("null", out); return; }

    enum json_type type = json_object_get_type(obj);
    switch (type) {
        case json_type_null:
            std::fputs("null", out);
            break;
        case json_type_boolean:
            std::fputs(json_object_get_boolean(obj) ? "true" : "false", out);
            break;
        case json_type_int: {
            int64_t v = json_object_get_int64(obj);
            std::fprintf(out, "%lld", static_cast<long long>(v));
            break;
        }
        case json_type_double: {
            double d = json_object_get_double(obj);
            if (std::isnan(d)) { std::fputs("\"__nan__\"", out); break; }
            if (std::isinf(d)) {
                std::fputs(d > 0 ? "\"__infinity__\"" : "\"__neg_infinity__\"", out);
                break;
            }
            // Match JS Number.toString(): whole numbers without trailing .0
            if (d == std::floor(d) && std::fabs(d) < 1e21) {
                std::fprintf(out, "%lld", static_cast<long long>(d));
            } else {
                char buf[64];
                std::snprintf(buf, sizeof(buf), "%.17g", d);
                std::fputs(buf, out);
            }
            break;
        }
        case json_type_string:
            stable_write_string(json_object_get_string(obj), out);
            break;
        case json_type_array: {
            int n = json_object_array_length(obj);
            std::fputc('[', out);
            for (int i = 0; i < n; i++) {
                if (i > 0) std::fputc(',', out);
                stable_write(json_object_array_get_idx(obj, i), out);
            }
            std::fputc(']', out);
            break;
        }
        case json_type_object: {
            // Collect keys, sort lexicographically, write in order.
            struct json_object_iterator it = json_object_iter_begin(obj);
            struct json_object_iterator itEnd = json_object_iter_end(obj);
            int count = 0;
            int cap = 16;
            char** keys = static_cast<char**>(std::malloc(cap * sizeof(char*)));
            while (!json_object_iter_equal(&it, &itEnd)) {
                const char* k = json_object_iter_peek_name(&it);
                if (count >= cap) {
                    cap *= 2;
                    keys = static_cast<char**>(std::realloc(keys, cap * sizeof(char*)));
                }
                keys[count++] = regret_detail::strdup_compat(k);
                json_object_iter_next(&it);
            }
            std::qsort(keys, count, sizeof(char*), cmp_strptr);

            std::fputc('{', out);
            for (int i = 0; i < count; i++) {
                if (i > 0) std::fputc(',', out);
                stable_write_string(keys[i], out);
                std::fputc(':', out);
                struct json_object* val = nullptr;
                json_object_object_get_ex(obj, keys[i], &val);
                stable_write(val, out);
            }
            std::fputc('}', out);

            for (int i = 0; i < count; i++) std::free(keys[i]);
            std::free(keys);
            break;
        }
    }
}

static std::string stable_stringify(json_object* obj) {
    char* buf = nullptr;
    size_t len = 0;
    FILE* mem = open_memstream(&buf, &len);
    if (!mem) return "";
    stable_write(obj, mem);
    std::fclose(mem);
    std::string result(buf ? buf : "");
    if (buf) std::free(buf);
    return result;
}

// ─── Fingerprint — MUST be byte-identical to fingerprint.js / C harness ────

static std::string compute_fingerprint(json_object* input, json_object* output) {
    std::string s_input = stable_stringify(input);
    std::string s_output = stable_stringify(output);

    std::string combined = s_input + "|" + s_output;

    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(combined.data()),
           combined.size(), hash);

    // Hex string
    char hex[2 * SHA256_DIGEST_LENGTH + 1];
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) {
        std::snprintf(hex + 2 * i, 4, "%02x", hash[i]);
    }
    hex[2 * SHA256_DIGEST_LENGTH] = '\0';

    // Hex → BIGNUM → base36
    BIGNUM* bn_raw = nullptr;
    if (!BN_hex2bn(&bn_raw, hex)) return "";
    BnPtr bn(bn_raw);

    // Convert to base36 by repeated divmod (result built in reverse then reversed)
    char tmp[80];
    int pos = 0;
    if (BN_is_zero(bn.get())) {
        tmp[pos++] = '0';
    } else {
        BN_ULONG base = 36;
        while (!BN_is_zero(bn.get())) {
            BN_ULONG rem = BN_div_word(bn.get(), base);
            char c = (rem < 10) ? ('0' + static_cast<char>(rem))
                                : ('a' + static_cast<char>(rem - 10));
            tmp[pos++] = c;
        }
    }

    // Reverse
    for (int i = 0, j = pos - 1; i < j; i++, j--) {
        char t = tmp[i]; tmp[i] = tmp[j]; tmp[j] = t;
    }

    // Pad with leading zeros to at least 7 chars
    std::string result;
    if (pos < 7) {
        int pad = 7 - pos;
        result.append(pad, '0');
        result.append(tmp, pos);
    } else {
        result.assign(tmp, 7);
    }
    return result;
}

// ─── .regret file build & parse ───────────────────────────────────────────

static std::string build_regret_content(json_object* cluster, const std::string& id,
                                        const std::string& entry_symbol,
                                        const std::string& fp,
                                        json_object* input, json_object* output,
                                        const std::string& inputs_line = "") {
    char* buf = nullptr;
    size_t len = 0;
    FILE* mem = open_memstream(&buf, &len);
    if (!mem) return "";

    std::string ts = iso_now();
    std::fprintf(mem, "cluster: %s\n", id.c_str());
    std::fputs("version: 1\n", mem);
    std::fprintf(mem, "fingerprint: %s\n", fp.c_str());
    std::fprintf(mem, "captured: %s\n", ts.c_str());

    // watches
    struct json_object* watches = nullptr;
    if (json_object_object_get_ex(cluster, "watches", &watches) &&
        json_object_is_type(watches, json_type_array)) {
        std::fputs("watches: [", mem);
        int n = json_object_array_length(watches);
        for (int i = 0; i < n; i++) {
            if (i > 0) std::fputs(", ", mem);
            struct json_object* w = json_object_array_get_idx(watches, i);
            std::fputs(json_object_get_string(w), mem);
        }
        std::fputs("]\n", mem);
    } else {
        std::fprintf(mem, "watches: [%s]\n", entry_symbol.c_str());
    }

    const char* level = "entry";
    struct json_object* lvl = nullptr;
    if (json_object_object_get_ex(cluster, "fingerprintLevel", &lvl)) {
        level = json_object_get_string(lvl);
    }

    const char* stack = "cpp";
    struct json_object* stk = nullptr;
    if (json_object_object_get_ex(cluster, "stack", &stk)) {
        stack = json_object_get_string(stk);
    }

    std::fprintf(mem, "entry: %s\n", entry_symbol.c_str());
    std::fprintf(mem, "stack: %s\n", stack);
    std::fprintf(mem, "fingerprintLevel: %s\n", level);
    std::fputs("---\n", mem);

    const char* input_str = json_object_to_json_string_ext(input, JSON_C_TO_STRING_PLAIN);
    const char* output_str = json_object_to_json_string_ext(output, JSON_C_TO_STRING_PLAIN);
    std::fprintf(mem, "INPUT  %s\n", input_str);
    std::fprintf(mem, "OUTPUT %s\n", output_str);
    std::fprintf(mem, "HASH   %s\n", fp.c_str());

    // Issue #315: multi-input INPUTS line.
    // Written ONLY when the cluster has more than one input (no overhead for the
    // common single-input case). The array contains entries for inputs 1+ (the
    // first input is already represented by the top-level INPUT/OUTPUT/HASH
    // trio). Each entry: { "input": <val>, "output": <val>, "hash": "<fp>" }.
    // On validate, every entry's hash is compared against the live re-run hash
    // of the matching manifest input (matched by VALUE via stable_stringify).
    // Any mismatch FAILs the cluster even when the first input still matches.
    if (!inputs_line.empty()) {
        std::fprintf(mem, "INPUTS %s\n", inputs_line.c_str());
    }

    std::fclose(mem);
    std::string result(buf ? buf : "");
    if (buf) std::free(buf);
    return result;
}

struct ParsedRegret {
    std::string input_json;
    std::string output_json;
    std::string hash;
    std::string inputs_json;  // Issue #315: raw INPUTS line payload (without "INPUTS " prefix); empty if absent
};

static bool parse_regret(const std::string& content, ParsedRegret& out) {
    size_t pos = 0;
    while (pos < content.size()) {
        size_t eol = content.find('\n', pos);
        if (eol == std::string::npos) eol = content.size();
        std::string line = content.substr(pos, eol - pos);
        pos = (eol == content.size()) ? eol : eol + 1;

        // Strip a trailing '\r' left over from CRLF line endings. Git's
        // core.autocrlf=true (the standard Windows git setting) rewrites
        // .regret files to CRLF on checkout; without this, every value
        // (HASH/OUTPUT/etc.) below would carry a trailing '\r' that never
        // matches a freshly computed value, failing every cluster on an
        // unmodified checkout (confirmed root cause of the equivalent bug
        // in scripts/regret_java/RegretJava.java's parseRegret()).
        if (!line.empty() && line.back() == '\r') line.pop_back();

        if (line == "---") continue;
        if (line.empty()) continue;

        // Find first whitespace (key/value separator)
        size_t sep = std::string::npos;
        for (size_t i = 0; i < line.size(); i++) {
            if (line[i] == ' ' || line[i] == '\t') { sep = i; break; }
        }
        if (sep == std::string::npos) continue;

        std::string key = line.substr(0, sep);
        size_t val_start = sep;
        while (val_start < line.size() &&
               (line[val_start] == ' ' || line[val_start] == '\t')) {
            val_start++;
        }
        std::string val = line.substr(val_start);

        if (key == "INPUT")   out.input_json = val;
        else if (key == "OUTPUT") out.output_json = val;
        else if (key == "HASH")   out.hash = val;
        else if (key == "INPUTS") out.inputs_json = val;  // Issue #315
    }
    return !out.hash.empty() && !out.input_json.empty();
}

// ─── Issue #315: multi-input golden entry ──────────────────────────────────
//
// A single element of the INPUTS array parsed from a .regret file:
//   { "input": <val>, "output": <val>, "hash": "<fp>" }
// We compare each entry's hash against the live re-run hash of the matching
// manifest input (matched by VALUE via stable_stringify). Any mismatch FAILs
// the cluster even when the first input still matches.

struct GoldenInput {
    std::string input_json;   // raw JSON string of the input (as written in INPUTS)
    std::string hash;          // stored golden hash
};

static std::vector<GoldenInput> parse_golden_inputs(const std::string& inputs_json) {
    std::vector<GoldenInput> result;
    if (inputs_json.empty()) return result;

    json_object* arr_raw = json_tokener_parse(inputs_json.c_str());
    if (!arr_raw || !json_object_is_type(arr_raw, json_type_array)) {
        if (arr_raw) json_object_put(arr_raw);
        return result;
    }
    JsonPtr arr(arr_raw);

    size_t n = json_object_array_length(arr.get());
    for (size_t i = 0; i < n; i++) {
        json_object* entry = json_object_array_get_idx(arr.get(), i);
        if (!entry || !json_object_is_type(entry, json_type_object)) continue;

        json_object* in = nullptr;
        json_object* hash = nullptr;
        if (!json_object_object_get_ex(entry, "input", &in)) continue;
        if (!json_object_object_get_ex(entry, "hash", &hash)) continue;

        GoldenInput gi;
        gi.input_json = json_object_to_json_string_ext(in, JSON_C_TO_STRING_PLAIN);
        gi.hash = json_object_get_string(hash);
        result.push_back(std::move(gi));
    }
    return result;
}

// ─── Manifest reading ─────────────────────────────────────────────────────

struct ClusterInfo {
    std::string id;
    std::string entry;
    JsonPtr cluster_obj;  // owns the reference
};

static std::vector<ClusterInfo> read_clusters(const std::string& manifest_path,
                                              const std::string& cluster_filter) {
    std::string content = read_file(manifest_path);
    if (content.empty()) die("failed to read manifest");

    json_object* root_raw = json_tokener_parse(content.c_str());
    if (!root_raw) die("failed to parse manifest JSON");

    json_object* clusters = nullptr;
    if (!json_object_object_get_ex(root_raw, "clusters", &clusters) ||
        !json_object_is_type(clusters, json_type_array)) {
        json_object_put(root_raw);
        die("manifest.clusters must be an array");
    }

    std::vector<ClusterInfo> result;
    size_t n = json_object_array_length(clusters);
    for (size_t i = 0; i < n; i++) {
        json_object* c = json_object_array_get_idx(clusters, i);
        struct json_object* stack_obj = nullptr;
        if (!json_object_object_get_ex(c, "stack", &stack_obj)) continue;
        std::string stack = json_object_get_string(stack_obj);
        if (stack != "cpp") continue;

        struct json_object* id_obj = nullptr;
        if (!json_object_object_get_ex(c, "id", &id_obj)) continue;
        std::string id = json_object_get_string(id_obj);

        if (!cluster_filter.empty() && id != cluster_filter) continue;

        struct json_object* entry_obj = nullptr;
        std::string entry = "regret_entry";
        if (json_object_object_get_ex(c, "entry", &entry_obj)) {
            entry = json_object_get_string(entry_obj);
        }

        ClusterInfo ci;
        ci.id = id;
        ci.entry = entry;
        ci.cluster_obj.reset(c);
        json_object_get(c);  // take ownership
        result.push_back(std::move(ci));
    }
    json_object_put(root_raw);
    return result;
}

// Get regrets/ dir from manifest path (dirname)
static std::string dirname_of(const std::string& path) {
    size_t slash = path.find_last_of('/');
    if (slash == std::string::npos) return ".";
    return path.substr(0, slash);
}

// ─── Exception-safe adapter invocation ────────────────────────────────────
//
// C++ adapters may throw. We catch all C++ exceptions here and treat
// them as a skip (matching the JS "throws" trivial-input guard).

struct InvokeResult {
    bool threw = false;
    std::string error_msg;
    CharPtr output;  // malloc'd JSON string from adapter (or null on throw/error)
};

static InvokeResult invoke_adapter(regret_entry_fn fn, const std::string& input_json) {
    InvokeResult result;
    try {
        char* out = fn(input_json.c_str());
        result.output.reset(out);
    } catch (const std::exception& e) {
        result.threw = true;
        result.error_msg = std::string("std::exception: ") + e.what();
    } catch (...) {
        result.threw = true;
        result.error_msg = "unknown C++ exception";
    }
    return result;
}

// ─── Capture ──────────────────────────────────────────────────────────────

static int run_capture(const std::string& manifest_path,
                       const std::string& cluster_filter) {
    auto clusters = read_clusters(manifest_path, cluster_filter);
    if (clusters.empty()) {
        std::printf("No C++ clusters found in manifest.\n");
        return 0;
    }

    std::string regret_dir = dirname_of(manifest_path);

    int captured = 0, skipped = 0, failed = 0;
    for (auto& ci : clusters) {
        std::printf("\n📡 Capturing C++ cluster: %s\n", ci.id.c_str());

        regret_entry_fn fn = reinterpret_cast<regret_entry_fn>(
            dlsym(RTLD_DEFAULT, ci.entry.c_str()));
        if (!fn) {
            std::printf("   ❌ Entry symbol not found: %s (%s)\n",
                        ci.entry.c_str(), dlerror());
            failed++;
            continue;
        }

        // Get first input from inputs[]
        struct json_object* inputs = nullptr;
        json_object_object_get_ex(ci.cluster_obj.get(), "inputs", &inputs);
        json_object* input_raw = nullptr;
        if (inputs && json_object_is_type(inputs, json_type_array) &&
            json_object_array_length(inputs) > 0) {
            input_raw = json_object_array_get_idx(inputs, 0);
            json_object_get(input_raw);
        } else {
            input_raw = json_object_new_null();
        }
        JsonPtr input(input_raw);

        std::string input_str = json_object_to_json_string_ext(input.get(),
                                                                JSON_C_TO_STRING_PLAIN);

        // Invoke adapter (with C++ exception safety)
        InvokeResult inv = invoke_adapter(fn, input_str);

        if (inv.threw) {
            std::printf("   ⏭️  Skipped: adapter threw C++ exception (%s)\n",
                        inv.error_msg.c_str());
            skipped++;
            continue;
        }
        if (!inv.output) {
            std::printf("   ⏭️  Skipped: entry returned NULL (trivial-input guard)\n");
            skipped++;
            continue;
        }

        json_object* output_raw = json_tokener_parse(inv.output.get());
        if (!output_raw) {
            std::printf("   ❌ Entry returned invalid JSON output\n");
            failed++;
            continue;
        }
        JsonPtr output(output_raw);

        if (json_object_is_type(output.get(), json_type_null)) {
            std::printf("   ⏭️  Skipped: output is null (trivial-input guard)\n");
            skipped++;
            continue;
        }

        std::string fp = compute_fingerprint(input.get(), output.get());
        if (fp.empty()) {
            std::printf("   ❌ Fingerprint computation failed\n");
            failed++;
            continue;
        }

        // ─── Issue #315: capture remaining inputs (1+) for the multi-input contract ──
        //
        // The first input is the golden (top-level INPUT/OUTPUT/HASH above).
        // For each remaining input in the manifest's `inputs` array, we invoke
        // the adapter, compute its hash, and append an entry to the INPUTS line.
        // On validate, every entry's hash is compared against the live re-run
        // hash of the matching manifest input — any mismatch FAILs the cluster
        // even when the first input still matches.
        //
        // Backward compatibility:
        //   - Single-input clusters: inputs_line stays empty (no INPUTS line written).
        //   - Multi-input clusters where inputs[1+] throw or return null: that
        //     entry is silently OMITTED from INPUTS (preserves the "trivial-input
        //     guard" semantics — we don't want a single bad input to break the
        //     whole cluster capture). Re-capture after fixing the function.
        std::string inputs_line;
        if (inputs && json_object_is_type(inputs, json_type_array) &&
            json_object_array_length(inputs) > 1) {
            json_object* inputs_arr_raw = json_object_new_array();
            JsonPtr inputs_arr(inputs_arr_raw);

            size_t n_inputs = json_object_array_length(inputs);
            for (size_t i = 1; i < n_inputs; i++) {
                json_object* cur_raw = json_object_array_get_idx(inputs, i);
                json_object_get(cur_raw);
                JsonPtr cur(cur_raw);

                std::string cur_str = json_object_to_json_string_ext(
                    cur.get(), JSON_C_TO_STRING_PLAIN);

                InvokeResult cur_inv = invoke_adapter(fn, cur_str);
                if (cur_inv.threw || !cur_inv.output) {
                    // Skip this input — preserves trivial-input guard semantics.
                    continue;
                }

                json_object* cur_out_raw = json_tokener_parse(cur_inv.output.get());
                if (!cur_out_raw) continue;
                JsonPtr cur_out(cur_out_raw);

                if (json_object_is_type(cur_out.get(), json_type_null)) continue;

                std::string cur_fp = compute_fingerprint(cur.get(), cur_out.get());
                if (cur_fp.empty()) continue;

                // Build entry: { "input": <val>, "output": <val>, "hash": "<fp>" }
                json_object* entry = json_object_new_object();
                json_object_object_add(entry, "input",
                                       json_object_get(cur.get()));  // increments refcount
                json_object_object_add(entry, "output",
                                       json_object_get(cur_out.get()));
                json_object_object_add(entry, "hash",
                                       json_object_new_string(cur_fp.c_str()));
                json_object_array_add(inputs_arr.get(), entry);
            }

            // Only emit INPUTS line if at least one extra input was captured.
            size_t n_extra = json_object_array_length(inputs_arr.get());
            if (n_extra > 0) {
                const char* arr_str = json_object_to_json_string_ext(
                    inputs_arr.get(), JSON_C_TO_STRING_PLAIN);
                inputs_line = std::string(arr_str);
            }
        }

        std::string regret_content = build_regret_content(
            ci.cluster_obj.get(), ci.id, ci.entry, fp, input.get(), output.get(),
            inputs_line);

        std::string regret_path = regret_dir + "/" + ci.id + ".regret";
        FILE* rf = std::fopen(regret_path.c_str(), "wb");
        if (!rf) {
            std::printf("   ❌ Cannot write %s: %s\n", regret_path.c_str(),
                        std::strerror(errno));
            failed++;
            continue;
        }
        std::fputs(regret_content.c_str(), rf);
        std::fclose(rf);

        std::printf("   ✅ Fingerprint: %s\n", fp.c_str());
        std::printf("   📄 Saved: %s\n", regret_path.c_str());
        captured++;
    }

    std::printf("\n────────────────────────────────────────\n");
    std::printf("Captured: %d  Skipped: %d  Failed: %d\n", captured, skipped, failed);
    return (failed > 0) ? 1 : 0;
}

// ─── Validate ─────────────────────────────────────────────────────────────

static int run_validate(const std::string& manifest_path,
                        const std::string& cluster_filter) {
    auto clusters = read_clusters(manifest_path, cluster_filter);
    if (clusters.empty()) {
        std::printf("No C++ clusters found in manifest.\n");
        return 0;
    }

    std::string regret_dir = dirname_of(manifest_path);

    int passed = 0, failed = 0, missing = 0;
    for (auto& ci : clusters) {
        std::printf("\n🔍 Validating C++ cluster: %s\n", ci.id.c_str());

        regret_entry_fn fn = reinterpret_cast<regret_entry_fn>(
            dlsym(RTLD_DEFAULT, ci.entry.c_str()));
        if (!fn) {
            std::printf("   ❌ Entry symbol not found: %s (%s)\n",
                        ci.entry.c_str(), dlerror());
            failed++;
            continue;
        }

        std::string regret_path = regret_dir + "/" + ci.id + ".regret";
        std::string regret_content = read_file(regret_path);
        if (regret_content.empty()) {
            std::printf("   ❌ MISSING .regret file: %s\n", regret_path.c_str());
            missing++;
            continue;
        }

        ParsedRegret parsed;
        if (!parse_regret(regret_content, parsed)) {
            std::printf("   ❌ Failed to parse .regret file\n");
            failed++;
            continue;
        }

        json_object* golden_input_raw = json_tokener_parse(parsed.input_json.c_str());
        if (!golden_input_raw) {
            std::printf("   ❌ Cannot parse golden INPUT: %s\n", parsed.input_json.c_str());
            failed++;
            continue;
        }
        JsonPtr golden_input(golden_input_raw);

        std::string input_str = json_object_to_json_string_ext(
            golden_input.get(), JSON_C_TO_STRING_PLAIN);

        InvokeResult inv = invoke_adapter(fn, input_str);
        if (inv.threw) {
            std::printf("   ❌ Adapter threw C++ exception on re-invoke: %s\n",
                        inv.error_msg.c_str());
            failed++;
            continue;
        }
        if (!inv.output) {
            std::printf("   ❌ Entry returned NULL on re-invoke\n");
            failed++;
            continue;
        }

        json_object* live_output_raw = json_tokener_parse(inv.output.get());
        if (!live_output_raw) {
            std::printf("   ❌ Entry returned invalid JSON on re-invoke\n");
            failed++;
            continue;
        }
        JsonPtr live_output(live_output_raw);

        std::string live_fp = compute_fingerprint(golden_input.get(), live_output.get());

        bool is_match = (live_fp == parsed.hash);

        // ─── Issue #315: multi-input contract check ──────────────────────────
        //
        // When the .regret file has an INPUTS line (parsed.golden_inputs_json),
        // validate EVERY stored input's hash against the live re-run — not just
        // the first. A breaking change that only affects inputs[1+] would
        // otherwise be invisible (false GREEN).
        //
        // For each golden input in INPUTS[], find the matching manifest input
        // (matched by VALUE via stable_stringify) and compute its live hash.
        // If any golden input's live hash differs from its stored hash, FAIL
        // the cluster — even when the first input still matches.
        //
        // Backward compatibility: if no INPUTS line is present (old .regret
        // files or single-input captures), this check is skipped entirely.
        // The top-level hash check above is the only check.
        std::vector<std::string> multi_input_failures;  // human-readable strings
        if (!parsed.inputs_json.empty()) {
            auto golden_inputs = parse_golden_inputs(parsed.inputs_json);
            if (!golden_inputs.empty()) {
                // Get manifest inputs (for matching by value).
                struct json_object* manifest_inputs = nullptr;
                json_object_object_get_ex(ci.cluster_obj.get(), "inputs", &manifest_inputs);

                for (const auto& gi : golden_inputs) {
                    // Parse the golden input to a json_object for stable_stringify comparison.
                    json_object* gi_obj = json_tokener_parse(gi.input_json.c_str());
                    if (!gi_obj) continue;
                    JsonPtr gi_ptr(gi_obj);

                    // Find matching manifest input by VALUE (stable_stringify equality).
                    json_object* matched_raw = nullptr;
                    if (manifest_inputs && json_object_is_type(manifest_inputs, json_type_array)) {
                        size_t m_n = json_object_array_length(manifest_inputs);
                        for (size_t i = 0; i < m_n; i++) {
                            json_object* mi = json_object_array_get_idx(manifest_inputs, i);
                            if (!mi) continue;
                            // Compare via stable_stringify for key-order-independent equality.
                            if (stable_stringify(mi) == stable_stringify(gi_ptr.get())) {
                                matched_raw = mi;
                                break;
                            }
                        }
                    }

                    if (!matched_raw) {
                        // Golden input is no longer in the manifest — skip with note.
                        std::printf("   ⏭️  input %s no longer in manifest — skipping (re-capture to refresh)\n",
                                    gi.input_json.c_str());
                        continue;
                    }

                    json_object_get(matched_raw);
                    JsonPtr matched(matched_raw);

                    std::string match_str = json_object_to_json_string_ext(
                        matched.get(), JSON_C_TO_STRING_PLAIN);

                    InvokeResult mi_inv = invoke_adapter(fn, match_str);
                    if (mi_inv.threw || !mi_inv.output) {
                        // Adapter threw on this input — treat as failure (regression).
                        std::string err = "input " + gi.input_json + " threw on re-invoke";
                        multi_input_failures.push_back(err);
                        continue;
                    }

                    json_object* mi_out_raw = json_tokener_parse(mi_inv.output.get());
                    if (!mi_out_raw) {
                        std::string err = "input " + gi.input_json + " returned invalid JSON";
                        multi_input_failures.push_back(err);
                        continue;
                    }
                    JsonPtr mi_out(mi_out_raw);

                    std::string mi_fp = compute_fingerprint(matched.get(), mi_out.get());
                    if (mi_fp != gi.hash) {
                        char buf[512];
                        std::snprintf(buf, sizeof(buf),
                                      "input %s  golden=%s  live=%s",
                                      gi.input_json.c_str(), gi.hash.c_str(), mi_fp.c_str());
                        multi_input_failures.push_back(std::string(buf));
                    }
                }
            }
            if (!multi_input_failures.empty()) {
                is_match = false;
            }
        }

        if (is_match) {
            std::printf("   ✅ PASS  (hash %s)\n", live_fp.c_str());
            passed++;
        } else {
            std::printf("   ❌ FAIL  golden=%s  live=%s\n",
                        parsed.hash.c_str(), live_fp.c_str());
            std::printf("   Golden output: %s\n", parsed.output_json.c_str());
            const char* live_out_str = json_object_to_json_string_ext(
                live_output.get(), JSON_C_TO_STRING_PLAIN);
            std::printf("   Live   output: %s\n", live_out_str);
            // Report multi-input failures (Issue #315).
            for (const auto& err : multi_input_failures) {
                std::printf("   ⚠️  multi-input mismatch: %s\n", err.c_str());
            }
            failed++;
        }
    }

    std::printf("\n────────────────────────────────────────\n");
    std::printf("Passed: %d  Failed: %d  Missing: %d\n", passed, failed, missing);
    return (failed > 0 || missing > 0) ? 1 : 0;
}

// ─── Update (parity with JS/Bash/Perl/Python validate --update) ──────────
//
// `regret_runner update --cluster <id> --reason "..." [--manifest <path>]`
// re-runs the cluster's entry to compute the NEW hash + output, rewrites
// the .regret file with the new fingerprint/OUTPUT/HASH/INPUTS, and appends
// an audit.log entry with a chain hash (sha256(prevChain + entry)[:7]).
//
// Parity requirements (mirroring scripts/validate.js updateRegret):
//   - --reason is REQUIRED (≥4 words; reject vague reasons like "fix bug").
//   - input[0] hash refreshes top-level INPUT/OUTPUT/HASH.
//   - inputs[1+] hashes refresh the INPUTS line atomically.
//   - audit.log entry: timestamp, cluster, old, new, reason, by,
//     gitAuthor (best-effort), gitSha (best-effort), ciRunId (best-effort),
//     chain (7-hex-char sha256 prefix).

// Read the LAST chain hash from audit.log (or "0000000" if missing/new).
static std::string read_last_chain(const std::string& audit_path) {
    std::string content = read_file(audit_path);
    if (content.empty()) return "0000000";
    // Walk backwards line-by-line looking for "  chain: <7-hex>".
    size_t pos = content.size();
    while (pos > 0) {
        size_t line_start = content.rfind('\n', pos - 1);
        if (line_start == std::string::npos) line_start = 0;
        else line_start += 1;
        std::string line = content.substr(line_start, pos - line_start);
        // Match "  chain: <hex>"
        size_t cpos = line.find("chain:");
        if (cpos != std::string::npos) {
            size_t vstart = cpos + 6;
            while (vstart < line.size() && std::isspace(static_cast<unsigned char>(line[vstart]))) vstart++;
            std::string chain_val = line.substr(vstart);
            // Trim trailing whitespace
            while (!chain_val.empty() && std::isspace(static_cast<unsigned char>(chain_val.back()))) chain_val.pop_back();
            if (!chain_val.empty()) return chain_val;
        }
        if (line_start == 0) break;
        pos = line_start - 1;
    }
    return "0000000";
}

// Best-effort: run a shell command and capture stdout (trim trailing whitespace).
static std::string try_exec(const std::string& cmd) {
    FILE* p = popen(cmd.c_str(), "r");
    if (!p) return "";
    std::string out;
    char buf[256];
    while (std::fgets(buf, sizeof(buf), p)) out += buf;
    pclose(p);
    // Trim trailing whitespace
    while (!out.empty() && std::isspace(static_cast<unsigned char>(out.back()))) out.pop_back();
    return out;
}

static int word_count_simple(const std::string& s) {
    int n = 0;
    bool in_word = false;
    for (char c : s) {
        if (std::isspace(static_cast<unsigned char>(c))) {
            if (in_word) { n++; in_word = false; }
        } else {
            in_word = true;
        }
    }
    if (in_word) n++;
    return n;
}

static int run_update(const std::string& manifest_path,
                      const std::string& cluster_filter,
                      const std::string& reason) {
    if (cluster_filter.empty()) {
        std::fprintf(stderr, "❌ update mode requires --cluster <id>\n");
        std::fprintf(stderr, "   Example: regret_runner update --cluster reverse --reason \"...\"\n");
        return 2;
    }
    if (reason.empty()) {
        std::fprintf(stderr, "❌ --update requires --reason\n");
        std::fprintf(stderr, "   Example: --update reverse --reason \"describe why behavior changed\"\n");
        return 2;
    }
    if (word_count_simple(reason) < 4) {
        std::fprintf(stderr, "❌ --reason is too vague: \"%s\"\n", reason.c_str());
        std::fprintf(stderr, "   Be specific. e.g. \"tax rate updated from 11%% to 12%% per new regulation\"\n");
        return 2;
    }

    auto clusters = read_clusters(manifest_path, cluster_filter);
    if (clusters.empty()) {
        std::printf("No C++ cluster matching filter: %s\n", cluster_filter.c_str());
        return 1;
    }
    if (clusters.size() > 1) {
        std::printf("⚠️  Multiple clusters matched filter; only updating the first: %s\n",
                    clusters[0].id.c_str());
    }

    auto& ci = clusters[0];
    std::printf("\n🔄 Update mode — cluster: %s\n", ci.id.c_str());
    std::printf("   Reason: %s\n", reason.c_str());

    std::string regret_dir = dirname_of(manifest_path);

    regret_entry_fn fn = reinterpret_cast<regret_entry_fn>(
        dlsym(RTLD_DEFAULT, ci.entry.c_str()));
    if (!fn) {
        std::printf("❌ Entry symbol not found: %s (%s)\n",
                    ci.entry.c_str(), dlerror());
        return 1;
    }

    // ─── Read existing .regret to extract old hash ────────────────────────
    std::string regret_path = regret_dir + "/" + ci.id + ".regret";
    std::string old_regret = read_file(regret_path);
    if (old_regret.empty()) {
        std::printf("❌ MISSING .regret file: %s\n", regret_path.c_str());
        std::printf("   Run `regret capture --cluster %s` first to establish a baseline.\n",
                    ci.id.c_str());
        return 1;
    }
    ParsedRegret parsed_old;
    if (!parse_regret(old_regret, parsed_old)) {
        std::printf("❌ Failed to parse existing .regret file\n");
        return 1;
    }
    std::string old_hash = parsed_old.hash;

    // ─── Re-run input[0] for the new top-level hash/output ────────────────
    struct json_object* inputs = nullptr;
    json_object_object_get_ex(ci.cluster_obj.get(), "inputs", &inputs);

    json_object* input0_raw = nullptr;
    if (inputs && json_object_is_type(inputs, json_type_array) &&
        json_object_array_length(inputs) > 0) {
        input0_raw = json_object_array_get_idx(inputs, 0);
        json_object_get(input0_raw);
    } else {
        input0_raw = json_object_new_null();
    }
    JsonPtr input0(input0_raw);

    std::string input0_str = json_object_to_json_string_ext(
        input0.get(), JSON_C_TO_STRING_PLAIN);

    InvokeResult inv0 = invoke_adapter(fn, input0_str);
    if (inv0.threw) {
        std::printf("❌ Adapter threw C++ exception on re-invoke: %s\n",
                    inv0.error_msg.c_str());
        return 1;
    }
    if (!inv0.output) {
        std::printf("❌ Entry returned NULL on re-invoke\n");
        return 1;
    }

    json_object* out0_raw = json_tokener_parse(inv0.output.get());
    if (!out0_raw) {
        std::printf("❌ Entry returned invalid JSON on re-invoke\n");
        return 1;
    }
    JsonPtr out0(out0_raw);

    std::string new_fp = compute_fingerprint(input0.get(), out0.get());
    if (new_fp.empty()) {
        std::printf("❌ Fingerprint computation failed\n");
        return 1;
    }

    // ─── Re-run inputs[1+] to rebuild INPUTS line ─────────────────────────
    // (Mirrors capture's multi-input INPUTS contract; only when inputs > 1.)
    std::string new_inputs_line;
    if (inputs && json_object_is_type(inputs, json_type_array) &&
        json_object_array_length(inputs) > 1) {
        json_object* inputs_arr_raw = json_object_new_array();
        JsonPtr inputs_arr(inputs_arr_raw);

        size_t n_inputs = json_object_array_length(inputs);
        for (size_t i = 1; i < n_inputs; i++) {
            json_object* cur_raw = json_object_array_get_idx(inputs, i);
            json_object_get(cur_raw);
            JsonPtr cur(cur_raw);

            std::string cur_str = json_object_to_json_string_ext(
                cur.get(), JSON_C_TO_STRING_PLAIN);

            InvokeResult cur_inv = invoke_adapter(fn, cur_str);
            if (cur_inv.threw || !cur_inv.output) continue;

            json_object* cur_out_raw = json_tokener_parse(cur_inv.output.get());
            if (!cur_out_raw) continue;
            JsonPtr cur_out(cur_out_raw);
            if (json_object_is_type(cur_out.get(), json_type_null)) continue;

            std::string cur_fp = compute_fingerprint(cur.get(), cur_out.get());
            if (cur_fp.empty()) continue;

            json_object* entry = json_object_new_object();
            json_object_object_add(entry, "input", json_object_get(cur.get()));
            json_object_object_add(entry, "output", json_object_get(cur_out.get()));
            json_object_object_add(entry, "hash", json_object_new_string(cur_fp.c_str()));
            json_object_array_add(inputs_arr.get(), entry);
        }

        if (json_object_array_length(inputs_arr.get()) > 0) {
            const char* arr_str = json_object_to_json_string_ext(
                inputs_arr.get(), JSON_C_TO_STRING_PLAIN);
            new_inputs_line = std::string(arr_str);
        }
    }

    // ─── Write new .regret content ───────────────────────────────────────
    // Strategy: rebuild the file using build_regret_content() (same path as
    // capture), so the meta block (cluster/version/fingerprint/captured/
    // watches/entry/stack/fingerprintLevel) is refreshed alongside the data
    // block. This matches the JS updateRegret behavior which writes new
    // fingerprint + captured + OUTPUT + HASH + INPUTS.
    std::string new_regret = build_regret_content(
        ci.cluster_obj.get(), ci.id, ci.entry, new_fp,
        input0.get(), out0.get(), new_inputs_line);

    FILE* rf = std::fopen(regret_path.c_str(), "wb");
    if (!rf) {
        std::printf("❌ Cannot write %s: %s\n", regret_path.c_str(), std::strerror(errno));
        return 1;
    }
    std::fputs(new_regret.c_str(), rf);
    std::fclose(rf);

    std::printf("   ✅ Updated: %s\n", regret_path.c_str());
    std::printf("   old: %s\n", old_hash.c_str());
    std::printf("   new: %s\n", new_fp.c_str());

    // ─── Append audit.log entry with chain hash ──────────────────────────
    // Format mirrors scripts/validate.js updateRegret's audit entry:
    //   <ISO timestamp>  UPDATE  <clusterId>
    //     old: <oldHash>
    //     new: <newHash>
    //     reason: <safeReason>
    //     by: AI refactor session
    //     gitAuthor: <name> <<email>>   (optional, best-effort)
    //     gitSha: <short-sha>           (optional, best-effort)
    //     ciRunId: <run-id>             (optional, best-effort)
    //     chain: <7-hex-sha256-prefix>
    //
    // The chain hash is sha256(prevChain + entryContent) where entryContent
    // is the lines joined with '\n' (excluding the chain line itself).
    std::string audit_path = regret_dir + "/audit.log";
    std::string prev_chain = read_last_chain(audit_path);

    // Sanitize reason: replace newlines with spaces (audit.log integrity).
    std::string safe_reason;
    safe_reason.reserve(reason.size());
    for (char c : reason) {
        if (c == '\n' || c == '\r') safe_reason += ' ';
        else safe_reason += c;
    }

    std::string now = iso_now();

    // Best-effort git provenance.
    std::string git_author;
    {
        std::string name = try_exec("git config user.name 2>/dev/null");
        std::string email = try_exec("git config user.email 2>/dev/null");
        if (!name.empty()) {
            git_author = email.empty() ? name : (name + " <" + email + ">");
        }
    }
    std::string git_sha = try_exec("git rev-parse --short HEAD 2>/dev/null");
    const char* ci_run_id = std::getenv("GITHUB_RUN_ID");
    if (!ci_run_id) ci_run_id = std::getenv("CI_RUN_ID");

    // Build entry content (without chain line) for hash computation.
    std::vector<std::string> entry_lines;
    entry_lines.push_back(now + "  UPDATE  " + ci.id);
    entry_lines.push_back("  old: " + old_hash);
    entry_lines.push_back("  new: " + new_fp);
    entry_lines.push_back("  reason: " + safe_reason);
    entry_lines.push_back("  by: AI refactor session");
    if (!git_author.empty()) entry_lines.push_back("  gitAuthor: " + git_author);
    if (!git_sha.empty())    entry_lines.push_back("  gitSha: " + git_sha);
    if (ci_run_id)           entry_lines.push_back("  ciRunId: " + std::string(ci_run_id));

    std::string entry_content;
    for (size_t i = 0; i < entry_lines.size(); i++) {
        if (i > 0) entry_content += "\n";
        entry_content += entry_lines[i];
    }

    // sha256(prevChain + entryContent) → first 7 hex chars.
    // Mirrors JS validate.js: createHash('sha256').update(prevChain + entryContent).digest('hex').slice(0, 7)
    std::string chain_input = prev_chain + entry_content;
    unsigned char chain_hash_raw[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(chain_input.data()),
           chain_input.size(), chain_hash_raw);
    char chain_hex_full[2 * SHA256_DIGEST_LENGTH + 1];
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) {
        std::snprintf(chain_hex_full + 2 * i, 4, "%02x", chain_hash_raw[i]);
    }
    chain_hex_full[2 * SHA256_DIGEST_LENGTH] = '\0';
    std::string chain_hash(chain_hex_full, 7);

    // Append entry to audit.log.
    FILE* af = std::fopen(audit_path.c_str(), "ab");
    if (!af) {
        std::printf("⚠️  Cannot append to audit.log: %s\n", std::strerror(errno));
        // Still consider the update successful — the .regret file was updated.
        return 0;
    }
    std::fprintf(af, "\n%s\n  chain: %s", entry_content.c_str(), chain_hash.c_str());
    std::fclose(af);

    std::printf("   Audit: %s\n", audit_path.c_str());
    std::printf("   Chain: %s (prev %s)\n", chain_hash.c_str(), prev_chain.c_str());

    return 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr,
            "Usage: %s <capture|validate|update> [--cluster <id>] [--manifest <path>] [--reason \"...\"]\n",
            argv[0]);
        return 2;
    }

    std::string mode = argv[1];
    std::string cluster_filter;
    std::string manifest_path;
    std::string reason;

    char cwd[1024];
    if (!getcwd(cwd, sizeof(cwd))) die("getcwd failed");
    std::string default_manifest = std::string(cwd) + "/regrets/manifest.json";

    for (int i = 2; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--cluster" && i + 1 < argc) {
            cluster_filter = argv[++i];
        } else if (arg == "--manifest" && i + 1 < argc) {
            manifest_path = argv[++i];
        } else if (arg == "--reason" && i + 1 < argc) {
            reason = argv[++i];
        }
    }
    if (manifest_path.empty()) manifest_path = default_manifest;

    if (mode == "capture")  return run_capture(manifest_path, cluster_filter);
    if (mode == "validate") return run_validate(manifest_path, cluster_filter);
    if (mode == "update")   return run_update(manifest_path, cluster_filter, reason);

    std::fprintf(stderr, "Unknown mode: %s\n", mode.c_str());
    return 2;
}
