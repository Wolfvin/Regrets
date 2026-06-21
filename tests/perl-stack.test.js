// tests/perl-stack.test.js — end-to-end test for the Perl stack
//
// Runs scripts/capture_perl.pl and scripts/validate_perl.pl against a temp
// Perl project, then asserts:
//   1. capture writes .regret files with all standard fields
//   2. capture writes the INPUTS line for multi-input clusters (issue #315 parity)
//   3. validate (no code change) exits 0 and prints PASS for all clusters
//   4. validate detects breaking change → exit 1, FAIL
//   5. validate detects valid refactor (same output) → exit 0, PASS
//   6. validate checks ALL inputs (multi-input contract) — mutating only
//      input #2 FAILs even though input #1 still matches
//   7. capture --cluster <id> only captures that one cluster
//   8. validate --cluster <id> only validates that one cluster
//   9. validate --fail-fast stops on first failure
//  10. cross-stack parity: Perl-written HASH matches JS fingerprint()
//  11. JS validate.js can parse Perl-generated .regret (cross-tool compat)
//  12. regret CLI capture/validate dispatch correctly for stack: "perl"
//
// Skips automatically if `perl` is not on PATH or lacks JSON::PP/Digest::SHA.
//
// Run: node --test tests/perl-stack.test.js

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'
import { parseRegret } from '../scripts/validate.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_PERL = join(SCRIPTS_DIR, 'capture_perl.pl')
const VALIDATE_PERL = join(SCRIPTS_DIR, 'validate_perl.pl')
const REGRET_CLI = join(SCRIPTS_DIR, 'regret.js')

// ─── Skip if `perl` is not available ──────────────────────────────────────────

function perlAvailable() {
  const r = spawnSync('perl', ['-MJSON::PP', '-MDigest::SHA', '-e', 'exit 0'], {
    encoding: 'utf8', timeout: 5_000,
  })
  return r.status === 0
}

const hasPerl = perlAvailable()

// ─── Temp project fixture ────────────────────────────────────────────────────

const TMP = resolve(join(process.cwd(), 'tests', `__perl_test_${process.pid}__`))

function makeTempProject() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'lib'), { recursive: true })
  mkdirSync(join(TMP, 'regrets'), { recursive: true })

  // Real Perl module with pure functions
  writeFileSync(join(TMP, 'lib', 'StringUtils.pm'),
`package StringUtils;
use strict;
use warnings;
use Exporter qw(import);
our \@EXPORT_OK = qw(slugify count_vowels reverse_str);

# Slugify: lowercase, replace non-alphanumerics with hyphens, collapse, trim
sub slugify {
    my \$s = shift;
    \$s = lc(\$s);
    \$s =~ s/[^a-z0-9]+/-/g;
    \$s =~ s/^-+|-+\$//g;
    return \$s;
}

# Count vowels (a, e, i, o, u) in a string
sub count_vowels {
    my \$s = shift;
    my \$n = (\$s =~ tr/aeiouAEIOU//);
    return \$n;
}

# Reverse a string
sub reverse_str {
    my \$s = shift;
    return scalar reverse(\$s);
}

1;
`)

  writeFileSync(join(TMP, 'lib', 'MathUtils.pm'),
`package MathUtils;
use strict;
use warnings;
use Exporter qw(import);
our \@EXPORT_OK = qw(add factorial);

sub add {
    my (\$a, \$b) = \@_;
    return \$a + \$b;
}

sub factorial {
    my \$n = shift;
    return 1 if \$n <= 1;
    return \$n * factorial(\$n - 1);
}

1;
`)

  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'slugify-fn',
        entry: 'slugify',
        file: 'lib/StringUtils.pm',
        stack: 'perl',
        inputs: ['Hello World', 'Hello, World!', 'Multiple   Spaces', 'UPPER'],
      },
      {
        id: 'count-vowels-fn',
        entry: 'count_vowels',
        file: 'lib/StringUtils.pm',
        stack: 'perl',
        inputs: ['hello', 'aeiou', 'xyz'],
      },
      {
        id: 'add-fn',
        entry: 'add',
        file: 'lib/MathUtils.pm',
        stack: 'perl',
        multiArgs: true,
        inputs: [[1, 2], [10, 20], [100, 200]],
      },
    ],
  }, null, 2))
}

function runPerl(scriptPath, args = [], cwd = TMP) {
  const result = spawnSync('perl', [scriptPath, ...args], {
    cwd, encoding: 'utf8', timeout: 30_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function runNode(scriptPath, args = [], cwd = TMP) {
  const result = spawnSync('node', [scriptPath, ...args], {
    cwd, encoding: 'utf8', timeout: 30_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Perl stack — capture + validate', { skip: !hasPerl && 'perl not on PATH (or missing JSON::PP/Digest::SHA)' }, () => {
  before(() => makeTempProject())
  after(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) })

  beforeEach(() => {
    // Clean .regret files before each test so capture state is fresh.
    const regretDir = join(TMP, 'regrets')
    if (existsSync(regretDir)) {
      for (const f of readdirSync(regretDir)) {
        if (f.endsWith('.regret')) rmSync(join(regretDir, f))
      }
    }
  })

  it('capture writes .regret files with all standard fields + INPUTS line for multi-input', () => {
    const result = runPerl(CAPTURE_PERL)
    assert.equal(result.exitCode, 0,
      `capture failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    for (const id of ['slugify-fn', 'count-vowels-fn', 'add-fn']) {
      const regretPath = join(TMP, 'regrets', `${id}.regret`)
      assert.ok(existsSync(regretPath), `${id}.regret was not written`)
      const content = readFileSync(regretPath, 'utf8')

      // Header fields
      assert.match(content, /^cluster: /m, `${id}: missing cluster header`)
      assert.match(content, /^version: 1/m, `${id}: missing version header`)
      assert.match(content, /^fingerprint: \S{7}/m, `${id}: missing fingerprint header`)
      assert.match(content, /^captured: /m, `${id}: missing captured header`)
      assert.match(content, /^watches: \[/m, `${id}: missing watches header`)
      assert.match(content, /^entry: /m, `${id}: missing entry header`)
      assert.match(content, /^stack: perl/m, `${id}: missing/wrong stack header`)
      assert.match(content, /^fingerprintLevel: entry/m, `${id}: missing fingerprintLevel header`)
      assert.match(content, /^file: /m, `${id}: missing file header`)

      // Data section
      assert.match(content, /^---$/m, `${id}: missing --- separator`)
      assert.match(content, /^INPUT\s+/m, `${id}: missing INPUT line`)
      assert.match(content, /^OUTPUT\s+/m, `${id}: missing OUTPUT line`)
      assert.match(content, /^HASH\s+\S{7}/m, `${id}: missing HASH line`)

      // Multi-input INPUTS line — each cluster has 3+ inputs
      assert.match(content, /^INPUTS\s+\[/m, `${id}: missing INPUTS line for multi-input cluster`)
    }
  })

  it('validate (no code change) exits 0 and prints PASS for all clusters', () => {
    runPerl(CAPTURE_PERL)  // capture first
    const result = runPerl(VALIDATE_PERL)
    assert.equal(result.exitCode, 0,
      `validate failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /slugify-fn.*PASS|PASS.*slugify-fn/i, 'should PASS slugify-fn')
    assert.match(result.stdout, /count-vowels-fn.*PASS|PASS.*count-vowels-fn/i, 'should PASS count-vowels-fn')
    assert.match(result.stdout, /add-fn.*PASS|PASS.*add-fn/i, 'should PASS add-fn')
  })

  it('validate detects breaking change → exit 1, FAIL', () => {
    runPerl(CAPTURE_PERL)
    // Mutate slugify: replace hyphens with underscores
    const slugifyPath = join(TMP, 'lib', 'StringUtils.pm')
    const original = readFileSync(slugifyPath, 'utf8')
    const mutated = original.replace("s/[^a-z0-9]+/-/g", "s/[^a-z0-9]+/_/g")
    writeFileSync(slugifyPath, mutated)
    try {
      const result = runPerl(VALIDATE_PERL)
      assert.notEqual(result.exitCode, 0,
        `validate should exit non-zero on breaking change; got ${result.exitCode}\nstdout: ${result.stdout}`)
      assert.match(result.stdout, /FAIL.*slugify-fn|slugify-fn.*FAIL/i, 'should FAIL slugify-fn')
      // Unmutated clusters should still PASS
      assert.match(result.stdout, /add-fn.*PASS|PASS.*add-fn/i, 'add-fn should still PASS (not mutated)')
    } finally {
      writeFileSync(slugifyPath, original)
    }
  })

  it('validate detects valid refactor (same output) → exit 0, PASS', () => {
    runPerl(CAPTURE_PERL)
    // Refactor slugify: use a different regex approach but produce identical output
    const slugifyPath = join(TMP, 'lib', 'StringUtils.pm')
    const original = readFileSync(slugifyPath, 'utf8')
    const refactored = original.replace(
      'sub slugify {\n    my $s = shift;\n    $s = lc($s);\n    $s =~ s/[^a-z0-9]+/-/g;\n    $s =~ s/^-+|-+$//g;\n    return $s;\n}',
      'sub slugify {\n    my $s = shift;\n    $s = lc($s);\n    # Refactored: use [^a-z0-9]+ alternation\n    $s =~ s/[^a-z0-9]+/-/g;\n    my $out = $s;\n    $out =~ s/^-+//;\n    $out =~ s/-+$//;\n    return $out;\n}',
    )
    assert.ok(refactored !== original, 'refactor pattern must match')
    writeFileSync(slugifyPath, refactored)
    try {
      const result = runPerl(VALIDATE_PERL)
      assert.equal(result.exitCode, 0,
        `validate should exit 0 for valid refactor; got ${result.exitCode}\nstdout: ${result.stdout}`)
      assert.match(result.stdout, /slugify-fn.*PASS|PASS.*slugify-fn/i, 'slugify-fn should PASS after valid refactor')
    } finally {
      writeFileSync(slugifyPath, original)
    }
  })

  it('validate checks ALL inputs (multi-input contract) — mutating only input #2 FAILs', () => {
    runPerl(CAPTURE_PERL)
    // Mutate slugify so only "Hello, World!" (input #2) produces different output
    const slugifyPath = join(TMP, 'lib', 'StringUtils.pm')
    const original = readFileSync(slugifyPath, 'utf8')
    const mutated = original.replace(
      'sub slugify {\n    my $s = shift;\n    $s = lc($s);\n    $s =~ s/[^a-z0-9]+/-/g;\n    $s =~ s/^-+|-+$//g;\n    return $s;\n}',
      'sub slugify {\n    my $s = shift;\n    if ($s eq "Hello, World!") { return "MUTATED-FOR-INPUT-2"; }\n    $s = lc($s);\n    $s =~ s/[^a-z0-9]+/-/g;\n    $s =~ s/^-+|-+$//g;\n    return $s;\n}',
    )
    assert.ok(mutated !== original, 'mutation pattern must match')
    writeFileSync(slugifyPath, mutated)
    try {
      const result = runPerl(VALIDATE_PERL)
      assert.notEqual(result.exitCode, 0,
        `validate should exit non-zero when input #2 changes; got ${result.exitCode}\nstdout: ${result.stdout}`)
      assert.match(result.stdout, /INPUTS\[1\].*slugify-fn|slugify-fn.*INPUTS\[1\]/i,
        'should mention INPUTS[1] mismatch for slugify-fn')
    } finally {
      writeFileSync(slugifyPath, original)
    }
  })

  it('capture --cluster <id> only captures that one cluster', () => {
    const result = runPerl(CAPTURE_PERL, ['--cluster', 'add-fn'])
    assert.equal(result.exitCode, 0,
      `capture --cluster add-fn failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.ok(existsSync(join(TMP, 'regrets', 'add-fn.regret')), 'add-fn.regret should exist')
    assert.ok(!existsSync(join(TMP, 'regrets', 'slugify-fn.regret')),
      'slugify-fn.regret should NOT exist when --cluster add-fn is set')
  })

  it('validate --cluster <id> only validates that one cluster', () => {
    runPerl(CAPTURE_PERL)  // capture all first
    const result = runPerl(VALIDATE_PERL, ['--cluster', 'add-fn'])
    assert.equal(result.exitCode, 0,
      `validate --cluster add-fn failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /add-fn.*PASS|PASS.*add-fn/i, 'should PASS add-fn')
    assert.doesNotMatch(result.stdout, /slugify-fn/, 'should NOT mention slugify-fn')
    assert.doesNotMatch(result.stdout, /count-vowels-fn/, 'should NOT mention count-vowels-fn')
  })

  it('validate --fail-fast stops on first failure', () => {
    runPerl(CAPTURE_PERL)
    // Mutate slugify to break it
    const slugifyPath = join(TMP, 'lib', 'StringUtils.pm')
    const original = readFileSync(slugifyPath, 'utf8')
    const mutated = original.replace("s/[^a-z0-9]+/-/g", "s/[^a-z0-9]+/_/g")
    writeFileSync(slugifyPath, mutated)
    try {
      const result = runPerl(VALIDATE_PERL, ['--fail-fast'])
      assert.notEqual(result.exitCode, 0, 'should exit non-zero')
      assert.match(result.stdout, /--fail-fast: stopping/i, 'should print --fail-fast message')
      // Should mention the first failing cluster but not necessarily all clusters
      assert.match(result.stdout, /FAIL/i, 'should have at least one FAIL')
    } finally {
      writeFileSync(slugifyPath, original)
    }
  })

  it('cross-stack parity: Perl-written HASH matches JS fingerprint()', () => {
    runPerl(CAPTURE_PERL)
    for (const id of ['slugify-fn', 'count-vowels-fn', 'add-fn']) {
      const regretPath = join(TMP, 'regrets', `${id}.regret`)
      const content = readFileSync(regretPath, 'utf8')
      const regret = parseRegret(content)

      // Verify first input hash matches JS
      const jsHash = fingerprint(regret.input, regret.output)
      assert.equal(jsHash, regret.goldenHash,
        `${id}: cross-stack parity FAILED for first input — JS computed "${jsHash}" but Perl .regret stored "${regret.goldenHash}"`)

      // Verify multi-input hashes match JS
      if (regret.goldenInputs) {
        for (let i = 0; i < regret.goldenInputs.length; i++) {
          const gi = regret.goldenInputs[i]
          const jsHashI = fingerprint(gi.input, gi.output)
          assert.equal(jsHashI, gi.hash,
            `${id}: cross-stack parity FAILED for input #${i + 2} — JS computed "${jsHashI}" but Perl .regret stored "${gi.hash}"`)
        }
      }
    }
  })

  it('JS validate.js can parse Perl-generated .regret (cross-tool compat)', () => {
    runPerl(CAPTURE_PERL)
    const content = readFileSync(join(TMP, 'regrets', 'add-fn.regret'), 'utf8')
    const regret = parseRegret(content)
    assert.equal(regret.stack, 'perl')
    assert.equal(regret.entry, 'add')
    assert.equal(regret.file, 'lib/MathUtils.pm')
    assert.ok(regret.goldenHash, 'should have goldenHash')
    assert.ok(regret.goldenInputs, 'should have goldenInputs (INPUTS line)')
    assert.equal(regret.goldenInputs.length, 2, 'add-fn has 3 inputs → 2 in INPUTS (first is in INPUT/OUTPUT/HASH)')
  })

  it('regret CLI capture dispatches to capture_perl.pl for stack: "perl"', () => {
    const result = runNode(REGRET_CLI, ['capture'])
    assert.equal(result.exitCode, 0,
      `regret capture failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /perl.*capture_perl\.pl|capture_perl\.pl/i, 'should dispatch to capture_perl.pl')
    assert.ok(existsSync(join(TMP, 'regrets', 'slugify-fn.regret')), 'slugify-fn.regret should exist')
  })

  it('regret CLI validate dispatches to validate_perl.pl for stack: "perl"', () => {
    runPerl(CAPTURE_PERL)  // capture first
    const result = runNode(REGRET_CLI, ['validate'])
    assert.equal(result.exitCode, 0,
      `regret validate failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /perl.*validate_perl\.pl|validate_perl\.pl/i, 'should dispatch to validate_perl.pl')
    assert.match(result.stdout, /PASS/i, 'should have at least one PASS')
  })
})
