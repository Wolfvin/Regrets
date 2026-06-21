#!/usr/bin/env perl
# capture_perl.pl — capture regret fingerprints for Perl clusters
#
# Reads regrets/manifest.json, invokes Perl subroutines with inputs from the
# manifest, hashes the output, and writes .regret files with the standard
# Regrets format (cluster, version, fingerprint, captured, INPUT, OUTPUT, HASH).
#
# Mirrors the contract of scripts/capture.js (JS) and scripts/capture.py (Python).
# The .regret file format is IDENTICAL — a Perl cluster's .regret file can be
# validated by validate.js, validate.py, or validate_perl.pl interchangeably
# (cross-stack compatible).
#
# Usage:
#   perl scripts/capture_perl.pl                          # capture all Perl clusters
#   perl scripts/capture_perl.pl --cluster my-cluster     # capture one cluster
#   perl scripts/capture_perl.pl --manifest ./regrets/manifest.json
#   perl scripts/capture_perl.pl --quiet                  # only print summary
#   perl scripts/capture_perl.pl --verbose                # extra detail
#
# Manifest cluster fields for Perl:
#   {
#     "id":         "my-cluster",
#     "entry":      "add",                 # subroutine name (or "Package::add")
#     "file":       "lib/MyModule.pm",     # path to .pm file (will be `require`'d)
#   OR
#     "module":     "MyModule",            # module name (MyModule.pm must be in @INC)
#   OR
#     "libPath":    "lib",                 # directory to add to @INC
#
#     "stack":      "perl",
#     "inputs":     [2, 3],                # array of input values
#     "multiArgs":  true,                  # if true, each input is an array of args
#     "watches":    ["add"],               # optional, informational
#     "description": "Add two numbers"     # optional, informational
#   }

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
my $verbose = 0;
my $help = 0;

GetOptions(
    'cluster=s'  => \$cluster_filter,
    'manifest=s' => \$manifest_path,
    'quiet'      => \$quiet,
    'verbose'    => \$verbose,
    'help|h'     => \$help,
) or die "Invalid args. Use --help.\n";

if ($help) {
    print STDERR <<'USAGE';
capture_perl.pl — capture regret fingerprints for Perl clusters

Usage:
  perl scripts/capture_perl.pl                          # capture all Perl clusters
  perl scripts/capture_perl.pl --cluster my-cluster     # capture one cluster
  perl scripts/capture_perl.pl --manifest ./regrets/manifest.json
  perl scripts/capture_perl.pl --quiet                  # only print summary
  perl scripts/capture_perl.pl --verbose                # extra detail

Manifest cluster fields (stack: "perl"):
  - id:          cluster identifier (becomes <id>.regret filename)
  - entry:       subroutine name (e.g. "add" or "MyModule::add")
  - file:        path to .pm file (will be `require`'d), OR
  - module:      module name (MyModule.pm must be in @INC), OR
  - libPath:     directory to add to @INC (e.g. "lib")
  - stack:       "perl"
  - inputs:      array of input values (each invoked separately)
  - multiArgs:   if true, each input is treated as an array of positional args
  - watches:     optional, informational
USAGE
    exit 0;
}

$manifest_path //= File::Spec->catfile(getcwd(), 'regrets', 'manifest.json');

# ─── Read manifest ────────────────────────────────────────────────────────────

sub read_manifest {
    my ($path) = @_;
    die "❌ Manifest not found: $path\n" unless -f $path;
    open my $fh, '<', $path or die "❌ Cannot read $path: $!\n";
    local $/;
    my $content = <$fh>;
    close $fh;
    my $manifest = decode_json($content);
    return $manifest;
}

sub get_perl_clusters {
    my ($manifest, $filter) = @_;
    my $clusters = $manifest->{clusters} // [];
    my @perl = grep { ($_->{stack} // '') eq 'perl' } @$clusters;
    if (defined $filter) {
        @perl = grep { $_->{id} eq $filter } @perl;
    }
    return @perl;
}

# ─── Invoke Perl subroutine ───────────────────────────────────────────────────
# Loads the module (via `require` for `file` field, or via module name) and
# invokes the entry subroutine with the given args.
#
# Returns a hashref: { output => <value>, error => <string if thrown> }

sub invoke_entry {
    my ($cluster, $input) = @_;
    my $entry = $cluster->{entry}
        or die "❌ Cluster $cluster->{id} has no 'entry' field\n";

    # Determine how to load the module
    my $loaded_module;
    if (my $file = $cluster->{file}) {
        # `file` is a path like "lib/MyModule.pm"
        # Convert to module name and require it
        die "❌ Cluster $cluster->{id}: file '$file' does not exist\n"
            unless -f $file;
        # Add the file's parent dir to @INC so `require` finds it
        my $dir = abs_path(dirname($file)) or die "❌ Cannot resolve dir of $file\n";
        local @INC = ($dir, @INC);
        # Convert path to module name: lib/MyModule.pm → MyModule
        my $module_name = basename($file);
        $module_name =~ s/\.pm$//;
        require $module_name . ".pm";
        $loaded_module = $module_name;
    } elsif (my $module = $cluster->{module}) {
        if (my $lib_path = $cluster->{libPath}) {
            local @INC = ($lib_path, @INC);
            require $module;
            $module =~ s/::/\//g;
            $module .= ".pm";
            $loaded_module = $module;
        } else {
            require $module;
            $loaded_module = $module;
        }
    } else {
        die "❌ Cluster $cluster->{id}: must have either 'file' or 'module' field\n";
    }

    # Resolve the subroutine reference
    # entry can be "foo" (assumes main::foo or last-required package) or "Package::foo"
    my $coderef;
    if ($entry =~ /::/) {
        # Qualified: "Package::foo"
        no strict 'refs';
        $coderef = \&{$entry};
    } else {
        # Unqualified: assume it's in the loaded module
        no strict 'refs';
        $coderef = \&{$loaded_module . '::' . $entry}
            or die "❌ Cannot find subroutine $entry in $loaded_module\n";
    }

    # Build args
    my @args;
    if ($cluster->{multiArgs}) {
        # input is an array of args
        die "❌ multiArgs is true but input is not an array\n" unless ref($input) eq 'ARRAY';
        @args = @$input;
    } else {
        # Single arg (or no args if input is undef)
        @args = defined $input ? ($input) : ();
    }

    # Invoke
    my $output;
    eval {
        $output = $coderef->(@args);
    };
    if (my $err = $@) {
        return { error => $err, output => undef };
    }
    return { output => $output, error => undef };
}

# ─── Trivial Input Guard ──────────────────────────────────────────────────────
# Mirrors JS capture.js: skip clusters whose output is null/undefined/NaN.
# This prevents capturing "nothing" as a golden contract.

sub is_trivial_output {
    my ($output) = @_;
    return 1 unless defined $output;
    # Empty string is NOT trivial (it's a valid output for many functions)
    return 0;
}

# ─── Write .regret file ───────────────────────────────────────────────────────
# Format IDENTICAL to capture.js / capture.py:
#   cluster: <id>
#   version: 1
#   fingerprint: <7-char>
#   captured: <ISO timestamp>
#   watches: [fn1, fn2]
#   entry: <entry>
#   stack: perl
#   fingerprintLevel: entry
#   ---
#   INPUT  <json>
#   OUTPUT <json>
#   HASH   <7-char>

sub json_serialize {
    my ($val) = @_;
    # Use JSON::PP with canonical (sorted keys) and allow_nonref for scalars
    my $json = JSON::PP->new->allow_nonref->canonical;
    # Handle undef: JSON::PP encodes undef as "null" by default, which matches
    # the JS behavior (JSON.stringify(undefined) → undefined, but our template
    # literal coerces to "undefined" string... actually capture.js now writes
    # "undefined" literally for undefined inputs. We match that by special-casing.)
    return 'undefined' unless defined $val;
    return $json->encode($val);
}

sub write_regret_file {
    my ($cluster, $input, $output, $fp, $out_dir, $extra_inputs) = @_;
    # $extra_inputs: arrayref of {input, output, hash} for inputs 1+ (issue #315
    # multi-input contract). Empty/undef means single-input — no INPUTS line.
    my $cid = $cluster->{id};
    my $regret_path = File::Spec->catfile($out_dir, "$cid.regret");
    my $timestamp = strftime('%Y-%m-%dT%H:%M:%S.000000+00:00', gmtime());

    my $entry = $cluster->{entry};
    my @watches = @{$cluster->{watches} // []};
    my $watches_str = join(', ', @watches);

    my @lines = (
        "cluster: $cid",
        "version: 1",
        "fingerprint: $fp",
        "captured: $timestamp",
        "watches: [$watches_str]",
        "entry: $entry",
        "stack: perl",
        "fingerprintLevel: entry",
    );

    # Optional fields
    if ($cluster->{multiArgs}) {
        push @lines, "multiArgs: " . ($cluster->{multiArgs} ? 'true' : 'false');
    }
    if (my $m = $cluster->{module}) {
        push @lines, "module: $m";
    }
    if (my $f = $cluster->{file}) {
        push @lines, "file: $f";
    }
    if (my $lp = $cluster->{libPath}) {
        push @lines, "libPath: $lp";
    }

    push @lines, '---';
    push @lines, 'INPUT  ' . json_serialize($input);
    push @lines, 'OUTPUT ' . json_serialize($output);
    push @lines, "HASH   $fp";

    # Multi-input INPUTS line (issue #315 parity). The first input is already
    # represented by INPUT/OUTPUT/HASH above; the INPUTS line contains inputs
    # 1+ as a JSON array of {input, output, hash} objects. JS validate.js
    # parses this as `goldenInputs` and re-validates every entry.
    if ($extra_inputs && @$extra_inputs) {
        push @lines, 'INPUTS ' . json_serialize($extra_inputs);
    }

    open my $fh, '>', $regret_path or die "❌ Cannot write $regret_path: $!\n";
    print $fh join("\n", @lines), "\n";
    close $fh;

    return $regret_path;
}

# ─── Main ─────────────────────────────────────────────────────────────────────

sub main {
    my $manifest = read_manifest($manifest_path);
    my @perl_clusters = get_perl_clusters($manifest, $cluster_filter);

    unless (@perl_clusters) {
        print "No Perl clusters found in manifest.\n" unless $quiet;
        exit 0;
    }

    print "📡 Capturing Perl clusters...\n" unless $quiet;

    my $out_dir = File::Spec->catdir(getcwd(), 'regrets');
    mkdir $out_dir unless -d $out_dir;

    my $passed = 0;
    my $failed = 0;
    my $skipped = 0;

    for my $cluster (@perl_clusters) {
        my $cid = $cluster->{id};
        my $entry = $cluster->{entry};
        my @inputs = @{$cluster->{inputs} // []};
        @inputs = (undef) unless @inputs;  # default: one call with no args

        print "  📦 Cluster: $cid (entry: $entry)\n" unless $quiet;

        # ── Multi-input capture (issue #315 parity) ──────────────────────────
        # Process ALL inputs. The first input becomes the canonical
        # INPUT/OUTPUT/HASH trio. Inputs 1+ are appended as an INPUTS line
        # (JSON array of {input, output, hash} objects). validate_perl.pl
        # re-validates every input — a regression on input #2+ that
        # preserves input #1's output is correctly detected as FAIL.
        #
        # Pre-#315 behavior (single-input only) caused silent false-passes
        # for multi-input clusters — that's the same gap that closed the
        # duplicate Lua PRs (#380, #381) and Bash PR #392.
        my $first_input;
        my $first_output;
        my $first_fp;
        my @extra_inputs;  # for inputs 1+
        my $cluster_failed = 0;
        my $cluster_trivial_skipped = 0;

        for my $i (0 .. $#inputs) {
            my $input = $inputs[$i];
            my $result = eval { invoke_entry($cluster, $input) };
            if (my $err = $@) {
                print "     ❌ Failed to invoke (input #$i): $err\n" unless $quiet;
                $cluster_failed = 1;
                last;
            }
            if ($result->{error}) {
                print "     ⚠️  Invocation threw (input #$i): $result->{error}\n" unless $quiet;
                $cluster_failed = 1;
                last;
            }
            my $output = $result->{output};

            # Trivial Input Guard — only applies to the first input (the
            # golden). Trivial outputs on inputs 1+ are still recorded in
            # the INPUTS line so validate can detect regressions that turn
            # a non-trivial output into a trivial one (or vice versa).
            if ($i == 0 && is_trivial_output($output)) {
                print "     ⏭️  Skipped: trivial output (null/undefined) on first input\n" unless $quiet;
                $cluster_trivial_skipped = 1;
                last;
            }

            my $fp = fingerprint($input, $output);

            if ($i == 0) {
                $first_input  = $input;
                $first_output = $output;
                $first_fp     = $fp;
            } else {
                push @extra_inputs, {
                    input  => $input,
                    output => $output,
                    hash   => $fp,
                };
            }

            if ($verbose) {
                my $label = $i == 0 ? 'golden' : "input[$i]";
                print "     │ $label: " . substr(json_serialize($input), 0, 60)
                    . " → " . substr(json_serialize($output), 0, 60)
                    . " (fp: $fp)\n";
            }
        }

        if ($cluster_failed) {
            $failed++;
            next;
        }
        if ($cluster_trivial_skipped) {
            $skipped++;
            next;
        }

        my $regret_path = write_regret_file(
            $cluster, $first_input, $first_output, $first_fp, $out_dir, \@extra_inputs
        );

        my $n_inputs = 1 + scalar(@extra_inputs);
        print "     ✅ Fingerprint: $first_fp ($n_inputs input"
            . ($n_inputs > 1 ? 's' : '') . ")\n" unless $quiet;
        print "     📄 Saved: regrets/$cid.regret\n" unless $quiet;

        if ($verbose && !$quiet) {
            print "     ┌─ $cid call trace ──────────────────\n";
            print "     │ Input:  " . substr(json_serialize($first_input), 0, 120) . "\n";
            print "     │ Output: " . substr(json_serialize($first_output), 0, 120) . "\n";
            print "     │ Hash:   $first_fp\n";
        }

        $passed++;
    }

    print "\n" unless $quiet;
    print "Summary: $passed captured, $skipped skipped, $failed failed\n" unless $quiet;

    # Exit code: 0 if all passed (or skipped), non-zero if any failed
    exit($failed > 0 ? 1 : 0);
}

main();
