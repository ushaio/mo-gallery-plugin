import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const index = process.argv.indexOf('--out')
if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node scripts/build.mjs --out <scratch-package-directory>')
const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(process.argv[index + 1])
if (out === resolve(root)) throw new Error('Use a separate staging directory')
mkdirSync(join(out, 'dist'), { recursive: true })
cpSync(join(root, 'src'), join(out, 'dist'), { recursive: true })
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
manifest.runtime.entry = 'dist/index.mjs'
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(out)
