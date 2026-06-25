#!/usr/bin/env node
// regret.js — unified runner for regret-based regression testing
// Auto-detects stack from manifest and dispatches to the appropriate handler.
//
// Usage:
//   node scripts/regret.js capture [--cluster <id>]
//   node scripts/regret.js validate [--cluster <id>] [--runs 5] [--fail-fast]
//   node scripts/regret.js health [--sort fragile]
//   node scripts/regret.js update <cluster-id> --reason "specific reason"
//   node scripts/regret.js history <cluster-id>          Audit log of contract updates
//   node scripts/regret.js drift
//   node scripts/regret.js ci
//   node scripts/regret.js guard
//   node scripts/regret.js coverage [--cluster <id>] [--verbose]
//   node scripts/regret.js setup [--stack js|python|ts]
//   node scripts/regret.js scan [--dir src/] [--stack js] [--format manifest]
//   node scripts/regret.js watch [--dir src/] [--stack js|python]
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { constants as osConstants } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = __dirname

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const passThroughArgs = args.slice(1)

// Convert a signal name (e.g. 'SIGINT') to its numeric value.
// Node's os.constants.signals provides the mapping.
function signalNumber(sig) {
  const signals = osConstants.signals
  for (const [name, num] of Object.entries(signals)) {
    if (name === sig) return num
  }
  return 0
}

// ─── Helper ────────────────────────────────────────────────────────────────────

/**
 * Run a command asynchronously with signal forwarding (#302).
 *
 * Previously this used `execFileSync`, which blocks the parent's event loop.
 * When the user pressed Ctrl+C, the parent received SIGINT and exited
 * immediately, but the child was orphaned and kept running — defeating
 * PR #244's SIGINT cleanup handlers in capture.js / esm-callee-transform.js.
 *
 * Now we use async `spawn` and forward SIGINT / SIGTERM / SIGHUP from the
 * parent to the child explicitly. The parent stays alive until the child
 * finishes cleaning up, then exits with the child's exit code (or 128+signum
 * if the child was killed by a signal).
 *
 * @param {string} cmd - The executable (e.g., 'node', 'python3', 'bash')
 * @param {string[]} cmdArgs - Arguments as an array (properly escaped)
 * @returns {Promise<boolean>} true if exit code 0
 */
async function run(cmd, cmdArgs) {
  const displayCmd = `${cmd} ${cmdArgs.join(' ')}`
  console.log(`\n$ ${displayCmd}`)

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: 'inherit',
      cwd: process.cwd(),
    })

    // Track the live child so signal handlers can forward to it.
    _currentChild = child

    // Forward terminal signals to the child so its cleanup handlers run.
    // Without this, killing the parent orphans the child (issue #302).
    function forwardSignal(sig) {
      try { child.kill(sig) } catch { /* child already exited */ }
    }
    _signalForwarders.SIGINT = () => forwardSignal('SIGINT')
    _signalForwarders.SIGTERM = () => forwardSignal('SIGTERM')
    _signalForwarders.SIGHUP = () => forwardSignal('SIGHUP')

    child.on('error', (err) => {
      console.error(`❌ Failed to spawn ${cmd}: ${err.message}`)
      _currentChild = null
      resolve(false)
    })

    child.on('exit', (code, signal) => {
      _currentChild = null
      // If the child was killed by a signal (e.g. SIGINT from Ctrl+C),
      // propagate the conventional 128+signum exit code to the parent.
      // This preserves the shell convention (130 for SIGINT, 143 for SIGTERM)
      // so CI runners and wrapper scripts can distinguish signal-killed
      // runs from regular failures.
      if (signal) {
        const signum = signalNumber(signal)
        process.exit(128 + signum)
      }
      // If the child exited with a 128+signum code (e.g. 130 for SIGINT),
      // it means the child's own signal handler ran process.exit(130).
      // Propagate that code so CI runners see the correct exit status.
      if (code !== null && code >= 128 && code < 256) {
        process.exit(code)
      }
      resolve(code === 0)
    })
  })
}

// Track the current child process + signal forwarders so the parent's
// top-level signal handlers (installed below) can reach the child.
let _currentChild = null
const _signalForwarders = {}

// Top-level signal handlers. When the parent receives SIGINT/SIGTERM/SIGHUP,
// forward to the current child (if any) and wait for it to exit before
// exiting ourselves. If there's no current child, exit immediately.
function topLevelSignalHandler(sig) {
  const forwarder = _signalForwarders[sig]
  if (forwarder && _currentChild) {
    // Forward to child; child.on('exit') will resolve the promise and the
    // main flow will continue. We don't process.exit here — we let the
    // child finish cleaning up first.
    forwarder()
    return
  }
  // No child running — exit immediately with conventional 128+signum code.
  const signum = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[sig] ?? 0
  process.exit(128 + signum)
}
process.on('SIGINT', () => topLevelSignalHandler('SIGINT'))
process.on('SIGTERM', () => topLevelSignalHandler('SIGTERM'))
process.on('SIGHUP', () => topLevelSignalHandler('SIGHUP'))

// ─── Detect stacks from manifest ───────────────────────────────────────────────

function detectStacks() {
  const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const stacks = new Set()
    for (const cluster of manifest.clusters) {
      stacks.add(cluster.stack || 'js')
    }
    return [...stacks]
  } catch {
    return ['js']
  }
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

let success = true

// ─── Pre-build hook ───────────────────────────────────────────────────────────
// If the manifest has a `preBuild` field, run it before capture/validate/truth.
// This is essential for TypeScript projects that need `npm run build` before
// Regrets can import the compiled output.
// Example manifest: { "preBuild": "npm run build", "clusters": [...] }

async function runPreBuild() {
  try {
    const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.preBuild) {
      console.log(`\n🔧 Running preBuild: ${manifest.preBuild}`)
      // Use the same async `run()` helper so SIGINT propagates to preBuild
      // child processes too (#302).
      const [cmd, ...cmdArgs] = manifest.preBuild.split(' ')
      const ok = await run(cmd, cmdArgs)
      if (ok) {
        console.log(`   ✅ preBuild succeeded\n`)
        return true
      }
      console.error(`   ❌ preBuild failed — continuing anyway\n`)
      return false
    }
  } catch { /* no manifest or no preBuild — that's fine */ }
  return true
}

const needsPreBuild = ['capture', 'validate', 'truth', 'drift', 'ci', 'guard', 'chain']
// Note: 'setup' handles preBuild internally inside setup.js
const skipBuild = passThroughArgs.includes('--skip-build')
if (skipBuild) {
  // Remove --skip-build from args so it doesn't get passed to sub-commands
  const idx = passThroughArgs.indexOf('--skip-build')
  if (idx !== -1) passThroughArgs.splice(idx, 1)
  console.log('\n⏩ Skipping preBuild (--skip-build flag)')
}
// Track the in-flight preBuild promise so main() can await it before
// dispatching the actual command. This preserves the original ordering
// (preBuild finishes before capture/validate starts).
let _preBuildPromise = Promise.resolve(true)
if (needsPreBuild.includes(command) && !skipBuild) {
  // runPreBuild is now async (it uses the async `run()` helper for SIGINT
  // propagation). We don't await here — main() awaits the resulting
  // promise before dispatching the actual command.
  _preBuildPromise = runPreBuild()
}

async function main() {
  // Wait for preBuild to finish (if it was started) so capture/validate
  // see the built output. Failures are non-fatal (original behavior).
  await _preBuildPromise

  let success = true

  switch (command) {
  case 'install': {
    success = await run('node', [`${SCRIPTS_DIR}/install.js`, ...passThroughArgs])
    break
  }

  case 'init': {
    success = await run('node', [`${SCRIPTS_DIR}/init.js`, ...passThroughArgs])
    break
  }

  case 'capture': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts') {
        success = await run('node', [`${SCRIPTS_DIR}/capture.js`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = await run('python3', [`${SCRIPTS_DIR}/capture.py`, ...passThroughArgs]) && success
      } else if (stack === 'react') {
        success = await run('node', [`${SCRIPTS_DIR}/capture_react.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'css') {
        success = await run('node', [`${SCRIPTS_DIR}/capture_css.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'vue') {
        success = await run('node', [`${SCRIPTS_DIR}/capture_vue.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'php') {
        success = await run('php', [`${SCRIPTS_DIR}/capture_php.php`, ...passThroughArgs]) && success
      } else if (stack === 'perl') {
        success = await run('perl', [`${SCRIPTS_DIR}/capture_perl.pl`, ...passThroughArgs]) && success
      } else if (stack === 'haskell') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_haskell.sh`, ...passThroughArgs]) && success
      } else if (stack === 'tcl') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_tcl.sh`, ...passThroughArgs]) && success
      } else if (stack === 'ruby') {
        success = await run('ruby', [`${SCRIPTS_DIR}/capture_ruby.rb`, ...passThroughArgs]) && success
      } else if (stack === 'csharp') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_csharp.sh`, 'capture', ...passThroughArgs]) && success
      } else if (stack === 'lua') {
        success = await run('lua', [`${SCRIPTS_DIR}/capture_lua.lua`, ...passThroughArgs]) && success
      } else if (stack === 'rust') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'capture', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'capture', ...passThroughArgs]) && success
      } else if (stack === 'cpp') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_cpp.sh`, ...passThroughArgs]) && success
      } else if (stack === 'bash') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_bash.sh`, ...passThroughArgs]) && success
      } else if (stack === 'awk') {
        success = await run('node', [`${SCRIPTS_DIR}/capture_awk.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'scala') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_scala.sh`, 'capture', ...passThroughArgs]) && success
      } else if (stack === 'c') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_c.sh`, ...passThroughArgs]) && success
      } else if (stack === 'nim') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_nim.sh`, ...passThroughArgs]) && success
      } else if (stack === 'julia') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_julia.sh`, ...passThroughArgs]) && success
      } else if (stack === 'java') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_java.sh`, ...passThroughArgs]) && success
      } else if (stack === 'jq') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_jq.sh`, ...passThroughArgs]) && success
      } else if (stack === 'make') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_make.sh`, ...passThroughArgs]) && success
      } else if (stack === 'sql') {
        success = await run('node', [`${SCRIPTS_DIR}/capture_sql.mjs`, ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'validate': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'css') {
        success = await run('node', [`${SCRIPTS_DIR}/validate.js`, ...passThroughArgs]) && success
      } else if (stack === 'vue') {
        success = await run('node', [`${SCRIPTS_DIR}/validate_vue.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'react') {
        // React components must be re-rendered via renderToStaticMarkup and
        // fingerprinted against the rendered HTML. validate.js cannot do this
        // — it would import the component and call it as a function, returning
        // a React element object whose fingerprint never matches the captured
        // HTML. Route to validate_react.mjs instead.
        success = await run('node', [`${SCRIPTS_DIR}/validate_react.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = await run('python3', [`${SCRIPTS_DIR}/validate.py`, ...passThroughArgs]) && success
      } else if (stack === 'php') {
        success = await run('php', [`${SCRIPTS_DIR}/validate_php.php`, ...passThroughArgs]) && success
      } else if (stack === 'perl') {
        success = await run('perl', [`${SCRIPTS_DIR}/validate_perl.pl`, ...passThroughArgs]) && success
      } else if (stack === 'haskell') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_haskell.sh`, ...passThroughArgs]) && success
      } else if (stack === 'tcl') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_tcl.sh`, ...passThroughArgs]) && success
      } else if (stack === 'ruby') {
        success = await run('ruby', [`${SCRIPTS_DIR}/validate_ruby.rb`, ...passThroughArgs]) && success
      } else if (stack === 'csharp') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_csharp.sh`, ...passThroughArgs]) && success
      } else if (stack === 'lua') {
        success = await run('lua', [`${SCRIPTS_DIR}/validate_lua.lua`, ...passThroughArgs]) && success
      } else if (stack === 'rust') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'cpp') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_cpp.sh`, ...passThroughArgs]) && success
      } else if (stack === 'bash') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_bash.sh`, ...passThroughArgs]) && success
      } else if (stack === 'awk') {
        success = await run('node', [`${SCRIPTS_DIR}/validate_awk.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'scala') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_scala.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'c') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_c.sh`, ...passThroughArgs]) && success
      } else if (stack === 'nim') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_nim.sh`, ...passThroughArgs]) && success
      } else if (stack === 'julia') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_julia.sh`, ...passThroughArgs]) && success
      } else if (stack === 'java') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_java.sh`, ...passThroughArgs]) && success
      } else if (stack === 'jq') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_jq.sh`, ...passThroughArgs]) && success
      } else if (stack === 'make') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_make.sh`, ...passThroughArgs]) && success
      } else if (stack === 'sql') {
        success = await run('node', [`${SCRIPTS_DIR}/validate_sql.mjs`, ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'health': {
    success = await run('node', [`${SCRIPTS_DIR}/health.js`, ...passThroughArgs])
    break
  }

  case 'update': {
    // Find which stack the target cluster belongs to
    const targetCluster = passThroughArgs.find(a => !a.startsWith('-'))
    const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
    let targetStack = 'js'
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const cluster = manifest.clusters.find(c => c.id === targetCluster)
      if (cluster) targetStack = cluster.stack || 'js'
    } catch { /* default to js */ }

    // Update the translation rules comment to include React (validate_react.mjs
    // follows the same --update <id> shape as Python/PHP/Rust/Go, NOT the
    // --update --cluster <id> shape used by validate.js).
    //
    // Translation rules (when the user did NOT already pass --update):
    //   `regret update <id> --reason "..."` (positional id)
    //     → JS/TS/CSS (validate.js): `--update --cluster <id> --reason "..."`
    //         validate.js treats --update as a bare flag (its presence
    //         triggers update mode; the cluster id comes from --cluster).
    //     → Python/PHP/Rust/Go/React: `--update <id> --reason "..."`
    //         validate_react.mjs (and the others) expect the cluster id as
    //         the VALUE of --update.
    //
    // If the user already provided --update (advanced usage), pass through
    // as-is to avoid double-inserting the flag.
    let translatedArgs
    if (passThroughArgs.includes('--update')) {
      // User explicitly passed --update — respect their args verbatim.
      translatedArgs = passThroughArgs
    } else if (targetCluster) {
      // Strip the positional id from passThroughArgs, then re-add it in
      // the stack-specific --update position.
      const remainingArgs = passThroughArgs.filter(a => a !== targetCluster)
      // Vue uses the same `--update <id> --reason` form as Python/PHP/Rust/Go
      // (validate_vue.mjs expects the cluster id as the VALUE of --update,
      // mirroring validate.py / validate_php.php).
      if (targetStack === 'python' || targetStack === 'php' || targetStack === 'ruby' || targetStack === 'csharp' || targetStack === 'rust' || targetStack === 'go' || targetStack === 'c' || targetStack === 'lua' || targetStack === 'vue' || targetStack === 'nim' || targetStack === 'perl' || targetStack === 'react' || targetStack === 'jq' || targetStack === 'make' || targetStack === 'haskell' || targetStack === 'tcl' || targetStack === 'julia') {
        translatedArgs = ['--update', targetCluster, ...remainingArgs]
      } else {
        translatedArgs = ['--update', '--cluster', targetCluster, ...remainingArgs]
      }
    } else {
      // No positional target and no --update flag (rare — e.g. user typed
      // `regret update --reason "..."` with no cluster). Just prepend
      // --update; validate.js will emit its own "missing cluster" error.
      translatedArgs = ['--update', ...passThroughArgs]
    }

    if (targetStack === 'python') {
      success = await run('python3', [`${SCRIPTS_DIR}/validate.py`, ...translatedArgs])
    } else if (targetStack === 'php') {
      success = await run('php', [`${SCRIPTS_DIR}/validate_php.php`, ...translatedArgs])
    } else if (targetStack === 'perl') {
      success = await run('perl', [`${SCRIPTS_DIR}/validate_perl.pl`, ...translatedArgs])
    } else if (targetStack === 'haskell' || targetStack === 'tcl') {
      success = await run('bash', [`${SCRIPTS_DIR}/validate_haskell.sh`, ...translatedArgs])
    } else if (targetStack === 'tcl') {
      success = await run('bash', [`${SCRIPTS_DIR}/validate_tcl.sh`, ...translatedArgs])
    } else if (targetStack === 'ruby') {
      success = await run('ruby', [`${SCRIPTS_DIR}/validate_ruby.rb`, ...translatedArgs])
    } else if (targetStack === 'csharp') {
      success = await run('bash', [`${SCRIPTS_DIR}/validate_csharp.sh`, ...translatedArgs])
    } else if (targetStack === 'lua') {
      success = await run('lua', [`${SCRIPTS_DIR}/validate_lua.lua`, ...translatedArgs])
    } else if (targetStack === 'rust') {
      success = await run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate', ...translatedArgs])
    } else if (targetStack === 'go') {
      success = await run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate', ...translatedArgs])
    } else if (targetStack === 'css') {
      // validate_css.mjs expects --update <id> --reason "..." (same shape as
      // PHP/Rust/Go/React) — strip the bare --update flag if present.
      const validateArgs = translatedArgs.includes('--update')
        ? translatedArgs.filter(a => a !== '--update')
        : translatedArgs
      success = await run('node', [`${SCRIPTS_DIR}/validate_css.mjs`, ...validateArgs])
    } else if (targetStack === 'bash') {
      // Bash update mode: re-capture then validate (audit.log not yet supported for bash)
      // For now, dispatch to validate_bash.sh which will re-validate after manual re-capture
      success = await run('bash', [`${SCRIPTS_DIR}/validate_bash.sh`, ...translatedArgs])
    } else if (targetStack === 'scala') {
      success = await run('bash', [`${SCRIPTS_DIR}/capture_scala.sh`, 'validate', ...translatedArgs])
    } else if (targetStack === 'c') {
      success = await run('bash', [`${SCRIPTS_DIR}/validate_c.sh`, ...translatedArgs])
    } else if (targetStack === 'vue') {
      success = await run('node', [`${SCRIPTS_DIR}/validate_vue.mjs`, ...translatedArgs])
    } else if (targetStack === 'nim') {
      success = await run('bash', [`${SCRIPTS_DIR}/validate_nim.sh`, ...translatedArgs])
    } else if (targetStack === 'react') {
      // validate_react.mjs expects --update <id> --reason "..." (same shape as
      // Python/PHP/Rust/Go), so it goes through the same translatedArgs path.
      success = await run('node', [`${SCRIPTS_DIR}/validate_react.mjs`, ...translatedArgs])
    } else if (targetStack === 'jq') {
      success = await run('bash', [`${SCRIPTS_DIR}/validate_jq.sh`, ...translatedArgs])
    } else if (targetStack === 'make') {
      success = await run('bash', [`${SCRIPTS_DIR}/validate_make.sh`, ...translatedArgs])
    } else if (targetStack === 'julia') {
      // Julia harness does NOT support --update mode yet (parity gap with JS/Python/Bash/Perl/C++).
      // Print a clear error message instead of silently doing nothing.
      console.error('Julia stack does not yet support --update mode.')
      console.error('  Workaround: re-capture with `regret capture --cluster ' + targetCluster + '`')
      console.error('             then commit the new .regret file with a reason in the commit message.')
      success = false
    } else if (targetStack === 'cpp') {
      // C++ harness supports `update` mode natively (parity with JS/Python/Bash/Perl).
      // regret.js's translatedArgs always starts with --update (added above);
      // the C++ runner doesn't accept --update as a bare flag — it dispatches on
      // the mode word. So we strip the leading --update/--cluster pair and pass
      // `update --cluster <id> --reason "..."` to validate_cpp.sh.
      const cppArgs = [...translatedArgs]
      // Remove leading --update (added by regret.js translation).
      const updateIdx = cppArgs.indexOf('--update')
      if (updateIdx !== -1) cppArgs.splice(updateIdx, 1)
      // If the next arg is the cluster id (positional form), prefix with --cluster.
      // regret.js translation already uses `--update --cluster <id> --reason "..."` form
      // for the JS branch, but for C++ we use `--update <id>` form (Python/PHP/Rust/Go).
      // Strip a leading --cluster if present (added by JS-branch translation) since
      // the C++ runner accepts --cluster directly.
      success = await run('bash', [`${SCRIPTS_DIR}/validate_cpp.sh`, 'update', ...cppArgs])
    } else {
      // js, ts, css all use validate.js
      success = await run('node', [`${SCRIPTS_DIR}/validate.js`, ...translatedArgs])
    }
    break
  }

  case 'drift': {
    const stacks = detectStacks()
    // Pass --drift-mode so validate.js knows to use driftRuns || 5 as default
    // If user explicitly provides --runs, it takes priority over driftRuns
    const driftDefault = passThroughArgs.includes('--runs')
      ? []  // user provided --runs, don't add default
      : ['--drift-mode']
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'css') {
        success = await run('node', [`${SCRIPTS_DIR}/validate.js`, ...driftDefault, ...passThroughArgs]) && success
      } else if (stack === 'vue') {
        success = await run('node', [`${SCRIPTS_DIR}/validate_vue.mjs`, ...driftDefault, ...passThroughArgs]) && success
      } else if (stack === 'react') {
        // Drift detection for React: validate_react.mjs --runs N re-renders
        // each captured component N times and flags clusters whose hash
        // differs across runs (sign of non-deterministic render).
        success = await run('node', [`${SCRIPTS_DIR}/validate_react.mjs`, ...driftDefault, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = await run('python3', [`${SCRIPTS_DIR}/validate.py`, ...driftDefault, ...passThroughArgs]) && success
      } else if (stack === 'php') {
        success = await run('php', [`${SCRIPTS_DIR}/validate_php.php`, ...driftDefault, ...passThroughArgs]) && success
      } else if (stack === 'perl') {
        console.log(`  ⏭️  Perl drift detection: not yet supported (perl output is deterministic by default)`)
      } else if (stack === 'haskell') {
        console.log(`  ⏭️  Haskell drift detection: not yet supported (haskell is pure FP — deterministic by default)`)
      } else if (stack === 'tcl') {
        console.log(`  ⏭️  Tcl drift detection: not yet supported (tcl output is deterministic by default)`)
      } else if (stack === 'ruby') {
        success = await run('ruby', [`${SCRIPTS_DIR}/validate_ruby.rb`, ...driftDefault, ...passThroughArgs]) && success
      } else if (stack === 'csharp') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_csharp.sh`, ...driftDefault, ...passThroughArgs]) && success
      } else if (stack === 'lua') {
        console.log(`  ⏭️  Lua drift detection: run validate_lua.lua --runs manually (drift mode not yet implemented)`)
      } else if (stack === 'rust') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        console.log(`  ⏭️  Go drift detection: run capture_go.sh with --runs flag manually`)
      } else if (stack === 'bash') {
        console.log(`  ⏭️  Bash drift detection: not yet supported (bash output is deterministic by default)`)
      } else if (stack === 'scala') {
        // Scala drift detection: run validate with multiple runs; each run
        // re-invokes the function. Pure functions should produce identical
        // fingerprints every time.
        console.log(`  ⏭️  Scala drift detection: run \`capture_scala.sh validate --runs N\` manually`)
      } else if (stack === 'c') {
        console.log(`  ⏭️  C drift detection: run validate_c.sh with --runs flag manually`)
      } else if (stack === 'nim') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_nim.sh`, ...passThroughArgs]) && success
      } else if (stack === 'jq') {
        console.log(`  ⏭️  jq drift detection: jq output is deterministic; use --runs manually if needed`)
      } else if (stack === 'make') {
        console.log(`  ⏭️  Make drift detection: make output is deterministic; use --runs manually if needed`)
      }
    }
    break
  }

  case 'ci': {
    console.warn('⚠️  DEPRECATED: `regret ci` is replaced by `regret validate --fail-fast`')
    console.warn('   `regret validate --fail-fast` is functionally identical and is the')
    console.warn('   standard CI/CD gate. Falling back to ci...\n')
    if (passThroughArgs.includes('--init')) {
      // Generate GitHub Actions workflow file
      const ciArgs = passThroughArgs.filter(a => a !== '--init')
      success = await run('node', [`${SCRIPTS_DIR}/ci-init.js`, ...ciArgs])
      break
    }
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = await run('node', [`${SCRIPTS_DIR}/validate.js`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'css') {
        success = await run('node', [`${SCRIPTS_DIR}/validate_css.mjs`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'vue') {
        success = await run('node', [`${SCRIPTS_DIR}/validate_vue.mjs`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = await run('python3', [`${SCRIPTS_DIR}/validate.py`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'php') {
        success = await run('php', [`${SCRIPTS_DIR}/validate_php.php`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'perl') {
        success = await run('perl', [`${SCRIPTS_DIR}/validate_perl.pl`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'haskell') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_haskell.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'tcl') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_tcl.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'ruby') {
        success = await run('ruby', [`${SCRIPTS_DIR}/validate_ruby.rb`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'csharp') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_csharp.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'lua') {
        success = await run('lua', [`${SCRIPTS_DIR}/validate_lua.lua`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'rust') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'bash') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_bash.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'scala') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_scala.sh`, 'validate', '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'c') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_c.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'nim') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_nim.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'jq') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_jq.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'make') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_make.sh`, '--fail-fast', ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'check': {
    // Pre-flight manifest validation — verifies exports exist in compiled output
    const stacksForCheck = detectStacks()
    if (stacksForCheck.includes('python')) {
      success = await run('python3', [`${SCRIPTS_DIR}/check.py`, ...passThroughArgs])
    } else {
      // Full JS pre-flight: import module, verify entries exist
      success = await run('node', [`${SCRIPTS_DIR}/check.js`, ...passThroughArgs])
    }
    break
  }

  case 'truth': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react' || stack === 'css') {
        success = await run('node', [`${SCRIPTS_DIR}/truth.js`, ...passThroughArgs]) && success
      } else if (stack === 'vue') {
        console.log(`  ⏭️  Vue truth capture: not yet supported — use node scripts/validate_vue.mjs --runs 5 for drift detection`)
      } else if (stack === 'python') {
        success = await run('python3', [`${SCRIPTS_DIR}/truth.py`, ...passThroughArgs]) && success
      } else if (stack === 'php') {
        success = await run('php', [`${SCRIPTS_DIR}/truth_php.php`, ...passThroughArgs]) && success
      } else if (stack === 'perl') {
        console.log(`  ⏭️  Perl truth capture: not yet supported — use regret capture + regret validate instead`)
      } else if (stack === 'haskell') {
        console.log(`  ⏭️  Haskell truth capture: not yet supported — use regret capture + regret validate instead`)
      } else if (stack === 'tcl') {
        console.log(`  ⏭️  Tcl truth capture: not yet supported — use regret capture + regret validate instead`)
      } else if (stack === 'ruby') {
        console.log(`  ⏭️  Ruby truth capture: not yet supported — use ruby scripts/capture_ruby.rb + ruby scripts/validate_ruby.rb --runs 5 for now`)
      } else if (stack === 'csharp') {
        console.log(`  ⏭️  C# truth capture: not yet supported — use bash scripts/validate_csharp.sh --runs 5 for drift detection`)
      } else if (stack === 'lua') {
        console.log(`  ⏭️  Lua truth capture: not yet supported (use regret capture/validate for Lua clusters)`)
      } else if (stack === 'rust') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'bash') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_bash.sh`, ...passThroughArgs]) && success
      } else if (stack === 'scala') {
        // Truth capture for Scala delegates to validate (which re-runs and re-records).
        // For now, this is a no-op: Scala truth capture would need a separate truth_scala.ts.
        console.log(`  ⏭️  Scala truth capture not yet supported — use \`regret capture\` instead`)
      } else if (stack === 'c') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_c.sh`, ...passThroughArgs]) && success
      } else if (stack === 'nim') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_nim.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'jq') {
        console.log(`  ⏭️  jq truth capture: not yet supported — use bash scripts/validate_jq.sh for validation`)
      } else if (stack === 'make') {
        console.log(`  ⏭️  Make truth capture: not yet supported — use bash scripts/validate_make.sh for validation`)
      } else {
        console.log(`  ⏭️  Stack "${stack}" — truth capture not yet supported`)
      }
    }
    break
  }

  case 'rollback': {
    const targetCluster = passThroughArgs.find(a => !a.startsWith('-'))
    if (!targetCluster) {
      console.error('❌ Usage: regret rollback <cluster-id>')
      process.exit(1)
    }
    console.log(`\n🔄 Rolling back: ${targetCluster}`)
    console.log('   Re-capturing fingerprint with current code...\n')
    // Detect stack for the target cluster so we dispatch to the right
    // capture/validate scripts (vue has its own; react uses capture_react.mjs + validate.js).
    const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
    let targetStack = 'js'
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const cluster = manifest.clusters.find(c => c.id === targetCluster)
      if (cluster) targetStack = cluster.stack || 'js'
    } catch { /* default to js */ }

    if (targetStack === 'vue') {
      success = await run('node', [`${SCRIPTS_DIR}/capture_vue.mjs`, '--cluster', targetCluster]) && success
      if (success) {
        success = await run('node', [`${SCRIPTS_DIR}/validate_vue.mjs`, '--cluster', targetCluster]) && success
      }
    } else if (targetStack === 'react') {
      success = await run('node', [`${SCRIPTS_DIR}/capture_react.mjs`, '--cluster', targetCluster]) && success
      if (success) {
        success = await run('node', [`${SCRIPTS_DIR}/validate.js`, '--cluster', targetCluster]) && success
      }
    } else {
      success = await run('node', [`${SCRIPTS_DIR}/capture.js`, '--cluster', targetCluster]) && success
      if (success) {
        success = await run('node', [`${SCRIPTS_DIR}/validate.js`, '--cluster', targetCluster]) && success
      }
    }
    break
  }

  case 'diff': {
    const diffStacks = detectStacks()
    let diffOk = true
    for (const stack of diffStacks) {
      if (stack === 'python') {
        diffOk = (await run('python3', [`${SCRIPTS_DIR}/diff.py`, ...passThroughArgs])) && diffOk
      } else {
        diffOk = (await run('node', [`${SCRIPTS_DIR}/diff.js`, ...passThroughArgs])) && diffOk
      }
    }
    success = diffOk
    break
  }

  case 'list': {
    success = await run('node', [`${SCRIPTS_DIR}/list.js`, ...passThroughArgs])
    break
  }

  case 'history': {
    success = await run('node', [`${SCRIPTS_DIR}/history.js`, ...passThroughArgs])
    break
  }

  case 'verify-kebenaran': {
    const stacks = detectStacks()
    let kebenaranOk = true
    for (const stack of stacks) {
      if (stack === 'python') {
        kebenaranOk = (await run('python3', [`${SCRIPTS_DIR}/verify_kebenaran.py`, ...passThroughArgs])) && kebenaranOk
      } else {
        kebenaranOk = (await run('node', [`${SCRIPTS_DIR}/verify_kebenaran.js`, ...passThroughArgs])) && kebenaranOk
      }
    }
    success = kebenaranOk
    break
  }

  case 'chain': {
    // contest.mjs / contest.py expect the mode as a FLAG (--capture / --validate),
    // but `regret chain capture` / `regret chain validate` passes it as a bare
    // positional word. Translate here so the mode is never silently ignored
    // (without this, --capture never matches and chain testing always falls
    // through to validate mode, even when the user asked to capture).
    let chainArgs = passThroughArgs
    if (chainArgs[0] === 'capture' || chainArgs[0] === 'validate') {
      chainArgs = [`--${chainArgs[0]}`, ...chainArgs.slice(1)]
    }
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react' || stack === 'css') {
        success = await run('node', [`${SCRIPTS_DIR}/contest.mjs`, ...chainArgs]) && success
      } else if (stack === 'python') {
        success = await run('python3', [`${SCRIPTS_DIR}/contest.py`, ...chainArgs]) && success
      } else if (stack === 'php') {
        console.log(`  ⏭️  PHP chain testing: use regret chain with JS/Python stacks for now — PHP chain support coming soon`)
      } else if (stack === 'lua') {
        console.log(`  ⏭️  Lua chain testing: not yet supported — use regret capture/validate for Lua clusters`)
      } else if (stack === 'perl') {
        console.log(`  ⏭️  Perl chain testing: not yet supported — use regret chain with JS/Python stacks for now`)
      } else if (stack === 'haskell') {
        console.log(`  ⏭️  Haskell chain testing: not yet supported — use regret chain with JS/Python stacks for now`)
      } else if (stack === 'tcl') {
        console.log(`  ⏭️  Tcl chain testing: not yet supported — use regret chain with JS/Python stacks for now`)
      }
    }
    break
  }

  case 'setup': {
    success = await run('node', [`${SCRIPTS_DIR}/setup.js`, ...passThroughArgs])
    break
  }

  case 'scan': {
    console.warn('⚠️  DEPRECATED: `regret scan` is replaced by `regret install --dry-run`')
    console.warn('   `regret install --dry-run` discovers all exported functions and previews')
    console.warn('   the manifest without writing or capturing. Falling back to scan...\n')
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react' || stack === 'css') {
        success = await run('node', [`${SCRIPTS_DIR}/scan.js`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = await run('python3', [`${SCRIPTS_DIR}/scan.py`, ...passThroughArgs]) && success
      } else {
        // Default to JS scanner for unknown stacks
        success = await run('node', [`${SCRIPTS_DIR}/scan.js`, ...passThroughArgs]) && success
      }
    }
    // If --decompose flag is passed but no stack detected, run Python scanner
    if (passThroughArgs.includes('--decompose') && !success) {
      // Try Python scanner with the --decompose flag directly
      const dirArg = passThroughArgs.find(a => !a.startsWith('-'))
      if (dirArg) {
        success = await run('python3', [`${SCRIPTS_DIR}/scan.py`, dirArg, '--decompose'])
      }
    }
    break
  }

  case 'structure': {
    console.warn('⚠️  DEPRECATED: `regret structure` is replaced by `regret analyze` for Python projects')
    console.warn('   `regret analyze` (analyze.py) provides deep structural analysis including god')
    console.warn('   functions, duplicates, and cross-module dependencies — but Python-only today.')
    console.warn('   For JS/TS/other stacks, `structure` remains the supported tool. Falling back...\n')
    success = await run('node', [`${SCRIPTS_DIR}/structure.js`, ...passThroughArgs])
    break
  }

  case 'coverage': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react' || stack === 'css') {
        success = await run('node', [`${SCRIPTS_DIR}/coverage.js`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = await run('python3', [`${SCRIPTS_DIR}/coverage.py`, ...passThroughArgs]) && success
      } else {
        // Default to JS coverage for unknown stacks
        success = await run('node', [`${SCRIPTS_DIR}/coverage.js`, ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'branch-map': {
    console.warn('⚠️  DEPRECATED: `regret branch-map` is replaced by `regret coverage --suggest-inputs`')
    console.warn('   `regret coverage --suggest-inputs` provides branch coverage analysis with')
    console.warn('   input suggestions and is more flexible. Falling back to branch-map...\n')
    success = await run('node', [`${SCRIPTS_DIR}/branch-map.js`, ...passThroughArgs])
    break
  }

  case 'audit': {
    console.warn('⚠️  DEPRECATED: `regret audit` is replaced by `regret status`')
    console.warn('   `regret status` provides a comprehensive snapshot of whether it is safe')
    console.warn('   to refactor. Falling back to audit...\n')
    const stacksForAudit = detectStacks()
    if (stacksForAudit.includes('python')) {
      success = await run('python3', [`${SCRIPTS_DIR}/audit.py`, ...passThroughArgs])
    } else {
      success = await run('node', [`${SCRIPTS_DIR}/audit.js`, ...passThroughArgs])
    }
    break
  }

  case 'analyze': {
    // analyze.py is a Python-only AST analyzer (#505) — it has no awareness
    // of other stacks and will just report "No Python functions found" on
    // a JS/TS/etc. project, which looks like a tool bug rather than a
    // scope limitation. Warn explicitly so users aren't misled, and point
    // them at `structure` (the JS-aware equivalent) instead.
    const stacksForAnalyze = detectStacks()
    if (!stacksForAnalyze.includes('python')) {
      console.warn(`⚠️  \`regret analyze\` is Python-only today — this project's stack(s) (${stacksForAnalyze.join(', ')}) are not supported.`)
      console.warn('   Use `regret structure` for JS/TS structural analysis instead.\n')
    }
    success = await run('python3', [`${SCRIPTS_DIR}/analyze.py`, ...passThroughArgs])
    break
  }

  case 'diagnose': {
    console.warn('⚠️  DEPRECATED: `regret diagnose` is replaced by `regret discover --entry <fn> --file <path>`')
    console.warn('   `regret discover` uses runtime tracing for more accurate discovery.')
    console.warn('   Falling back to diagnose...\n')
    success = await run('node', [`${SCRIPTS_DIR}/diagnose.js`, ...passThroughArgs])
    break
  }

  case 'compare': {
    success = await run('node', [`${SCRIPTS_DIR}/compare.js`, ...passThroughArgs])
    break
  }

  case 'mutate-audit': {
    success = await run('python3', [`${SCRIPTS_DIR}/mutate_audit.py`, ...passThroughArgs])
    break
  }

  case 'guard': {
    console.warn('⚠️  DEPRECATED: `regret guard` is replaced by `regret validate --fail-fast`')
    console.warn('   `regret validate --fail-fast` is functionally identical and is the')
    console.warn('   standard CI/CD gate. Falling back to guard...\n')
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = await run('node', [`${SCRIPTS_DIR}/validate.js`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'css') {
        success = await run('node', [`${SCRIPTS_DIR}/validate_css.mjs`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'vue') {
        success = await run('node', [`${SCRIPTS_DIR}/validate_vue.mjs`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = await run('python3', [`${SCRIPTS_DIR}/validate.py`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'php') {
        success = await run('php', [`${SCRIPTS_DIR}/validate_php.php`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'perl') {
        success = await run('perl', [`${SCRIPTS_DIR}/validate_perl.pl`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'haskell') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_haskell.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'tcl') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_tcl.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'ruby') {
        success = await run('ruby', [`${SCRIPTS_DIR}/validate_ruby.rb`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'csharp') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_csharp.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'lua') {
        success = await run('lua', [`${SCRIPTS_DIR}/validate_lua.lua`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'rust') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        success = await run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'bash') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_bash.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'c') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_c.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'nim') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_nim.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'jq') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_jq.sh`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'make') {
        success = await run('bash', [`${SCRIPTS_DIR}/validate_make.sh`, '--fail-fast', ...passThroughArgs]) && success
      }
    }
    if (success) {
      console.log('\n✅ Regret guard passed — all clusters green.')
    } else {
      console.log('\n❌ Regret guard FAILED — some clusters are red.')
    }
    break
  }

  case 'watch': {
    success = await run('node', [`${SCRIPTS_DIR}/watch.js`, ...passThroughArgs])
    // watch runs until Ctrl+C — exit code is always 0 (graceful shutdown)
    success = true
    break
  }

  case 'branches': {
    console.warn('⚠️  DEPRECATED: `regret branches` is replaced by `regret coverage`')
    console.warn('   `regret coverage` provides more comprehensive branch coverage analysis')
    console.warn('   with --suggest-inputs and --verbose options. Falling back to branches...\n')
    success = await run('node', [`${SCRIPTS_DIR}/branches.js`, ...passThroughArgs])
    break
  }

  case 'risk': {
    success = await run('node', [`${SCRIPTS_DIR}/risk.js`, ...passThroughArgs])
    break
  }

  case 'discover': {
    if (passThroughArgs.includes('--static')) {
      const staticArgs = passThroughArgs.filter(a => a !== '--static')
      success = await run('node', [`${SCRIPTS_DIR}/discover-static.js`, ...staticArgs])
    } else {
      success = await run('node', [`${SCRIPTS_DIR}/discover.js`, ...passThroughArgs])
    }
    break
  }

  case 'uninstall': {
    success = await run('node', [`${SCRIPTS_DIR}/uninstall.js`, ...passThroughArgs])
    break
  }

  case 'status': {
    success = await run('node', [`${SCRIPTS_DIR}/status.js`, ...passThroughArgs])
    break
  }

  case 'help':
  default:
    console.log(`
regret.js — Unified Regret Runner

INSTALL WORKFLOW:
  regret install [--dir src/] [--stack js] [--depth 3]  Auto-discover + capture entire project
                         [--dry-run]                  Preview only, no write/capture
                         [--skip-capture]             Write manifest, skip capture
                         [--scope <path>]            Target a specific file, dir, or workspace
  regret validate [--cluster <id>]                   Verify all GREEN
  regret status [--json]                             Snapshot: safe to refactor?
  regret uninstall [--keep-manifest]                 Clean up safety net

MANUAL WORKFLOW:
  regret init --stack <js|python|php|go|css>         Initialize regrets/ directory
  regret capture [--cluster <id>]                    Capture fingerprints
                    [--only-new]                     Only capture clusters without .regret files
                    [--stale [hours]]                Re-capture clusters older than N hours (default: 24)
  regret check [--cluster <id>]                      Pre-flight manifest validation
  regret drift [--cluster <id>]                      Drift detection (5 runs)
  regret update <id> --reason "..."                  Safe update with audit trail
  regret validate --fail-fast                        CI/CD gate (replaces regret ci + regret guard)

ANALYSIS:
  regret coverage [--cluster <id>] [--suggest-inputs] [--verbose] [--json]   Branch coverage
  regret health [--sort fragile] [--json]            Cluster health + confidence
  regret risk [--since HEAD~1] [--diff patch.txt] [--json]   Pre-refactor risk signal
  regret discover --entry <fn> --file <path>         Single-function discovery
                    [--inputs '[null, {}]']           Custom inputs (JSON array)
                    [--out regrets/manifest.json]     Write to file (default: stdout)
  regret discover --static --entry <fn> --file <path>  Zero-execution static analysis
  regret diff [--cluster <id>]                       Show diff on FAIL
  regret list [--json]                               List all clusters
  regret history <clusterId> [--json] [--limit N]    Audit log of contract updates
  regret history --all                               Show events for every cluster
  regret analyze [dir] [--json]                      Deep structural analysis

UTILITIES:
  regret rollback <id>                               Rollback cluster (re-capture + validate)
  regret setup [--stack js|python|ts]                One-command onboarding (scan→check→capture→validate)
                    [--dry-run]                       Preview steps without executing
                    [--skip-build]                    Skip preBuild step
  regret watch [--dir src/] [--stack]                Watch files & auto-validate on change
  regret compare --pre <dir> --post <dir>            Compare pre vs post truth baselines
  regret mutate-audit <path>                         Detect functions that mutate input args
  regret ci --init [--force]                         Generate GitHub Actions workflow

ADVANCED:
  regret truth [--outdir <dir>]                      Save dual truth baselines (JS+Python)
  regret verify-kebenaran                            Verify KEBENARAN 1 vs KEBENARAN 2
  regret chain [--capture|--validate]                Chain testing (multi-step flows, JS+Python+PHP)

DEPRECATED (still work, but use the replacement instead):
  regret scan          → regret install --dry-run
  regret branches      → regret coverage
  regret audit         → regret status
  regret ci            → regret validate --fail-fast
  regret guard         → regret validate --fail-fast
  regret branch-map    → regret coverage --suggest-inputs
  regret diagnose      → regret discover --entry <fn> --file <path>
  regret structure     → regret analyze

Global flags:
  --skip-build        Skip preBuild step (use when project is already built)
  --json              Output in machine-readable JSON (validate, health, coverage, scan, branches, status)
  --quiet             Only print summary line (capture, validate)
  --verbose           Print extra detail — inputs, outputs, call traces (capture, validate)
                      --quiet and --verbose are mutually exclusive (quiet wins)

Capture flags:
  --only-new          Only capture clusters that don't yet have a .regret file
  --stale [hours]     Re-capture clusters whose .regret is older than N hours (default: 24)
  --cluster <id>      Capture a specific cluster (overrides --only-new / --stale)
  These flags can be combined: --only-new --stale 48

Error path contracts (expectThrow):
  In manifest inputs, use { "__expectThrow": true, "value": <input> } to declare
  that a function MUST throw for that input. capture.js catches the error and
  fingerprints { type: ErrorClass, message: normalizedMessage } as ERROR_CONTRACT.
  validate.js FAILs if the function stops throwing or the error type/message changes.
  Supports sync throw and async rejection (Promise.reject / async throw).

Fingerprint levels (fingerprintLevel in manifest):
  "entry"  — hash output only (default). Blind to internal call count bugs.
  "calls"  — hash { fn, count } pairs: which functions called + how many times.
             Middle ground: detects double-call bugs but survives internal refactors.
             Falls back to "entry" with warning if watches is empty.
  "full"   — hash entire call sequence including args and results per call.
             Strictest: any internal change will FAIL.

Auto-detects stack from manifest.json and dispatches to the right handler:
  js/ts/css → capture.js / validate.js
  python  → capture.py / validate.py / truth.py
  php     → capture_php.php / validate_php.php
  lua     → capture_lua.lua / validate_lua.lua (pure-Lua SHA-256, no deps)
  react   → capture_react.mjs / validate.js
  rust    → capture_rust.sh (capture + validate via cargo test)
  go      → capture_go.sh (Community Preview)
  bash    → capture_bash.sh / validate_bash.sh (Community Preview)
`)
    break
}

  process.exit(success ? 0 : 1)
}

// Launch the async main loop. Any rejection (e.g. from spawn error) falls
// back to a non-zero exit so CI gates fail loudly.
main().catch((err) => {
  console.error(`❌ regret: ${err.message}`)
  process.exit(1)
})
