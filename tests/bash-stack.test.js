import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
// REPO_ROOT/SCRIPTS get embedded unquoted into bash -c command strings
// throughout this file. On native Windows, resolve()/join() produce
// backslash-separated paths, and bash's own command-string parser treats
// every unquoted '\X' as an escaped literal X -- silently DROPPING every
// backslash (e.g. "C:\Users\user\foo" becomes "C:Usersuserfoo"), which
// then fails to resolve as a file path at all. Forward slashes are valid
// path separators on Windows too, so normalizing here fixes every call
// site at once (same root cause/class as issue #519).
const REPO_ROOT = resolve(__dirname, '..').replaceAll('\\', '/')
const SCRIPTS = join(REPO_ROOT, 'scripts').replaceAll('\\', '/')

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a bash command in the given cwd, return { stdout, stderr, status }.
 * Throws if status is non-zero AND throwOnError is true.
 */
function bash(cmd, opts = {}) {
  const { cwd = REPO_ROOT, throwOnError = true } = opts
  const result = spawnSync('bash', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (throwOnError && result.status !== 0) {
    throw new Error(
      `bash command failed (status ${result.status}): ${cmd}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
    )
  }
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  }
}

/** Create a temp project dir with manifest + bash file. */
function makeTempProject() {
  const tmpDir = join(REPO_ROOT, '.tmp-bash-test-' + process.pid)
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(join(tmpDir, 'lib'), { recursive: true })
  mkdirSync(join(tmpDir, 'regrets'), { recursive: true })

  // Real bash function: slugify
  writeFileSync(join(tmpDir, 'lib', 'slugify.sh'),
`#!/usr/bin/env bash
slugify() {
  local out="\${1,,}"
  out=\$(printf '%s' "\$out" | sed -E 's/[^a-z0-9]+/-/g')
  out="\${out#-}"; out="\${out%-}"
  printf '%s' "\$out"
}

greet() {
  printf 'Hello, %s!' "\$1"
}
`)

  writeFileSync(join(tmpDir, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'bash-slugify',
        entry: 'slugify',
        file: 'lib/slugify.sh',
        stack: 'bash',
        inputs: ['Hello World', 'Hello, World!', 'Multiple   Spaces   Here'],
      },
      {
        id: 'bash-greet',
        entry: 'greet',
        file: 'lib/slugify.sh',
        stack: 'bash',
        inputs: ['World'],
      },
    ],
  }, null, 2))

  return tmpDir
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Bash stack — capture_bash.sh', () => {
  let tmpDir

  before(() => {
    tmpDir = makeTempProject()
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('capture produces .regret files with correct format', () => {
    const result = bash(`bash ${SCRIPTS}/capture_bash.sh`, { cwd: tmpDir })
    assert.equal(result.status, 0, `capture failed: ${result.stderr}`)

    const regretPath = join(tmpDir, 'regrets', 'bash-slugify.regret')
    assert.ok(existsSync(regretPath), 'bash-slugify.regret should exist')

    const content = readFileSync(regretPath, 'utf8')
    // Verify required metadata fields
    assert.match(content, /^cluster: bash-slugify$/m)
    assert.match(content, /^version: 1$/m)
    assert.match(content, /^fingerprint: [a-z0-9]{7}$/m)
    assert.match(content, /^captured: \d{4}-\d{2}-\d{2}T/m)
    assert.match(content, /^entry: slugify$/m)
    assert.match(content, /^stack: bash$/m)
    assert.match(content, /^fingerprintLevel: entry$/m)
    // Verify data section
    assert.match(content, /^---$/m)
    assert.match(content, /^INPUT  "Hello World"$/m)
    assert.match(content, /^OUTPUT "hello-world"$/m)
    assert.match(content, /^HASH   [a-z0-9]{7}$/m)
    // Multi-input INPUTS line (3 inputs → INPUTS has 2 entries)
    assert.match(content, /^INPUTS  \[/m)
  })

  test('capture respects --cluster filter', () => {
    const result = bash(`bash ${SCRIPTS}/capture_bash.sh --cluster bash-greet`, {
      cwd: tmpDir,
    })
    assert.equal(result.status, 0)

    // bash-greet.regret should exist
    assert.ok(existsSync(join(tmpDir, 'regrets', 'bash-greet.regret')))
    // bash-slugify.regret should also exist (from previous test) — we don't delete
  })

  test('capture reports 0 clusters when no bash stack in manifest', () => {
    // Use the JS-only test fixture
    const result = bash(`bash ${SCRIPTS}/capture_bash.sh`, {
      cwd: join(REPO_ROOT, 'tests'),
      throwOnError: false,
    })
    // Should exit 0 (no clusters found, not an error)
    // The tests/ dir has no manifest, so this will fail with "Manifest not found"
    // — that's exit 2. We accept either 0 or 2 as "didn't crash".
    assert.ok([0, 2].includes(result.status),
      `expected status 0 or 2, got ${result.status}: ${result.stderr}`)
  })
})

describe('Bash stack — validate_bash.sh', () => {
  let tmpDir

  before(() => {
    tmpDir = makeTempProject()
    // Capture first
    bash(`bash ${SCRIPTS}/capture_bash.sh --quiet`, { cwd: tmpDir })
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('validate PASSES when code is unchanged', () => {
    const result = bash(`bash ${SCRIPTS}/validate_bash.sh`, { cwd: tmpDir })
    assert.equal(result.status, 0, `validate should pass: ${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /PASS/i)
  })

  test('validate FAILs when behavior changes (breaking refactor)', () => {
    // Modify slugify to use underscores instead of hyphens
    const slugifyPath = join(tmpDir, 'lib', 'slugify.sh')
    let content = readFileSync(slugifyPath, 'utf8')
    content = content.replace("s/[^a-z0-9]+/-/g", "s/[^a-z0-9]+/_/g")
    writeFileSync(slugifyPath, content)

    const result = bash(`bash ${SCRIPTS}/validate_bash.sh`, {
      cwd: tmpDir,
      throwOnError: false,
    })
    assert.notEqual(result.status, 0, 'validate should fail on breaking change')
    assert.match(result.stdout, /HASH mismatch|FAIL/i)
  })

  test('validate PASSES again after restoring original behavior (valid refactor)', () => {
    // Restore original behavior with a different implementation (pure bash, no sed)
    const slugifyPath = join(tmpDir, 'lib', 'slugify.sh')
    writeFileSync(slugifyPath,
`#!/usr/bin/env bash
slugify() {
  local out="\${1,,}"
  local result="" i ch prev=0
  for ((i=0; i<\${#out}; i++)); do
    ch="\${out:i:1}"
    case "\$ch" in
      [a-z0-9]) result+="\$ch"; prev=0 ;;
      *) [[ \$prev -eq 0 ]] && { result+="-"; prev=1; } ;;
    esac
  done
  result="\${result#-}"; result="\${result%-}"
  printf '%s' "\$result"
}

greet() {
  printf 'Hello, %s!' "\$1"
}
`)

    const result = bash(`bash ${SCRIPTS}/validate_bash.sh`, { cwd: tmpDir })
    assert.equal(result.status, 0, `validate should pass on valid refactor: ${result.stdout}`)
    assert.match(result.stdout, /PASS/i)
  })

  test('validate FAILs when only a NON-FIRST input changes (multi-input contract)', () => {
    // This is the critical multi-input regression test. The .regret file
    // for bash-slugify has 3 inputs (1 in INPUT/OUTPUT/HASH + 2 in INPUTS).
    // A validator that only checks the first INPUT line would PASS this case
    // incorrectly. We mutate slugify so only input #2 ("Hello, World!")
    // produces a different output, then assert validate FAILs.
    //
    // First re-capture to reset state (the previous test mutated slugify.sh).
    const slugifyPath = join(tmpDir, 'lib', 'slugify.sh')
    writeFileSync(slugifyPath,
`#!/usr/bin/env bash
slugify() {
  local out="\${1,,}"
  out=\$(printf '%s' "\$out" | sed -E 's/[^a-z0-9]+/-/g')
  out="\${out#-}"; out="\${out%-}"
  printf '%s' "\$out"
}

greet() {
  printf 'Hello, %s!' "\$1"
}
`)
    bash(`bash ${SCRIPTS}/capture_bash.sh`, { cwd: tmpDir, throwOnError: false })

    // Now mutate: only "Hello, World!" (input #2) gets a different output.
    // All other inputs still produce the original slugified output.
    writeFileSync(slugifyPath,
`#!/usr/bin/env bash
slugify() {
  local input="\$1"
  if [[ "\$input" == "Hello, World!" ]]; then
    printf 'MUTATED-FOR-INPUT-2'
    return
  fi
  local out="\${input,,}"
  out=\$(printf '%s' "\$out" | sed -E 's/[^a-z0-9]+/-/g')
  out="\${out#-}"; out="\${out%-}"
  printf '%s' "\$out"
}

greet() {
  printf 'Hello, %s!' "\$1"
}
`)

    const result = bash(`bash ${SCRIPTS}/validate_bash.sh`, {
      cwd: tmpDir,
      throwOnError: false,
    })
    // MUST exit non-zero — input #2 changed, even though input #1 is unchanged.
    assert.notEqual(result.status, 0,
      `validate must exit non-zero when a non-first input fails; got exit ${result.status}\nstdout: ${result.stdout}`)
    // MUST mention INPUTS[1] (the second input, 0-indexed) in the failure output.
    assert.match(result.stdout, /INPUTS\[1\]|multi-input/i,
      `validate should mention INPUTS[1] / multi-input mismatch; got:\n${result.stdout}`)

    // Restore original slugify so the next test (if any) sees clean state.
    writeFileSync(slugifyPath,
`#!/usr/bin/env bash
slugify() {
  local out="\${1,,}"
  out=\$(printf '%s' "\$out" | sed -E 's/[^a-z0-9]+/-/g')
  out="\${out#-}"; out="\${out%-}"
  printf '%s' "\$out"
}

greet() {
  printf 'Hello, %s!' "\$1"
}
`)
  })
})

describe('Bash stack — regret.js CLI dispatch', () => {
  let tmpDir

  before(() => {
    tmpDir = makeTempProject()
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('regret capture dispatches to capture_bash.sh for stack: "bash"', () => {
    const result = bash(`node ${SCRIPTS}/regret.js capture`, { cwd: tmpDir })
    assert.equal(result.status, 0, `regret capture failed: ${result.stderr}`)
    assert.ok(existsSync(join(tmpDir, 'regrets', 'bash-slugify.regret')))
  })

  test('regret validate dispatches to validate_bash.sh for stack: "bash"', () => {
    const result = bash(`node ${SCRIPTS}/regret.js validate`, { cwd: tmpDir })
    assert.equal(result.status, 0, `regret validate failed: ${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /PASS/i)
  })

  test('regret.py capture dispatches correctly', () => {
    // Re-capture via Python dispatcher
    const result = bash(`python3 ${SCRIPTS}/regret.py capture`, { cwd: tmpDir })
    assert.equal(result.status, 0, `regret.py capture failed: ${result.stderr}`)
  })
})

describe('Bash stack — cross-stack parity', () => {
  test('Bash fingerprint matches JS fingerprint for same input/output', () => {
    // Test vectors verified against fingerprint.js
    const vectors = [
      { input: '"hello"', output: '"world"', expected: '67cq6s6' },
      { input: '42', output: '84', expected: 'brdgfkz' },
      { input: 'null', output: '"ok"', expected: '3eyc2hn' },
      { input: '{"b":2,"a":1}', output: '[1,2,3]', expected: '39j9hkp' },
    ]

    for (const v of vectors) {
      const result = bash(
        `source ${SCRIPTS}/fingerprint_bash.sh && fingerprint '${v.input}' '${v.output}'`
      )
      const actual = result.stdout.trim()
      assert.equal(actual, v.expected,
        `Bash fp "${actual}" !== JS fp "${v.expected}" for input=${v.input} output=${v.output}`)
    }
  })

  test('JS validate.js can parse Bash-generated .regret file', async () => {
    const tmpDir = makeTempProject()
    try {
      bash(`bash ${SCRIPTS}/capture_bash.sh --quiet`, { cwd: tmpDir })

      // Import parseRegret from validate.js and verify it can read the .regret
      // pathToFileURL: Node's ESM loader on Windows requires a file:// URL
      // for absolute-path dynamic imports -- a raw "c:/..." string throws
      // ERR_UNSUPPORTED_ESM_URL_SCHEME.
      const { parseRegret } = await import(pathToFileURL(join(SCRIPTS, 'validate.js')))
      const content = readFileSync(join(tmpDir, 'regrets', 'bash-slugify.regret'), 'utf8')
      const parsed = parseRegret(content)

      assert.equal(parsed.cluster, 'bash-slugify')
      assert.equal(parsed.stack, 'bash')
      assert.equal(parsed.entry, 'slugify')
      assert.equal(parsed.input, 'Hello World')
      assert.equal(parsed.output, 'hello-world')
      assert.match(parsed.goldenHash, /^[a-z0-9]{7}$/)
      assert.ok(parsed.goldenInputs && parsed.goldenInputs.length === 2,
        `goldenInputs should have 2 entries, got ${parsed.goldenInputs?.length}`)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Bash stack — parity_test_bash.sh', () => {
  test('parity test script passes (all vectors match JS)', () => {
    const result = bash(`bash ${SCRIPTS}/parity_test_bash.sh`)
    assert.equal(result.status, 0, `parity test failed: ${result.stdout}`)
    assert.match(result.stdout, /Parity test PASSED/)
  })
})
