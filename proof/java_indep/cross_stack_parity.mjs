import { fingerprint } from '../../scripts/fingerprint.js'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const REGRET_DIR = new URL('./regrets/', import.meta.url).pathname
const files = readdirSync(REGRET_DIR).filter(f => f.endsWith('.regret'))

let allMatch = true
for (const file of files) {
  const content = readFileSync(join(REGRET_DIR, file), 'utf8')
  const inputMatch = content.match(/^INPUT\s+(.*)$/m)
  const outputMatch = content.match(/^OUTPUT\s+(.*)$/m)
  const hashMatch = content.match(/^HASH\s+(\S+)/m)
  const clusterMatch = content.match(/^cluster:\s*(\S+)/m)

  const input = JSON.parse(inputMatch[1])
  const output = JSON.parse(outputMatch[1])
  const javaHash = hashMatch[1]
  const cluster = clusterMatch ? clusterMatch[1] : file.replace('.regret', '')

  const jsHash = fingerprint(input, output)
  const match = javaHash === jsHash
  if (!match) allMatch = false
  console.log(`${match ? '✅' : '❌'} ${cluster.padEnd(20)} Java=${javaHash}  JS=${jsHash}  ${match ? 'match' : 'MISMATCH'}`)
}
console.log()
console.log(allMatch ? '✅ All fingerprints match — cross-stack parity verified.' : '❌ MISMATCH detected!')
process.exit(allMatch ? 0 : 1)
