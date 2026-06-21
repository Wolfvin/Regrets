#!/usr/bin/env perl
# validate_perl.pl — validate regret fingerprints for Perl clusters
#
# Reads .regret files from regrets/, re-invokes the Perl subroutines with the
# stored INPUT, recomputes the fingerprint, and compares against the stored HASH.
# Reports PASS or FAIL per cluster.
#
# Mirrors the contract of scripts/validate.js (JS) and scripts/validate.py (Python).
# Can validate .regret files created by capture_perl.pl AND by capture.js /
# capture.py (cross-stack compatible — only the fingerprint algorithm matters).
#
# Usage:
#   perl scripts/validate_perl.pl                          # validate all .regret files
#   perl scripts/validate_perl.pl --cluster my-cluster     # validate one
#   perl scripts/validate_perl.pl --manifest ./regrets/manifest.json
#   perl scripts/validate_perl.pl --quiet                  # only print failures
#
# Exit code: 0 if all validated, 1 if any FAILed.

use strict;
use warnings;
use Getopt::Long qw(GetOptions);
use JSON::PP;
use File::Basename qw(dirname basename);
use File::Spec;
use Cwd qw(abs_path getcwd);
use POSIX qw(strftime);
use FindBin;

# Add scripts/ to @INC so we can require fingerprint_perl.pl
use lib $FindBin::Bin;
require 'fingerprint_perl.pl';
Regrets::Fingerprint->import(qw(fingerprint stable_stringify));

# ─── CLI args ─────────────────────────────────────────────────────────────────

my $cluster_filter;
my $manifest_path;
my $quiet = 0;
my $help = 0;
my $fail_fast = 0;
my $update_target;
my $update_reason;

GetOptions(
    'cluster=s'  => \$cluster_filter,
    'manifest=s' => \$manifest_path,
    'quiet'      => \$quiet,
    'fail-fast'  => \$fail_fast,
    'update=s'   => \$update_target,
    'reason=s'   => \$update_reason,
    'help|h'     => \$help,
) or die "Invalid args. Use --help.\n";

if ($help) {
    print STDERR <<'USAGE';
validate_perl.pl — validate regret fingerprints for Perl clusters

Usage:
  perl scripts/validate_perl.pl                          # validate all
  perl scripts/validate_perl.pl --cluster my-cluster     # validate one
  perl scripts/validate_perl.pl --manifest ./regrets/manifest.json
  perl scripts/validate_perl.pl --quiet                  # only print failures
  perl scripts/validate_perl.pl --fail-fast              # exit on first failure
  perl scripts/validate_perl.pl --update <id> --reason "..."  # re-capture + update golden

Exit code: 0 if all PASSed, 1 if any FAILed.
USAGE
    exit 0;
}

$manifest_path //= File::Spec->catfile(getcwd(), 'regrets', 'manifest.json');

# ─── parse_regret ─────────────────────────────────────────────────────────────
# Parse a .regret file into a hashref with metadata + input/output/hash.
# Mirrors validate.js's parseRegret():
#   - First section (before ---) is metadata (key: value lines)
#   - Second section has INPUT / OUTPUT / HASH lines

sub parse_regret {
    my ($content) = @_;
    my ($meta_section, $data_section) = split /\n---\n/, $content, 2;
    $data_section //= '';

    my %meta;
    for my $line (split /\n/, $meta_section) {
        my $colon_idx = index($line, ': ');
        next if $colon_idx == -1;
        my $key = substr($line, 0, $colon_idx);
        my $val = substr($line, $colon_idx + 2);
        $val =~ s/^\s+|\s+$//g;
        $meta{$key} = $val;
    }

    my %data;
    for my $line (split /\n/, $data_section) {
        if ($line =~ /^INPUT\s+(.*)$/) {
            my $s = $1;
            $data{input} = $s eq 'undefined' ? undef : eval { decode_json($s) };
            $data{input} = undef if $@ && $s ne 'undefined';
        } elsif ($line =~ /^OUTPUT\s+(.*)$/) {
            my $s = $1;
            $data{output} = $s eq 'undefined' ? undef : eval { decode_json($s) };
            $data{output} = undef if $@ && $s ne 'undefined';
        } elsif ($line =~ /^HASH\s+(\S+)$/) {
            $data{hash} = $1;
        } elsif ($line =~ /^INPUTS\s+(.*)$/) {
            # Multi-input contract (issue #315 parity). Format:
            #   INPUTS [{"input":..,"output":..,"hash":..}, ...]
            # The first input is already represented by INPUT/OUTPUT/HASH;
            # the INPUTS line contains inputs 1+ as a JSON array.
            my $s = $1;
            $data{inputs} = eval { decode_json($s) };
            $data{inputs} = [] if $@ || ref($data{inputs}) ne 'ARRAY';
        }
    }

    # Parse watches/normalize/ignoreFields arrays: "[a, b]" → [a, b]
    for my $key (qw(watches normalize ignoreFields ignorePaths valuePaths)) {
        if (defined $meta{$key} && $meta{$key} =~ /^\[(.*)\]$/) {
            my $inner = $1;
            $meta{$key} = [ grep { length } split /\s*,\s*/, $inner ];
        }
    }

    return { meta => \%meta, data => \%data };
}

# ─── Invoke Perl subroutine ───────────────────────────────────────────────────
# Same logic as capture_perl.pl's invoke_entry. Duplicated here to keep
# validate_perl.pl self-contained (does not depend on capture_perl.pl being
# loadable — they're separate commands).
#
# Returns: { output => <value>, error => <string if thrown> }

sub invoke_entry {
    my ($meta, $input) = @_;
    my $entry = $meta->{entry}
        or die "❌ Regret file has no 'entry' field in metadata\n";

    my $loaded_module;
    if (my $file = $meta->{file}) {
        die "❌ file '$file' does not exist\n" unless -f $file;
        my $dir = abs_path(dirname($file)) or die "❌ Cannot resolve dir of $file\n";
        local @INC = ($dir, @INC);
        my $module_name = basename($file);
        $module_name =~ s/\.pm$//;
        require $module_name . ".pm";
        $loaded_module = $module_name;
    } elsif (my $module = $meta->{module}) {
        if (my $lib_path = $meta->{libPath}) {
            local @INC = ($lib_path, @INC);
            require $module;
            $loaded_module = $module;
        } else {
            require $module;
            $loaded_module = $module;
        }
    } else {
        die "❌ Regret file has neither 'file' nor 'module' field — cannot load entry\n";
    }

    my $coderef;
    if ($entry =~ /::/) {
        no strict 'refs';
        $coderef = \&{$entry};
    } else {
        no strict 'refs';
        $coderef = \&{$loaded_module . '::' . $entry}
            or die "❌ Cannot find subroutine $entry in $loaded_module\n";
    }

    my $multi_args = ($meta->{multiArgs} // '') eq 'true';
    my @args;
    if ($multi_args) {
        die "❌ multiArgs is true but input is not an array\n" unless ref($input) eq 'ARRAY';
        @args = @$input;
    } else {
        @args = defined $input ? ($input) : ();
    }

    my $output;
    eval {
        $output = $coderef->(@args);
    };
    if (my $err = $@) {
        return { error => $err, output => undef };
    }
    return { output => $output, error => undef };
}

# ─── Main ─────────────────────────────────────────────────────────────────────

sub main {
    # Read manifest to find Perl clusters (we validate .regret files that
    # correspond to Perl clusters). If no manifest, validate all .regret files
    # in regrets/ dir (cross-stack mode).
    my $manifest;
    if (-f $manifest_path) {
        open my $fh, '<', $manifest_path or die "❌ Cannot read $manifest_path: $!\n";
        local $/;
        my $content = <$fh>;
        close $fh;
        $manifest = decode_json($content);
    }

    # ── --update mode: re-capture the target cluster, then validate ──────
    # Mirrors validate_php.php's --update behavior. The audit.log write is
    # a stub (capture_perl.pl doesn't write audit.log yet) — the golden .regret
    # is updated in-place by the re-capture. This is sufficient for the CLI
    # dispatch (`regret update --cluster <perl-cluster>`) to work end-to-end.
    if ($update_target) {
        unless (defined $update_reason && $update_reason =~ /\S/) {
            die "❌ --update requires --reason\n   Example: --update my-cluster --reason \"describe why behavior changed\"\n";
        }
        # Basic reason length check (mirrors PHP's str_word_count >= 4)
        my @words = ($update_reason =~ /\S+/g);
        if (@words < 4) {
            die "❌ --reason is too vague: \"$update_reason\"\n   Be specific. e.g. \"tax rate updated from 11% to 12% per new regulation\"\n";
        }
        print "🔄 Update mode — re-capturing cluster '$update_target'...\n" unless $quiet;
        my $capture_script = File::Spec->catfile($FindBin::Bin, 'capture_perl.pl');
        my @cap_args = ('perl', $capture_script, '--cluster', $update_target);
        push @cap_args, '--manifest', $manifest_path if defined $manifest_path;
        push @cap_args, '--quiet' if $quiet;
        system(@cap_args) == 0
            or die "❌ Re-capture failed for '$update_target'\n";
        print "✅ Re-captured '$update_target' — golden .regret updated.\n" unless $quiet;
        # In update mode we don't run validate (the golden is now whatever
        # capture produced — validate would trivially PASS). Exit 0.
        exit 0;
    }

    my $regret_dir = File::Spec->catdir(getcwd(), 'regrets');
    die "❌ regrets/ directory not found\n" unless -d $regret_dir;

    # Find .regret files to validate
    my @regret_files;
    opendir(my $dh, $regret_dir) or die "❌ Cannot opendir $regret_dir: $!\n";
    while (my $f = readdir $dh) {
        next unless $f =~ /\.regret$/;
        next if $f =~ /\.calls\./;  # skip callee files
        push @regret_files, $f;
    }
    closedir $dh;

    # Filter by --cluster if given
    if (defined $cluster_filter) {
        my $target = "$cluster_filter.regret";
        @regret_files = grep { $_ eq $target } @regret_files;
        unless (@regret_files) {
            print "❌ No .regret file for cluster '$cluster_filter'\n";
            exit 1;
        }
    }

    # Filter to Perl clusters if manifest is available (so we don't try to
    # invoke JS/Python functions via Perl). But ALSO allow validating .regret
    # files that have stack: perl in their metadata, even if the manifest
    # doesn't list them (defensive).
    if ($manifest) {
        my %perl_clusters = map { $_->{id} => 1 } grep { ($_->{stack} // '') eq 'perl' } @{$manifest->{clusters} // []};
        @regret_files = grep {
            my $cid = $_;
            $cid =~ s/\.regret$//;
            exists $perl_clusters{$cid};
        } @regret_files;
    }

    unless (@regret_files) {
        print "No Perl clusters to validate.\n" unless $quiet;
        exit 0;
    }

    print "🔍 Validating Perl clusters...\n" unless $quiet;

    my $passed = 0;
    my $failed = 0;

    for my $regret_file (sort @regret_files) {
        my $regret_path = File::Spec->catfile($regret_dir, $regret_file);
        my $cid = $regret_file;
        $cid =~ s/\.regret$//;

        open my $fh, '<', $regret_path or do {
            print "  ❌ $cid — cannot read $regret_path: $!\n" unless $quiet;
            $failed++;
            next;
        };
        local $/;
        my $content = <$fh>;
        close $fh;

        my $regret = parse_regret($content);
        my $meta = $regret->{meta};
        my $data = $regret->{data};

        my $golden_hash = $data->{hash};
        my $input = $data->{input};
        my $extra_inputs = $data->{inputs} // [];  # inputs 1+ from INPUTS line

        unless (defined $golden_hash) {
            print "  ❌ $cid — no HASH line in .regret file\n" unless $quiet;
            $failed++;
            next;
        }

        # ── Validate the FIRST input (INPUT/OUTPUT/HASH) ─────────────────────
        my $cluster_failed = 0;

        my $result = eval { invoke_entry($meta, $input) };
        if (my $err = $@) {
            print "  ❌ $cid — failed to invoke: $err\n" unless $quiet;
            $failed++;
            next;
        }

        if ($result->{error}) {
            print "  ❌ $cid — invocation threw: $result->{error}\n" unless $quiet;
            $failed++;
            next;
        }

        my $output = $result->{output};
        my $live_hash = fingerprint($input, $output);

        if ($live_hash ne $golden_hash) {
            print "  ❌ $cid — golden: $golden_hash, live: $live_hash — FAIL\n";
            $failed++;
            if ($fail_fast) {
                print "\n  --fail-fast: stopping on first failure.\n" unless $quiet;
                last;
            }
            next;
        }

        # ── Validate inputs 1+ from the INPUTS line (issue #315 parity) ─────
        # A validator that only checks the first INPUT line would silently
        # PASS a regression that only affects input #2+. We iterate the
        # INPUTS array and re-validate every entry — any mismatch FAILs
        # the cluster even if the first input still matches.
        for my $i (0 .. $#$extra_inputs) {
            my $entry = $extra_inputs->[$i];
            my $in  = $entry->{input};
            my $expected_hash = $entry->{hash};

            my $r = eval { invoke_entry($meta, $in) };
            if (my $err = $@) {
                print "  ❌ $cid — INPUTS[" . ($i + 1) . "] failed to invoke: $err\n";
                $cluster_failed = 1;
                last;
            }
            if ($r->{error}) {
                print "  ❌ $cid — INPUTS[" . ($i + 1) . "] invocation threw: $r->{error}\n";
                $cluster_failed = 1;
                last;
            }
            my $live = fingerprint($in, $r->{output});
            if ($live ne $expected_hash) {
                print "  ❌ $cid — INPUTS[" . ($i + 1) . "] hash mismatch (golden: $expected_hash, live: $live)\n";
                $cluster_failed = 1;
                last;
            }
        }

        if ($cluster_failed) {
            $failed++;
            if ($fail_fast) {
                print "\n  --fail-fast: stopping on first failure.\n" unless $quiet;
                last;
            }
            next;
        }

        my $n_inputs = 1 + scalar(@$extra_inputs);
        print "  ✅ $cid — $golden_hash — PASS ($n_inputs input"
            . ($n_inputs > 1 ? 's' : '') . ")\n" unless $quiet;
        $passed++;
    }

    print "\n" unless $quiet;
    print "Summary: $passed passed, $failed failed\n" unless $quiet;

    exit($failed > 0 ? 1 : 0);
}

main();
