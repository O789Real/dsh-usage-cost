/**
 * dsh-usage-cost —— 宿主半（Node 侧）
 * ============================================================================
 * 功能全在浏览器半（`assets/usage-cost.js`）。宿主半只做三件事：
 *
 *   ① 往页面里塞一个 `<script src="/dsh-usage-cost/client.js">`：
 *      · `webserver/index-inject` 结构化行 —— **桌面端（Electron）唯一的注入通道**
 *        （桌面壳的 index.html 从安装包静态 dist 直读，永不经过宿主 renderIndex）；
 *      · `webServer.tapIndex` —— 浏览器访问 `http://127.0.0.1:<port>/` 时的通道。
 *      两条并存、浏览器半自带幂等守卫，重复注入只跑第一份。
 *
 *   ② 提供静态资源路由：
 *      · `GET /dsh-usage-cost/client.js`   —— 浏览器半本体（按 mtime 重读，改完刷新页面即生效）
 *      · `GET /dsh-usage-cost/pricing.json` —— 价目表（可被 <DSH_HOME>/usage-cost-pricing.json 覆盖）
 *
 *   ③ 提供排障通道（只读/只写日志，不含任何凭据）：
 *      · `POST /dsh-usage-cost/report` —— 浏览器半把「页面上到底看到了什么」回执回来，
 *        追加写入 <DSH_HOME>/usage-cost-report.jsonl
 *      · `GET  /dsh-usage-cost/report` —— 直接读最近若干条回执（JSON）
 *      · `GET  /dsh-usage-cost/health` —— 宿主侧计数器 + 运行事实
 *
 * @module dsh-usage-cost
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-usage-cost'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'assets', 'usage-cost.js')
const CLIENT_ROUTE = '/dsh-usage-cost/client.js'
const REPORT_ROUTE = '/dsh-usage-cost/report'
const PRICING_ROUTE = '/dsh-usage-cost/pricing.json'
const HEALTH_ROUTE = '/dsh-usage-cost/health'

/** DSH 数据目录；与 profile 的 `dshHomePath()` 同源。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()
  return path.join(os.homedir(), '.dsh')
}

const REPORT_FILE = () => path.join(dshHome(), 'usage-cost-report.jsonl')
const PRICING_OVERRIDE_FILE = () => path.join(dshHome(), 'usage-cost-pricing.json')
const HOST_LOG_FILE = () => path.join(dshHome(), 'usage-cost-host.log')

/**
 * 宿主半的落盘日志（排障用）。
 * 用途：确认「模块被 import 了没有 / apply 跑到哪一步 / 页面来取过 client.js 没有」。
 * 失败绝不影响主流程。
 */
function hostLog(kind, detail) {
  try {
    const line = JSON.stringify({ at: nowIso(), pid: process.pid, kind, detail: detail === undefined ? null : detail }) + '\n'
    fs.appendFileSync(HOST_LOG_FILE(), line, 'utf8')
  } catch (err) { /* ignore */ }
}

/** 桌面壳里唯一可用的注入行形态：内联脚本，自己建 <script src> 并吞掉 onerror。 */
const CLIENT_LOADER = '(function(){try{var d=document.body||document.head||document.documentElement;'
  + 'if(!d||document.querySelector("script[data-dsh-usage-cost-loader]"))return;'
  + 'var s=document.createElement("script");s.src="' + CLIENT_ROUTE + '";'
  + 's.setAttribute("data-dsh-usage-cost-loader","1");s.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/** 默认价目表：元 / 百万 token，`[空闲价, 高峰价]`（与小鲸鱼挂件同源）。 */
const DEFAULT_PRICING = {
  currency: '¥',
  effectiveFrom: '2026-09-10',
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  note: 'peak = 北京时间周一至周五（非法定节假日）9:00-12:00、14:00-18:00；其余时段（含周末与法定节假日全天）为谷价。',
  peakHours: [[9, 12], [14, 18]],
  weekendValleyFromSec: Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000),
  models: {
    'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
    'deepseek-v4-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
    'deepseek-v4-flash-vision-exp': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
    'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
  }
}

const counters = {
  appliedAt: null,
  indexInjectionEmits: 0,
  clientJsServed: 0,
  clientJsLastServedAt: null,
  clientJsLastUserAgent: null,
  clientJsLastReferer: null,
  pricingServed: 0,
  reportsReceived: 0,
  reportsLastAt: null,
  lastClientLoadError: null
}

function nowIso() { return new Date().toISOString() }

function appendReport(batch) {
  const line = JSON.stringify({ hostAt: nowIso(), pid: process.pid, batch }) + '\n'
  const file = REPORT_FILE()
  try {
    fs.appendFileSync(file, line, 'utf8')
  } catch (err) {
    counters.lastClientLoadError = 'report append failed: ' + String((err && err.message) || err)
    return
  }
  // 体积护栏：超过 4MB 就只留最后 400 行。
  try {
    const st = fs.statSync(file)
    if (st.size > 4 * 1024 * 1024) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      fs.writeFileSync(file, lines.slice(-400).join('\n') + '\n', 'utf8')
    }
  } catch (err) { /* 护栏失败不影响主流程 */ }
}

function readTailReports(limit) {
  try {
    const lines = fs.readFileSync(REPORT_FILE(), 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
  } catch (err) {
    return []
  }
}

/** 浏览器半源码：按 mtime 重读，改完只需刷新页面。 */
let clientCache = null
function loadClientJs() {
  const st = fs.statSync(CLIENT_FILE)
  if (clientCache && clientCache.mtimeMs === st.mtimeMs) return clientCache.text
  const text = fs.readFileSync(CLIENT_FILE, 'utf8')
  clientCache = { text, mtimeMs: st.mtimeMs }
  return text
}

let pricingCache = null
function loadPricing() {
  const base = JSON.parse(JSON.stringify(DEFAULT_PRICING))
  try {
    const st = fs.statSync(PRICING_OVERRIDE_FILE())
    if (!pricingCache || pricingCache.mtimeMs !== st.mtimeMs) {
      pricingCache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(PRICING_OVERRIDE_FILE(), 'utf8')) }
    }
    const over = pricingCache.data || {}
    if (over.models && typeof over.models === 'object') Object.assign(base.models, over.models)
    if (Array.isArray(over.peakHours) && over.peakHours.length) base.peakHours = over.peakHours
    if (over.holidays && typeof over.holidays === 'object') base.holidays = over.holidays
    if (typeof over.currency === 'string' && over.currency) base.currency = over.currency
    base.overrideFile = PRICING_OVERRIDE_FILE()
  } catch (err) {
    if (err && err.code !== 'ENOENT') base.overrideError = String((err && err.message) || err)
  }
  return base
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body))
  })
  res.end(body)
}

function readBody(req, limitBytes = 512 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) { try { req.destroy() } catch (err) {} ; resolve(null); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

/**
 * 宿主半入口。
 * @param root - 该插件所属的 Cordis 上下文。
 */
export function apply(root) {
  counters.appliedAt = nowIso()
  hostLog('apply', { hasOn: typeof root?.on, hasInject: typeof root?.inject, hasGet: typeof root?.get })

  // ① 结构化注入行 —— 必须**第一件事**注册。
  //    桌面端（Electron）的注入表是宿主启动时一次性收集的（collectIndexInjections() → IPC → 渲染层），
  //    晚注册就进不了表 ⇒ 浏览器半永远不会被请求。行本身用内联 <script>，加载失败也只是静默，
  //    绝不会 reject 整个 web boot。
  try {
    root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        counters.indexInjectionEmits += 1
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === CLIENT_ROUTE) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(CLIENT_ROUTE) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: CLIENT_LOADER })
        hostLog('index-inject-row-pushed', { rows: table.length })
      } catch (err) { /* 注入失败绝不能影响启动 */ }
    })
    hostLog('index-inject-listener-registered')
  } catch (err) {
    hostLog('index-inject-register-failed', String((err && err.message) || err))
  }

  // ② 路由与 tapIndex：等 webServer 就绪。
  root.inject(['webServer'], (ctx) => {
    hostLog('inject-callback-entered', { hasWebServer: !!(ctx && ctx.webServer) })
    const disposers = []

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: CLIENT_ROUTE,
      handler: (req, res) => {
        try {
          counters.clientJsServed += 1
          counters.clientJsLastServedAt = nowIso()
          counters.clientJsLastUserAgent = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 200)
          counters.clientJsLastReferer = String((req && req.headers && req.headers.referer) || '').slice(0, 200)
          const text = loadClientJs()
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(Buffer.byteLength(text))
          })
          res.end(text)
        } catch (err) {
          counters.lastClientLoadError = String((err && err.message) || err)
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('dsh-usage-cost: cannot read client bundle: ' + counters.lastClientLoadError)
        }
      }
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: PRICING_ROUTE,
      handler: (req, res) => {
        counters.pricingServed += 1
        sendJson(res, 200, loadPricing())
      }
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: REPORT_ROUTE,
      handler: async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method !== 'POST') {
          sendJson(res, 200, {
            ok: true,
            host: counters,
            reportFile: REPORT_FILE(),
            reports: readTailReports(Math.min(Number(new URL(req.url || '/', 'http://x').searchParams.get('limit')) || 20, 200))
          })
          return
        }
        const body = await readBody(req)
        if (body === null) { sendJson(res, 413, { ok: false, error: 'body too large' }); return }
        try {
          const parsed = JSON.parse(body)
          counters.reportsReceived += 1
          counters.reportsLastAt = nowIso()
          appendReport(parsed)
          sendJson(res, 200, { ok: true })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
      }
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: HEALTH_ROUTE,
      handler: (req, res) => {
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          version: '0.2.0',
          pid: process.pid,
          dshHome: dshHome(),
          clientFile: CLIENT_FILE,
          clientFileExists: fs.existsSync(CLIENT_FILE),
          reportFile: REPORT_FILE(),
          pricingOverrideFile: PRICING_OVERRIDE_FILE(),
          counters
        })
      }
    }))

    // 浏览器访问 http://127.0.0.1:<port>/ 时的注入通道（桌面端走不到这里，两条并存互不影响）。
    disposers.push(ctx.webServer.tapIndex((html) => {
      if (typeof html !== 'string' || html.indexOf(CLIENT_ROUTE) !== -1) return html
      const tag = '<script defer src="' + CLIENT_ROUTE + '" data-dsh-usage-cost-loader="1"></script>'
      return html.indexOf('</body>') !== -1 ? html.replace('</body>', tag + '</body>') : html + tag
    }))

    ctx.effect(() => () => {
      for (const dispose of disposers) { try { dispose() } catch (err) { /* ignore */ } }
    })
    hostLog('routes-registered', {
      routes: [CLIENT_ROUTE, PRICING_ROUTE, REPORT_ROUTE, HEALTH_ROUTE],
      clientFileExists: fs.existsSync(CLIENT_FILE)
    })
  })
  hostLog('apply-returned')
}

hostLog('module-loaded', { file: CLIENT_FILE, exists: fs.existsSync(CLIENT_FILE) })

export default { name, apply }
