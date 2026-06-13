#!/usr/bin/env node
// regret — CLI for regret-based regression testing
// Install globally: npm link (from the regret-testing package dir)
// Or use: npx regret capture
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = resolve(__dirname, '..')

// Parse command
const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const passThroughArgs = args.slice(1)

// Delegate to regret.js unified runner
const { execFileSync } = await import('child_process')
try {
  execFileSync('node', [resolve(SCRIPTS_DIR, 'scripts', 'regret.js'), command, ...passThroughArgs], {
    stdio: 'inherit',
    cwd: process.cwd()
  })
  process.exit(0)
} catch {
  process.exit(1)
}
