/**
 * 探针：脚本契约。
 *
 * 浏览器半（assets/usage-cost.js）由宿主注入的 <script src> 加载，浏览器按
 * **经典脚本**解析：顶层出现任何 `import` / `export` / 顶层 `await` 都会让整页
 * 起不来（0.1.0 的真实事故：crash-*-web-boot.log 里 "Unexpected token 'export'"）。
 * 宿主半（lib/index.js）是 ESM，交给 `node --check` 按包内 "type": "module" 解析。
 *
 * 跑法：node tools/probe-syntax.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
let failures = 0

// ---- 浏览器半：必须是经典脚本 ----
const clientFile = path.join(ROOT, 'assets', 'usage-cost.js')
const clientCode = fs.readFileSync(clientFile, 'utf8')
try {
  // new Function 与浏览器解析经典脚本同口径：import/export/顶层 await 都会抛。
  // eslint-disable-next-line no-new-func
  new Function(clientCode)
  console.log('  ✓ assets/usage-cost.js 可按经典脚本解析（' + clientCode.length + ' 字节）')
} catch (err) {
  failures += 1
  console.log('  ✗ assets/usage-cost.js 经典脚本解析失败：' + err.message)
}
const topLevelEsm = /^[ \t]*(?:export|import)\s/m.exec(clientCode)
if (topLevelEsm) {
  failures += 1
  console.log('  ✗ assets/usage-cost.js 顶层出现 ' + topLevelEsm[0].trim() + '（浏览器半必须保持经典脚本）')
} else {
  console.log('  ✓ assets/usage-cost.js 无顶层 import/export')
}

// ---- 宿主半：ESM ----
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'lib', 'index.js')], { stdio: 'pipe' })
  console.log('  ✓ lib/index.js 通过 node --check（按 package.json 的 type: module 解析）')
} catch (err) {
  failures += 1
  console.log('  ✗ lib/index.js 解析失败：' + String((err.stderr || err.message) || '').trim())
}

// ---- 挂载声明 ----
const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
if (patch.includes('name: ' + pkg.name) && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) {
  console.log('  ✓ cordis.patch.yml 与 package.json 的 bundle 声明一致（' + pkg.name + '）')
} else {
  failures += 1
  console.log('  ✗ bundle 挂载声明与 package.json 不一致')
}

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
