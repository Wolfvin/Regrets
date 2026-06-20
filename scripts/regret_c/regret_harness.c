// regret_harness.c — capture + validate regret contracts for C clusters.
//
// Single-file harness. Compile with:
//
//     gcc -o regret_runner regret_harness.c <user_sources.c...>
//         -lcrypto -ljson-c -ldl -rdynamic
//
// Run:
//     ./regret_runner capture  [--cluster <id>] [--manifest <path>]
//     ./regret_runner validate [--cluster <id>] [--manifest <path>]
//
// Reads `regrets/manifest.json`, filters clusters with `stack: "c"`,
// invokes each cluster's `entry` symbol via dlsym(RTLD_DEFAULT, ...)
// with the cluster's INPUT (JSON string), receives the OUTPUT
// (JSON string), and computes the 7-char base36 fingerprint identical
// to fingerprint.js / fingerprint.py / RegretJava.java.
//
// In capture mode, writes `<id>.regret` files in the standard format.
// In validate mode, re-invokes the entry, recomputes the hash, and
// compares against the golden HASH from the existing `.regret` file.
//
// Exit code: 0 = all clusters PASS, 1 = at least one FAIL or error.

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <errno.h>
#include <ctype.h>
#include <unistd.h>
#include <dlfcn.h>
#include <openssl/sha.h>
#include <openssl/bn.h>
#include <json-c/json.h>

#include "regret.h"

// ─── Helpers ──────────────────────────────────────────────────────────────

static void die(const char* msg) {
    fprintf(stderr, "❌ %s\n", msg);
    exit(2);
}

static char* read_file(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char* buf = malloc(sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t n = fread(buf, 1, sz, f);
    fclose(f);
    buf[n] = '\0';
    return buf;
}

static char* iso_now(void) {
    time_t t = time(NULL);
    struct tm tm_local;
    localtime_r(&t, &tm_local);
    long offset_secs = tm_local.tm_gmtoff;
    char sign = offset_secs >= 0 ? '+' : '-';
    long offset_mins = labs(offset_secs) / 60;
    int oh = (int)(offset_mins / 60);
    int om = (int)(offset_mins % 60);
    char* buf = malloc(64);
    snprintf(buf, 64, "%04d-%02d-%02dT%02d:%02d:%02d.000000%c%02d:%02d",
             tm_local.tm_year + 1900, tm_local.tm_mon + 1, tm_local.tm_mday,
             tm_local.tm_hour, tm_local.tm_min, tm_local.tm_sec,
             sign, oh, om);
    return buf;
}

// ─── Stable stringify (byte-identical to fingerprint.js) ──────────────────

static void stable_write(json_object* obj, FILE* out);
static void stable_write_string(const char* s, FILE* out);

static int cmp_strptr(const void* a, const void* b) {
    const char* sa = *(const char* const*)a;
    const char* sb = *(const char* const*)b;
    return strcmp(sa, sb);
}

static void stable_write_string(const char* s, FILE* out) {
    fputc('"', out);
    for (const unsigned char* p = (const unsigned char*)s; *p; p++) {
        unsigned char c = *p;
        switch (c) {
            case '"':  fputs("\\\"", out); break;
            case '\\': fputs("\\\\", out); break;
            case '\b': fputs("\\b", out); break;
            case '\f': fputs("\\f", out); break;
            case '\n': fputs("\\n", out); break;
            case '\r': fputs("\\r", out); break;
            case '\t': fputs("\\t", out); break;
            default:
                if (c < 0x20) {
                    fprintf(out, "\\u%04x", c);
                } else {
                    fputc(c, out);
                }
        }
    }
    fputc('"', out);
}

static void stable_write(json_object* obj, FILE* out) {
    if (obj == NULL) { fputs("null", out); return; }

    enum json_type type = json_object_get_type(obj);
    switch (type) {
        case json_type_null:
            fputs("null", out);
            break;
        case json_type_boolean:
            fputs(json_object_get_boolean(obj) ? "true" : "false", out);
            break;
        case json_type_int: {
            int64_t v = json_object_get_int64(obj);
            fprintf(out, "%lld", (long long)v);
            break;
        }
        case json_type_double: {
            double d = json_object_get_double(obj);
            if (isnan(d)) { fputs("\"__nan__\"", out); break; }
            if (isinf(d)) { fputs(d > 0 ? "\"__infinity__\"" : "\"__neg_infinity__\"", out); break; }
            // Match JS Number.toString(): whole numbers without trailing .0
            if (d == floor(d) && fabs(d) < 1e21) {
                fprintf(out, "%lld", (long long)d);
            } else {
                char buf[64];
                snprintf(buf, sizeof(buf), "%.17g", d);
                fputs(buf, out);
            }
            break;
        }
        case json_type_string:
            stable_write_string(json_object_get_string(obj), out);
            break;
        case json_type_array: {
            int n = json_object_array_length(obj);
            fputc('[', out);
            for (int i = 0; i < n; i++) {
                if (i > 0) fputc(',', out);
                stable_write(json_object_array_get_idx(obj, i), out);
            }
            fputc(']', out);
            break;
        }
        case json_type_object: {
            // Collect keys, sort lexicographically, write in order.
            struct json_object_iterator it = json_object_iter_begin(obj);
            struct json_object_iterator itEnd = json_object_iter_end(obj);
            int count = 0;
            int cap = 16;
            char** keys = malloc(cap * sizeof(char*));
            while (!json_object_iter_equal(&it, &itEnd)) {
                const char* k = json_object_iter_peek_name(&it);
                if (count >= cap) { cap *= 2; keys = realloc(keys, cap * sizeof(char*)); }
                keys[count++] = strdup(k);
                json_object_iter_next(&it);
            }
            qsort(keys, count, sizeof(char*), cmp_strptr);

            fputc('{', out);
            for (int i = 0; i < count; i++) {
                if (i > 0) fputc(',', out);
                stable_write_string(keys[i], out);
                fputc(':', out);
                struct json_object* val = NULL;
                json_object_object_get_ex(obj, keys[i], &val);
                stable_write(val, out);
            }
            fputc('}', out);

            for (int i = 0; i < count; i++) free(keys[i]);
            free(keys);
            break;
        }
    }
}

// Returns malloc'd stable-stringified JSON. Caller frees.
static char* stable_stringify(json_object* obj) {
    char* buf = NULL;
    size_t len = 0;
    FILE* mem = open_memstream(&buf, &len);
    if (!mem) return NULL;
    stable_write(obj, mem);
    fclose(mem);
    return buf;  // open_memstream already malloc'd buf and NUL-terminated it
}

// ─── Fingerprint — MUST be byte-identical to fingerprint.js ───────────────

static char* compute_fingerprint(json_object* input, json_object* output) {
    char* s_input = stable_stringify(input);
    char* s_output = stable_stringify(output);
    if (!s_input || !s_output) { free(s_input); free(s_output); return NULL; }

    size_t combined_len = strlen(s_input) + 1 + strlen(s_output);
    char* combined = malloc(combined_len + 1);
    snprintf(combined, combined_len + 1, "%s|%s", s_input, s_output);
    free(s_input); free(s_output);

    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256((const unsigned char*)combined, strlen(combined), hash);
    free(combined);

    // Hex string
    char hex[2 * SHA256_DIGEST_LENGTH + 1];
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) {
        snprintf(hex + 2 * i, 4, "%02x", hash[i]);
    }
    hex[2 * SHA256_DIGEST_LENGTH] = '\0';

    // Hex → BIGNUM → base36
    BIGNUM* bn = NULL;
    if (!BN_hex2bn(&bn, hex)) return NULL;

    // Convert to base36 by repeated divmod
    // Result is built in reverse then reversed.
    char tmp[80];
    int pos = 0;
    if (BN_is_zero(bn)) {
        tmp[pos++] = '0';
    } else {
        BN_ULONG base = 36;
        while (!BN_is_zero(bn)) {
            BN_ULONG rem = BN_div_word(bn, base);
            char c = (rem < 10) ? ('0' + (char)rem) : ('a' + (char)(rem - 10));
            tmp[pos++] = c;
        }
    }
    BN_free(bn);

    // Reverse
    for (int i = 0, j = pos - 1; i < j; i++, j--) {
        char t = tmp[i]; tmp[i] = tmp[j]; tmp[j] = t;
    }

    // Pad with leading zeros to at least 7 chars
    char* result = malloc(8);
    if (pos < 7) {
        int pad = 7 - pos;
        memset(result, '0', pad);
        memcpy(result + pad, tmp, pos);
        result[7] = '\0';
    } else {
        memcpy(result, tmp, 7);
        result[7] = '\0';
    }
    return result;
}

// ─── .regret file build & parse ───────────────────────────────────────────

static char* build_regret_content(json_object* cluster, const char* id,
                                  const char* entry_symbol, const char* fp,
                                  json_object* input, json_object* output) {
    char* buf = NULL;
    size_t len = 0;
    FILE* mem = open_memstream(&buf, &len);
    if (!mem) return NULL;

    char* ts = iso_now();
    fprintf(mem, "cluster: %s\n", id);
    fputs("version: 1\n", mem);
    fprintf(mem, "fingerprint: %s\n", fp);
    fprintf(mem, "captured: %s\n", ts);
    free(ts);

    // watches
    struct json_object* watches = NULL;
    if (json_object_object_get_ex(cluster, "watches", &watches) &&
        json_object_is_type(watches, json_type_array)) {
        fputs("watches: [", mem);
        int n = json_object_array_length(watches);
        for (int i = 0; i < n; i++) {
            if (i > 0) fputs(", ", mem);
            struct json_object* w = json_object_array_get_idx(watches, i);
            fputs(json_object_get_string(w), mem);
        }
        fputs("]\n", mem);
    } else {
        fprintf(mem, "watches: [%s]\n", entry_symbol);
    }

    const char* level = "entry";
    struct json_object* lvl = NULL;
    if (json_object_object_get_ex(cluster, "fingerprintLevel", &lvl)) {
        level = json_object_get_string(lvl);
    }

    const char* stack = "c";
    struct json_object* stk = NULL;
    if (json_object_object_get_ex(cluster, "stack", &stk)) {
        stack = json_object_get_string(stk);
    }

    fprintf(mem, "entry: %s\n", entry_symbol);
    fprintf(mem, "stack: %s\n", stack);
    fprintf(mem, "fingerprintLevel: %s\n", level);
    fputs("---\n", mem);

    const char* input_str = json_object_to_json_string_ext(input, JSON_C_TO_STRING_PLAIN);
    const char* output_str = json_object_to_json_string_ext(output, JSON_C_TO_STRING_PLAIN);
    fprintf(mem, "INPUT  %s\n", input_str);
    fprintf(mem, "OUTPUT %s\n", output_str);
    fprintf(mem, "HASH   %s\n", fp);

    fclose(mem);
    return buf;
}

typedef struct {
    char input_json[16384];
    char output_json[16384];
    char hash[64];
} parsed_regret_t;

static int parse_regret(const char* content, parsed_regret_t* out) {
    memset(out, 0, sizeof(*out));
    const char* p = content;
    while (*p) {
        const char* eol = strchr(p, '\n');
        if (!eol) eol = p + strlen(p);
        size_t line_len = eol - p;

        if (line_len == 3 && strncmp(p, "---", 3) == 0) {
            p = (*eol) ? eol + 1 : eol;
            continue;
        }

        // Find first whitespace (key/value separator)
        const char* sep = NULL;
        for (size_t i = 0; i < line_len; i++) {
            if (p[i] == ' ' || p[i] == '\t') { sep = p + i; break; }
        }
        if (!sep) { p = (*eol) ? eol + 1 : eol; continue; }

        size_t key_len = sep - p;
        const char* val_start = sep;
        while (val_start < eol && (*val_start == ' ' || *val_start == '\t')) val_start++;
        size_t val_len = eol - val_start;

        if (key_len == 5 && strncmp(p, "INPUT", 5) == 0) {
            if (val_len < sizeof(out->input_json)) {
                memcpy(out->input_json, val_start, val_len);
                out->input_json[val_len] = '\0';
            }
        } else if (key_len == 6 && strncmp(p, "OUTPUT", 6) == 0) {
            if (val_len < sizeof(out->output_json)) {
                memcpy(out->output_json, val_start, val_len);
                out->output_json[val_len] = '\0';
            }
        } else if (key_len == 4 && strncmp(p, "HASH", 4) == 0) {
            if (val_len < sizeof(out->hash)) {
                memcpy(out->hash, val_start, val_len);
                out->hash[val_len] = '\0';
            }
        }
        p = (*eol) ? eol + 1 : eol;
    }
    return (out->hash[0] && out->input_json[0]) ? 0 : -1;
}

// ─── Manifest reading ─────────────────────────────────────────────────────

typedef struct {
    char id[256];
    char entry[256];
    json_object* cluster_obj;  // owned reference
} cluster_info_t;

static int read_clusters(const char* manifest_path, const char* cluster_filter,
                        cluster_info_t** out_clusters, size_t* out_count) {
    char* content = read_file(manifest_path);
    if (!content) return -1;

    json_object* root = json_tokener_parse(content);
    free(content);
    if (!root) return -1;

    json_object* clusters = NULL;
    if (!json_object_object_get_ex(root, "clusters", &clusters) ||
        !json_object_is_type(clusters, json_type_array)) {
        json_object_put(root);
        return -1;
    }

    size_t n = json_object_array_length(clusters);
    cluster_info_t* result = calloc(n, sizeof(cluster_info_t));
    size_t count = 0;
    for (size_t i = 0; i < n; i++) {
        json_object* c = json_object_array_get_idx(clusters, i);
        struct json_object* stack_obj = NULL;
        if (!json_object_object_get_ex(c, "stack", &stack_obj)) continue;
        const char* stack = json_object_get_string(stack_obj);
        if (strcmp(stack, "c") != 0) continue;

        struct json_object* id_obj = NULL;
        if (!json_object_object_get_ex(c, "id", &id_obj)) continue;
        const char* id = json_object_get_string(id_obj);

        if (cluster_filter && strcmp(id, cluster_filter) != 0) continue;

        struct json_object* entry_obj = NULL;
        const char* entry = "regret_entry";
        if (json_object_object_get_ex(c, "entry", &entry_obj)) {
            entry = json_object_get_string(entry_obj);
        }

        strncpy(result[count].id, id, sizeof(result[count].id) - 1);
        strncpy(result[count].entry, entry, sizeof(result[count].entry) - 1);
        result[count].cluster_obj = c;
        json_object_get(c);  // take ownership
        count++;
    }
    json_object_put(root);
    *out_clusters = result;
    *out_count = count;
    return 0;
}

// ─── Capture ──────────────────────────────────────────────────────────────

static int run_capture(const char* manifest_path, const char* cluster_filter) {
    cluster_info_t* clusters = NULL;
    size_t count = 0;
    if (read_clusters(manifest_path, cluster_filter, &clusters, &count) != 0) {
        die("failed to read manifest");
    }
    if (count == 0) {
        printf("No C clusters found in manifest.\n");
        free(clusters);
        return 0;
    }

    // regrets/ dir = dirname(manifest_path)
    char regret_dir[1024];
    strncpy(regret_dir, manifest_path, sizeof(regret_dir) - 1);
    regret_dir[sizeof(regret_dir) - 1] = '\0';
    char* slash = strrchr(regret_dir, '/');
    if (slash) *slash = '\0';

    int captured = 0, skipped = 0, failed = 0;
    for (size_t i = 0; i < count; i++) {
        cluster_info_t* ci = &clusters[i];
        printf("\n📡 Capturing C cluster: %s\n", ci->id);

        regret_entry_fn fn = (regret_entry_fn)dlsym(RTLD_DEFAULT, ci->entry);
        if (!fn) {
            printf("   ❌ Entry symbol not found: %s (%s)\n", ci->entry, dlerror());
            failed++;
            continue;
        }

        // Get first input from inputs[]
        struct json_object* inputs = NULL;
        json_object_object_get_ex(ci->cluster_obj, "inputs", &inputs);
        json_object* input = NULL;
        if (inputs && json_object_is_type(inputs, json_type_array) &&
            json_object_array_length(inputs) > 0) {
            input = json_object_array_get_idx(inputs, 0);
            json_object_get(input);  // own a reference
        } else {
            input = json_object_new_null();
        }

        const char* input_str = json_object_to_json_string_ext(input, JSON_C_TO_STRING_PLAIN);
        char* output_str = fn(input_str);

        if (output_str == NULL) {
            printf("   ⏭️  Skipped: entry returned NULL (trivial-input guard)\n");
            json_object_put(input);
            skipped++;
            continue;
        }

        json_object* output = json_tokener_parse(output_str);
        free(output_str);
        if (!output) {
            printf("   ❌ Entry returned invalid JSON output\n");
            json_object_put(input);
            failed++;
            continue;
        }
        if (json_object_is_type(output, json_type_null)) {
            printf("   ⏭️  Skipped: output is null (trivial-input guard)\n");
            json_object_put(input);
            json_object_put(output);
            skipped++;
            continue;
        }

        char* fp = compute_fingerprint(input, output);
        if (!fp) {
            printf("   ❌ Fingerprint computation failed\n");
            json_object_put(input);
            json_object_put(output);
            failed++;
            continue;
        }

        char* regret_content = build_regret_content(ci->cluster_obj, ci->id,
                                                    ci->entry, fp, input, output);
        if (!regret_content) {
            printf("   ❌ Failed to build .regret content\n");
            free(fp);
            json_object_put(input);
            json_object_put(output);
            failed++;
            continue;
        }

        char regret_path[1536];
        snprintf(regret_path, sizeof(regret_path), "%s/%s.regret", regret_dir, ci->id);
        FILE* rf = fopen(regret_path, "wb");
        if (!rf) {
            printf("   ❌ Cannot write %s: %s\n", regret_path, strerror(errno));
            free(regret_content);
            free(fp);
            json_object_put(input);
            json_object_put(output);
            failed++;
            continue;
        }
        fputs(regret_content, rf);
        fclose(rf);

        printf("   ✅ Fingerprint: %s\n", fp);
        printf("   📄 Saved: %s\n", regret_path);

        free(regret_content);
        free(fp);
        json_object_put(input);
        json_object_put(output);
        captured++;
    }

    printf("\n────────────────────────────────────────\n");
    printf("Captured: %d  Skipped: %d  Failed: %d\n", captured, skipped, failed);

    for (size_t i = 0; i < count; i++) json_object_put(clusters[i].cluster_obj);
    free(clusters);

    return (failed > 0) ? 1 : 0;
}

// ─── Validate ─────────────────────────────────────────────────────────────

static int run_validate(const char* manifest_path, const char* cluster_filter) {
    cluster_info_t* clusters = NULL;
    size_t count = 0;
    if (read_clusters(manifest_path, cluster_filter, &clusters, &count) != 0) {
        die("failed to read manifest");
    }
    if (count == 0) {
        printf("No C clusters found in manifest.\n");
        free(clusters);
        return 0;
    }

    char regret_dir[1024];
    strncpy(regret_dir, manifest_path, sizeof(regret_dir) - 1);
    regret_dir[sizeof(regret_dir) - 1] = '\0';
    char* slash = strrchr(regret_dir, '/');
    if (slash) *slash = '\0';

    int passed = 0, failed = 0, missing = 0;
    for (size_t i = 0; i < count; i++) {
        cluster_info_t* ci = &clusters[i];
        printf("\n🔍 Validating C cluster: %s\n", ci->id);

        regret_entry_fn fn = (regret_entry_fn)dlsym(RTLD_DEFAULT, ci->entry);
        if (!fn) {
            printf("   ❌ Entry symbol not found: %s (%s)\n", ci->entry, dlerror());
            failed++;
            continue;
        }

        char regret_path[1536];
        snprintf(regret_path, sizeof(regret_path), "%s/%s.regret", regret_dir, ci->id);
        char* regret_content = read_file(regret_path);
        if (!regret_content) {
            printf("   ❌ MISSING .regret file: %s\n", regret_path);
            missing++;
            continue;
        }

        parsed_regret_t parsed;
        if (parse_regret(regret_content, &parsed) != 0) {
            printf("   ❌ Failed to parse .regret file\n");
            free(regret_content);
            failed++;
            continue;
        }
        free(regret_content);

        json_object* golden_input = json_tokener_parse(parsed.input_json);
        if (!golden_input) {
            printf("   ❌ Cannot parse golden INPUT: %s\n", parsed.input_json);
            failed++;
            continue;
        }

        const char* input_str = json_object_to_json_string_ext(golden_input, JSON_C_TO_STRING_PLAIN);
        char* live_output_str = fn(input_str);
        if (!live_output_str) {
            printf("   ❌ Entry returned NULL on re-invoke\n");
            json_object_put(golden_input);
            failed++;
            continue;
        }
        json_object* live_output = json_tokener_parse(live_output_str);
        free(live_output_str);
        if (!live_output) {
            printf("   ❌ Entry returned invalid JSON on re-invoke\n");
            json_object_put(golden_input);
            failed++;
            continue;
        }

        char* live_fp = compute_fingerprint(golden_input, live_output);

        if (live_fp && strcmp(parsed.hash, live_fp) == 0) {
            printf("   ✅ PASS  (hash %s)\n", live_fp);
            passed++;
        } else {
            printf("   ❌ FAIL  golden=%s  live=%s\n", parsed.hash, live_fp ? live_fp : "(null)");
            printf("   Golden output: %s\n", parsed.output_json);
            const char* live_out_str = json_object_to_json_string_ext(live_output, JSON_C_TO_STRING_PLAIN);
            printf("   Live   output: %s\n", live_out_str);
            failed++;
        }

        free(live_fp);
        json_object_put(golden_input);
        json_object_put(live_output);
    }

    printf("\n────────────────────────────────────────\n");
    printf("Passed: %d  Failed: %d  Missing: %d\n", passed, failed, missing);

    for (size_t i = 0; i < count; i++) json_object_put(clusters[i].cluster_obj);
    free(clusters);

    return (failed > 0 || missing > 0) ? 1 : 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <capture|validate> [--cluster <id>] [--manifest <path>]\n", argv[0]);
        return 2;
    }

    const char* mode = argv[1];
    const char* cluster_filter = NULL;
    const char* manifest_path = NULL;

    char default_manifest[1024];
    if (getcwd(default_manifest, sizeof(default_manifest)) == NULL) die("getcwd failed");
    size_t cwd_len = strlen(default_manifest);
    snprintf(default_manifest + cwd_len, sizeof(default_manifest) - cwd_len, "/regrets/manifest.json");

    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--cluster") == 0 && i + 1 < argc) {
            cluster_filter = argv[++i];
        } else if (strcmp(argv[i], "--manifest") == 0 && i + 1 < argc) {
            manifest_path = argv[++i];
        }
    }
    if (!manifest_path) manifest_path = default_manifest;

    if (strcmp(mode, "capture") == 0) return run_capture(manifest_path, cluster_filter);
    if (strcmp(mode, "validate") == 0) return run_validate(manifest_path, cluster_filter);

    fprintf(stderr, "Unknown mode: %s\n", mode);
    return 2;
}
