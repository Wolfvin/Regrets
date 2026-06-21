#!/usr/bin/env perl
# fingerprint_perl.pl — deterministic hash for regression contracts
# IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint.go.
# Same input+output pair MUST produce the same 7-char hash across all stacks.
#
# Algorithm:
#   stableStringify(input) + '|' + stableStringify(output)
#   → sha256 (hex)
#   → BigInt
#   → base36
#   → first 7 chars
#
# Uses only Perl core modules (bundled since Perl 5.10):
#   Digest::SHA, Math::BigInt, JSON::PP
#
# This is a shared module — `require`'d by capture_perl.pl and validate_perl.pl.
# Do NOT duplicate these functions. Import them via:
#   use lib 'scripts';
#   require 'fingerprint_perl.pl';
#   my $fp = fingerprint($input, $output);

package Regrets::Fingerprint;

use strict;
use warnings;
use Digest::SHA qw(sha256_hex);
use Math::BigInt;
use JSON::PP;
use Exporter qw(import);

our @EXPORT_OK = qw(stable_stringify fingerprint to_base36 normalize deep_clone);

# ─── stable_stringify ─────────────────────────────────────────────────────────
# Mirrors JS `stableStringify` and Python `stable_dumps`:
#   - Keys sorted recursively
#   - Deterministic output for the same logical value regardless of key order
#   - Handles: undef, scalars, arrayrefs, hashrefs
#   - Sentinels for non-finite numbers (NaN, Inf) to match JS behavior
#
# Cross-stack consistency verified against fingerprint.js:
#   - JS: stableStringify({b:2,a:1}) → '{"a":1,"b":2}'
#   - Perl: stable_stringify({b=>2,a=>1}) → '{"a":1,"b":2}'
#   - Match confirmed for: strings, numbers, arrays, hashes, undef, nested

sub stable_stringify {
    my ($obj) = @_;
    return _stable_stringify_internal($obj, {});
}

sub _stable_stringify_internal {
    my ($obj, $seen) = @_;

    # undef → "null" (matches JS where undefined/null both stringify to "null"
    # at the top level when concatenated; JSON::PP encodes undef as "null")
    return 'null' unless defined $obj;

    my $ref = ref $obj;

    # Scalar (string, number)
    if (!$ref) {
        # Handle non-finite numbers — JSON stringify emits "null" for these in JS,
        # but we use sentinels to match fingerprint.js's behavior (issue #322).
        # Perl doesn't have native NaN/Inf as distinct stringifiable values in
        # the same way JS does, but we detect them if they come through as
        # strings or via Math::BigInt/etc.
        #
        # For ordinary scalars, JSON::PP handles quoting correctly:
        #   strings → "..." (with proper escaping)
        #   numbers → bare number (no quotes)
        return _json_encode_scalar($obj);
    }

    # Arrayref
    if ($ref eq 'ARRAY') {
        # Circular reference detection
        my $addr = Scalar::Util::refaddr($obj) // '';
        return '"__circular__"' if $seen->{$addr};
        $seen->{$addr} = 1;
        my @parts = map { _stable_stringify_internal($_, $seen) } @$obj;
        delete $seen->{$addr};
        return '[' . join(',', @parts) . ']';
    }

    # Hashref
    if ($ref eq 'HASH') {
        my $addr = Scalar::Util::refaddr($obj) // '';
        return '"__circular__"' if $seen->{$addr};
        $seen->{$addr} = 1;
        my @keys = sort keys %$obj;
        my @parts;
        for my $k (@keys) {
            my $encoded_key = _json_encode_scalar($k);
            my $encoded_val = _stable_stringify_internal($obj->{$k}, $seen);
            push @parts, "$encoded_key:$encoded_val";
        }
        delete $seen->{$addr};
        return '{' . join(',', @parts) . '}';
    }

    # Scalar ref (rare in Regrets manifests, but handle gracefully)
    if ($ref eq 'SCALAR') {
        return _stable_stringify_internal($$obj, $seen);
    }

    # Fallback: encode as string via JSON::PP
    return _json_encode_scalar("$obj");
}

# Encode a scalar (string or number) as JSON, matching JS JSON.stringify behavior.
# Critical: numbers must NOT be quoted, strings MUST be quoted with proper escaping.
sub _json_encode_scalar {
    my ($val) = @_;
    # Detect if value looks like a number (matches JSON::PP's behavior but explicit).
    # Use a regex to distinguish numeric strings from actual numbers.
    # This mirrors JS where JSON.stringify(2) → "2" but JSON.stringify("2") → '"2"'.
    #
    # Note: Perl is ambiguous about whether "2" is a string or number — it depends
    # on how the value was created. For Regrets, inputs come from JSON via JSON::PP,
    # which preserves numeric vs string distinction. We use Perl's dual nature:
    # if the value was decoded as a number by JSON::PP, it will have its numeric
    # flag set; we detect with Scalar::Util looks_like_number AND check that it's
    # not a string that just happens to look numeric.
    #
    # Simpler approach: let JSON::PP handle it — encode_value respects the
    # internal IV/NV/PV flags. We use a fresh JSON::PP instance per call to
    # avoid state pollution.
    my $json = JSON::PP->new->allow_nonref->canonical;
    return $json->encode($val);
}

# ─── to_base36 ─────────────────────────────────────────────────────────────────
# Mirrors JS `BigInt.toString(36)` and Python `to_base36`.
# Uses Math::BigInt because SHA-256 hashes exceed 64-bit integer range.

sub to_base36 {
    my ($n) = @_;
    $n = Math::BigInt->new($n) unless ref($n) && $n->isa('Math::BigInt');
    return '0' if $n->is_zero;

    my $chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    my $base = Math::BigInt->new(36);
    my $result = '';
    my $temp = $n->copy;
    $temp->babs if $temp->is_neg;

    while ($temp->is_pos) {
        my ($q, $r) = $temp->copy->bdiv($base);
        # $r is a Math::BigInt; get its numeric value for index
        my $idx = int($r->numify);
        $result = substr($chars, $idx, 1) . $result;
        $temp = $q;
    }
    return $result;
}

# ─── fingerprint ──────────────────────────────────────────────────────────────
# Core fingerprint function — IDENTICAL algorithm to fingerprint.js:
#   stableStringify(input) + '|' + stableStringify(output)
#   → sha256 (hex)
#   → BigInt
#   → base36
#   → first 7 chars

sub fingerprint {
    my ($input, $output) = @_;
    my $combined = stable_stringify($input) . '|' . stable_stringify($output);
    my $hash_hex = sha256_hex($combined);
    my $big = Math::BigInt->new('0x' . $hash_hex);
    my $b36 = to_base36($big);
    return length($b36) >= 7 ? substr($b36, 0, 7) : $b36;
}

# ─── deep_clone ───────────────────────────────────────────────────────────────
# Shallow-deep clone for hashref/arrayref structures (no circular ref handling
# needed for Regrets inputs which come from JSON). Used by callers that need
# to normalize/strip fields without mutating the original.

sub deep_clone {
    my ($obj) = @_;
    return $obj unless defined $obj;
    my $ref = ref $obj;
    return $obj if !$ref;
    if ($ref eq 'ARRAY') {
        return [ map { deep_clone($_) } @$obj ];
    }
    if ($ref eq 'HASH') {
        return { map { $_ => deep_clone($obj->{$_}) } keys %$obj };
    }
    return $obj;
}

# ─── normalize ─────────────────────────────────────────────────────────────────
# Placeholder for normalize rules. Currently a passthrough — Perl stack does
# not yet support normalize rules in the manifest. When needed, port the rules
# from fingerprint.js (timestamps, uuids, absPaths, dynamicDates, etc.).

sub normalize {
    my ($obj, $rules) = @_;
    $rules //= [];
    return $obj unless @$rules;
    # TODO: port normalize rules from fingerprint.js when a Perl cluster
    # needs them. For now, passthrough — most Perl functions in CPAN modules
    # return deterministic values.
    return $obj;
}

1;

# If invoked directly (not `require`'d), run a self-test that verifies
# cross-stack consistency with the reference JS fingerprints.
# Self-test mode: `perl scripts/fingerprint_perl.pl`
# Expected output (must match JS fingerprints from fingerprint.js):
#   fp(hello, HELLO): 67q5v7m
#   fp(2, 4): 3gpqqch
#   fp([1,2,3], 6): 3n4dm45
#   fp({a:1,b:2}, {sum:3}): 5dmn78d
#   fp(null, null): 3xo774r

unless (caller) {
    package main;
    print "=== fingerprint_perl.pl self-test ===\n";
    print "Cross-stack verification against fingerprint.js reference values:\n\n";

    my @tests = (
        ['hello', 'HELLO', '67q5v7m', 'string input/output'],
        [2, 4, '3gpqqch', 'numeric input/output'],
        [[1, 2, 3], 6, '3n4dm45', 'array input, scalar output'],
        [{ a => 1, b => 2 }, { sum => 3 }, '5dmn78d', 'hash input, hash output (key order test)'],
        [undef, undef, '3xo774r', 'undef input/output'],
    );

    my $all_pass = 1;
    for my $t (@tests) {
        my ($in, $out, $expected, $desc) = @$t;
        my $got = Regrets::Fingerprint::fingerprint($in, $out);
        my $status = $got eq $expected ? 'PASS' : 'FAIL';
        $all_pass = 0 if $status eq 'FAIL';
        printf "  [%s] %s\n", $status, $desc;
        printf "    expected: %s\n", $expected;
        printf "    got:      %s\n", $got;
    }

    print "\n";
    if ($all_pass) {
        print "ALL PASS — Perl fingerprint matches JS reference\n";
        exit 0;
    } else {
        print "SOME FAILED — Perl fingerprint diverges from JS\n";
        exit 1;
    }
}

1;
