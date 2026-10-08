/**
 * 打包脚本：把插件源码按发布约定落进一个独立的暂存目录。
 *
 * 与 `faces/scripts/build.mjs` / `image-similarity/scripts/build.mjs` 同一形状（发布流水线要求
 * 一致）：把 `src/` 拷成 `dist/`，并把 manifest 的 `runtime.entry` 改写成 `dist/index.mjs`。
 * 本插件零依赖、没有需要转译的原生模块，所以这里不做转译——但**不能**因此省掉这一步：签名包里的
 * 入口必须是 `dist/` 下的路径，和其它官方插件保持一致。
 *
 * 注意 `scripts/` 与 `tests/` **不进包**：它们引用 `onnxruntime-node` 与模型目录，装到用户机器上
 * 没有意义，而且 `probe.mjs` 会在启动时去碰文件系统。包内只有 `src/` 的运行时代码。
 *
 * 用法：`node scripts/build.mjs --out <staging-dir>`（暂存目录必须与插件目录不同）。
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const flag = process.argv.indexOf('--out')
if (flag < 0 || !process.argv[flag + 1]) {
  throw new Error('Usage: node scripts/build.mjs --out <scratch-package-directory>')
}
const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(process.argv[flag + 1])
if (out === resolve(root)) throw new Error('Use a separate staging directory')

mkdirSync(join(out, 'dist'), { recursive: true })
cpSync(join(root, 'src'), join(out, 'dist'), { recursive: true })
cpSync(join(root, 'README.md'), join(out, 'README.md'))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
manifest.runtime.entry = 'dist/index.mjs'
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(out)
