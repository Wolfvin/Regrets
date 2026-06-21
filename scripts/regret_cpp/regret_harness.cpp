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
                                        json_object* input, json_object* output) {
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

    std::fclose(mem);
    std::string result(buf ? buf : "");
    if (buf) std::free(buf);
    return result;
}

struct ParsedRegret {
    std::string input_json;
    std::string output_json;
    std::string hash;
};

static bool parse_regret(const std::string& content, ParsedRegret& out) {
    size_t pos = 0;
    while (pos < content.size()) {
        size_t eol = content.find('\n', pos);
        if (eol == std::string::npos) eol = content.size();
        std::string line = content.substr(pos, eol - pos);
        pos = (eol == content.size()) ? eol : eol + 1;

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
    }
    return !out.hash.empty() && !out.input_json.empty();
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

        std::string regret_content = build_regret_content(
            ci.cluster_obj.get(), ci.id, ci.entry, fp, input.get(), output.get());

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

        if (live_fp == parsed.hash) {
            std::printf("   ✅ PASS  (hash %s)\n", live_fp.c_str());
            passed++;
        } else {
            std::printf("   ❌ FAIL  golden=%s  live=%s\n",
                        parsed.hash.c_str(), live_fp.c_str());
            std::printf("   Golden output: %s\n", parsed.output_json.c_str());
            const char* live_out_str = json_object_to_json_string_ext(
                live_output.get(), JSON_C_TO_STRING_PLAIN);
            std::printf("   Live   output: %s\n", live_out_str);
            failed++;
        }
    }

    std::printf("\n────────────────────────────────────────\n");
    std::printf("Passed: %d  Failed: %d  Missing: %d\n", passed, failed, missing);
    return (failed > 0 || missing > 0) ? 1 : 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr,
            "Usage: %s <capture|validate> [--cluster <id>] [--manifest <path>]\n",
            argv[0]);
        return 2;
    }

    std::string mode = argv[1];
    std::string cluster_filter;
    std::string manifest_path;

    char cwd[1024];
    if (!getcwd(cwd, sizeof(cwd))) die("getcwd failed");
    std::string default_manifest = std::string(cwd) + "/regrets/manifest.json";

    for (int i = 2; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--cluster" && i + 1 < argc) {
            cluster_filter = argv[++i];
        } else if (arg == "--manifest" && i + 1 < argc) {
            manifest_path = argv[++i];
        }
    }
    if (manifest_path.empty()) manifest_path = default_manifest;

    if (mode == "capture")  return run_capture(manifest_path, cluster_filter);
    if (mode == "validate") return run_validate(manifest_path, cluster_filter);

    std::fprintf(stderr, "Unknown mode: %s\n", mode.c_str());
    return 2;
}
