#!/usr/bin/env node
// cjs-wrapper.js — Generate wrapper modules for CJS parameterized libraries
// Creates thin adapter files that bake mode/config into the call,
// making parameterized CJS functions fingerprintable by Regrets.
//
// Usage:
//   node scripts/cjs-wrapper.js \
//     --source ./general-use.js \
//     --function encode \
//     --output regrets/adapters/general-use-encode-black-speech.js \
//     --options '{"language":"black-speech"}' \
//     --export-name encodeBlackSpeech
//
// This generates:
//   "use strict";
//   var _src = require("../general-use");
//   module.exports = function encodeBlackSpeech(text) {
//       return _src.encode(text, {"language":"black-speech"});
//   };

import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args = process.argv.slice(2)
const source = getArg(args, '--source')
const fn = getArg(args, '--function')
const output = getArg(args, '--output')
const optionsStr = getArg(args, '--options') || '{}'
const exportName = getArg(args, '--export-name') || fn

if (!source || !fn || !output) {
  console.error(`Usage: node scripts/cjs-wrapper.js --source <file> --function <name> --output <file> [--options <json>] [--export-name <name>]`)
  console.error(``)
  console.error(`Generates a thin CJS wrapper module that bakes options into a function call.`)
  console.error(`The wrapper makes parameterized CJS functions fingerprintable by Regrets.`)
  console.error(``)
  console.error(`Options:`)
  console.error(`  --source       Path to the source CJS module (relative to project root)`)
  console.error(`  --function     Name of the function to wrap`)
  console.error(`  --output       Path for the generated wrapper module`)
  console.error(`  --options      JSON string of options to bake into the call (default: {})`)
  console.error(`  --export-name  Name for the exported function (default: same as --function)`)
  process.exit(1)
}

// Compute relative path from output dir to source
const outputDir = dirname(resolve(process.cwd(), output))
const sourceAbs = resolve(process.cwd(), source)
const relativePath = sourceAbs.replace(outputDir + '/', '../').replace(outputDir, '../')

const optionsObj = JSON.parse(optionsStr)
const optionsInline = JSON.stringify(optionsObj)

const content = `"use strict";
var _src = require("${relativePath}");
module.exports = function ${exportName}(input) {
    return _src.${fn}(input, ${optionsInline});
};
`

// Ensure output directory exists
mkdirSync(dirname(resolve(process.cwd(), output)), { recursive: true })

writeFileSync(resolve(process.cwd(), output), content, 'utf8')
console.log(`✅ Generated: ${output}`)
console.log(`   Wraps: ${source}#${fn}`)
console.log(`   Options: ${optionsInline}`)
console.log(`   Export: module.exports = ${exportName}`)
