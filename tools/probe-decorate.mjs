/**
 * 探针：弹窗标注行为（离线、假 DOM、跑真实的 assets/usage-cost.js）。
 * 覆盖：中英 locale、**峰谷按哪一刻算**（本轮时钟 vs 查看时刻）、重复扫描不叠加、
 *       React 重渲染后自愈、属性锚点失效时的文字兜底、会话级弹窗的模型兜底、回执内容。
 *
 * 跑法：node tools/probe-decorate.mjs
 */
// 时钟文字（HH:mm / M月D日 HH:mm）是按**本机时区**解析的，所以先把时区钉死，
// 换到 CI（默认 UTC）上跑结果也一致。必须在任何 Date 使用之前设置。
process.env.TZ = 'Asia/Shanghai'

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createEnv } from './mini-dom.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'assets', 'usage-cost.js')

let failures = 0
let checks = 0
function ok(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail === undefined ? '' : ' → ' + detail))
  }
}
function eq(label, actual, expected) {
  ok(label + ' = ' + JSON.stringify(expected), actual === expected, 'got ' + JSON.stringify(actual))
}

const PEAK_MS = Date.UTC(2026, 9, 8, 2, 0, 0) // 北京时间 2026-10-08（周四）10:00 → 高峰
const VALLEY_MS = Date.UTC(2026, 9, 8, 5, 0, 0) // 北京时间 2026-10-08 13:00 → 谷价
// 时钟文字是按**本机时区**解析的，所以下面的断言默认本机与北京同时区（UTC+8）。
const TZ_IS_BEIJING = new Date(2026, 9, 8, 12, 0, 0).getTimezoneOffset() === -480
if (!TZ_IS_BEIJING) console.log('  ! 本机时区不是 UTC+8，"时钟文字 → 峰谷"的断言按本机时区解释')

function boot(lang, opts = {}) {
  const env = createEnv({ lang, url: 'dsh-app://app/', pricing: opts.pricing })
  const ctx = vm.createContext(env.sandbox)
  vm.runInContext('Date.now = function () { return ' + (opts.nowMs || PEAK_MS) + ' }', ctx)
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), ctx, { filename: 'usage-cost.js' })
  return { env, ctx, api: env.sandbox.__DSH_USAGE_COST__ }
}

function setNow(ctx, ms) {
  vm.runInContext('Date.now = function () { return ' + ms + ' }', ctx)
}

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag)
  for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k])
  if (text !== undefined) node.textContent = text
  return node
}

/** 复刻官方 TurnTailNodeView 的外壳：动作行 + 打开中的触发器 + 该轮时钟（class 以 _timeEnd 结尾）。 */
function turnTail(doc, { turn = 3, clockText = '20:15', open = true } = {}) {
  const tail = doc.createElement('div')
  tail.setAttribute('data-turn-tail', String(turn))
  const actions = doc.createElement('div')
  actions.className = 'xzv4MW_actions'
  actions.appendChild(el(doc, 'button', { 'aria-haspopup': 'dialog', 'aria-expanded': open ? 'true' : 'false' }, '用量 892.0K tok'))
  actions.appendChild(el(doc, 'span', { class: 'xzv4MW_timeEnd' }, clockText))
  tail.appendChild(actions)
  return tail
}

/** 复刻官方 TurnUsagePanel 的 <dl>（真实渲染里 createPortal 到 body）。 */
function turnPanel(doc, { zh, attr = true, model = 'deepseek-account/deepseek-flash' } = {}) {
  const dl = doc.createElement('dl')
  dl.className = 'bRhRbq_details'
  if (attr) dl.setAttribute('data-turn-usage-details', 'true')
  const L = zh
    ? { model: '提供方 / 模型', hit: '缓存命中', input: '未缓存输入', read: '缓存读取', write: '缓存写入', out: '输出' }
    : { model: 'Provider / model', hit: 'Cache hit', input: 'Uncached input', read: 'Cached input', write: 'Cache write', out: 'Output' }
  dl.appendChild(el(doc, 'dt', {}, L.model))
  dl.appendChild(el(doc, 'dd', { class: 'bRhRbq_route' }, model))
  dl.appendChild(el(doc, 'dt', {}, L.hit))
  dl.appendChild(el(doc, 'dd', {}, '99.97%'))
  dl.appendChild(el(doc, 'dt', {}, L.input))
  dl.appendChild(el(doc, 'dd', {}, '296 tok'))
  dl.appendChild(el(doc, 'dt', {}, L.read))
  dl.appendChild(el(doc, 'dd', {}, '886,912 tok'))
  dl.appendChild(el(doc, 'dt', {}, L.write))
  dl.appendChild(el(doc, 'dd', {}, '0 tok'))
  dl.appendChild(el(doc, 'dt', {}, L.out))
  const outDd = el(doc, 'dd', {}, '923 tok')
  outDd.appendChild(el(doc, 'span', { class: 'bRhRbq_reasoning' }, '（其中推理 123 tok）'))
  dl.appendChild(outDd)
  return dl
}

function sessionPanel(doc) {
  const dl = doc.createElement('dl')
  dl.className = 'bRhRbq_details'
  dl.setAttribute('data-session-stats-usage', 'true')
  dl.appendChild(el(doc, 'dt', {}, '缓存命中'))
  dl.appendChild(el(doc, 'dd', {}, '99.9%'))
  dl.appendChild(el(doc, 'dt', {}, '未缓存输入'))
  dl.appendChild(el(doc, 'dd', {}, '1,036 tok'))
  dl.appendChild(el(doc, 'dt', {}, '缓存读取'))
  dl.appendChild(el(doc, 'dd', {}, '824,448 tok'))
  dl.appendChild(el(doc, 'dt', {}, '输出'))
  dl.appendChild(el(doc, 'dd', {}, '1,942 tok'))
  return dl
}

function moneyOf(dl, role) {
  const all = dl.querySelectorAll('[' + 'data-dsh-usage-cost-role' + '="' + role + '"]')
  return all.length ? all[0].textContent : null
}
/** 合计值：金额节点上单独记着纯金额（dd 的 textContent 还含时段括注）。 */
function totalAmountOf(dl, role) {
  const all = dl.querySelectorAll('[data-dsh-usage-cost-role="' + role + '"]')
  return all.length ? all[0].getAttribute('data-dsh-usage-cost-amount') : null
}
function noteOf(dl, role) {
  const all = dl.querySelectorAll('[data-dsh-usage-cost-role="' + role + '-note"]')
  return all.length ? all[0].textContent : null
}
/** 装一轮完整场景：轮次外壳（带时钟）+ 打开中的弹窗。 */
function mountTurn(env, { clockText, turn = 3, zh = true, attr = true, nowMs }) {
  env.document.body.appendChild(turnTail(env.document, { turn, clockText }))
  const dl = turnPanel(env.document, { zh, attr })
  env.document.body.appendChild(dl)
  return dl
}

// ===========================================================================
console.log('\n[1] 高峰期用的、谷时来看：必须按**本轮时钟**（高峰价）算，不是按查看时刻')
{
  const { env, api } = boot('zh-CN', { nowMs: VALLEY_MS }) // 查看时刻 = 谷价
  const dl = mountTurn(env, { clockText: '10:00' }) // 本轮 = 北京 10:00 高峰
  eq('扫到并标注的弹窗数', api.scan(), 1)
  eq('判定依据', api.state.lastFact.refSource, 'turn-clock')
  eq('时段', api.state.lastFact.tier, 'peak')
  eq('合计行括注', api.state.lastFact.totalNote, '（高峰价）')
  eq('缓存读取金额（高峰 0.04）', moneyOf(dl, 'cacheRead'), '¥0.0355')
  eq('未缓存输入金额（高峰 2）', moneyOf(dl, 'uncachedInput'), '¥0.000592')
  eq('输出金额（高峰 8）', moneyOf(dl, 'output'), '¥0.007384')
  eq('本轮合计', totalAmountOf(dl, 'total'), '¥0.0435')
  eq('合计行标签', dl.querySelectorAll('[data-dsh-usage-cost-role="total-label"]')[0].textContent, '本轮费用')
  eq('合计行括注节点文字', noteOf(dl, 'total'), '（高峰价）')
  const outDd = dl.children.filter((c) => c.tagName === 'DD')[5]
  eq('金额节点就挂在输出行的 dd 里（token 右边）',
    outDd.querySelectorAll('[data-dsh-usage-cost-role="output"]')[0].parentNode === outDd, true)
  eq('推理后缀没被当成输出 token', api.state.lastFact.rows.filter((r) => r.role === 'output')[0].tokens, 923)
  eq('模型识别', api.state.lastFact.model, 'deepseek-flash')
}

console.log('\n[2] 反过来：谷时用的、高峰来看 → 必须按谷价')
{
  const { env, api } = boot('zh-CN', { nowMs: PEAK_MS }) // 查看时刻 = 高峰
  const dl = mountTurn(env, { clockText: '20:15' }) // 本轮 = 北京 20:15 谷价
  api.scan()
  eq('判定依据', api.state.lastFact.refSource, 'turn-clock')
  eq('时段', api.state.lastFact.tier, 'valley')
  eq('合计行括注', api.state.lastFact.totalNote, '（谷价）')
  eq('缓存读取金额（谷价 0.02）', moneyOf(dl, 'cacheRead'), '¥0.0177')
  eq('本轮合计（谷价）', totalAmountOf(dl, 'total'), '¥0.0217')
}

console.log('\n[3] 时钟带日期（今年更早）/ 跨年时钟也能解析；读不到时钟则退回"现在"')
{
  const { env, api } = boot('zh-CN', { nowMs: VALLEY_MS })
  const dl = mountTurn(env, { clockText: '10月8日 11:00' }) // 今年 10-08 11:00 → 高峰
  api.scan()
  eq('M月D日 HH:mm → 高峰', api.state.lastFact.tier, 'peak')
  eq('时钟原文回执', api.state.lastFact.refClock, '10月8日 11:00')
}
{
  const { env, api } = boot('zh-CN', { nowMs: VALLEY_MS })
  const dl = mountTurn(env, { clockText: '2025年10月8日 11:00' }) // 去年同一天 11:00 → 高峰
  api.scan()
  eq('Y年M月D日 HH:mm → 高峰', api.state.lastFact.tier, 'peak')
}
{
  const { env, api } = boot('zh-CN', { nowMs: VALLEY_MS })
  const tail = turnTail(env.document, { clockText: '' })
  tail.querySelectorAll('[class*="_timeEnd"]')[0].textContent = ''
  env.document.body.appendChild(tail)
  const dl = turnPanel(env.document, { zh: true })
  env.document.body.appendChild(dl)
  api.scan()
  eq('读不到时钟 → 退回查看时刻', api.state.lastFact.refSource, 'now')
  eq('退回后按谷价', api.state.lastFact.tier, 'valley')
}

console.log('\n[4] 反复扫描不叠加')
{
  const { env, api } = boot('zh-CN', { nowMs: PEAK_MS })
  const dl = mountTurn(env, { clockText: '10:00' })
  api.scan()
  api.scan()
  api.scan()
  eq('注入节点总数（4 个金额 + 合计标签 + 合计值 + 括注）', dl.querySelectorAll('[data-dsh-usage-cost-role]').length, 7)
  eq('dt 行数（6 行官方 + 1 行合计）', dl.children.filter((c) => c.tagName === 'DT').length, 7)

  console.log('\n[5] 模拟官方 React 重渲染把我注入的节点全删掉 → 自动补回')
  for (const node of dl.querySelectorAll('[data-dsh-usage-cost-role]')) node.parentNode.removeChild(node)
  eq('清空后确实没了', dl.querySelectorAll('[data-dsh-usage-cost-role]').length, 0)
  api.scan()
  eq('补回后的合计', totalAmountOf(dl, 'total'), '¥0.0435')
  eq('补回后的括注', noteOf(dl, 'total'), '（高峰价）')
}

console.log('\n[6] 英文 locale + 属性锚点失效时的文字兜底')
{
  const { env, api } = boot('en-US', { nowMs: PEAK_MS })
  const dl = mountTurn(env, { clockText: '20:15', zh: false, attr: false })
  eq('无属性锚点也能扫到', api.scan(), 1)
  eq('扫描方式', api.state.lastVia, 'text')
  eq('英文合计标签', dl.querySelectorAll('[data-dsh-usage-cost-role="total-label"]')[0].textContent, 'Turn cost')
  eq('英文下按本轮谷价', moneyOf(dl, 'cacheRead'), '¥0.0177')
}

console.log('\n[7] 会话级用量弹窗：没有模型行 → 模型选择器兜底；跨多轮 → 按当前时段并明确标注')
{
  const { env, api } = boot('zh-CN', { nowMs: PEAK_MS })
  const composer = el(env.document, 'div')
  composer.appendChild(el(env.document, 'button', { 'aria-label': '选择模型，当前 deepseek-v4-pro，推理等级 max' }, 'deepseek-v4-pro'))
  env.document.body.appendChild(composer)
  const dl = sessionPanel(env.document)
  env.document.body.appendChild(dl)
  api.scan()
  eq('模型来自选择器', api.state.lastFact.model, 'deepseek-v4-pro')
  eq('来源标记', api.state.lastFact.modelSource, 'composer')
  eq('判定依据退回当前时刻', api.state.lastFact.refSource, 'now')
  eq('会话合计标签', dl.querySelectorAll('[data-dsh-usage-cost-role="total-label-session"]')[0].textContent, '合计费用')
  eq('会话合计的时段括注', noteOf(dl, 'total-session'), '（按当前时段价）')
  eq('Pro 缓存读取金额（高峰 0.3）', moneyOf(dl, 'cacheRead'), '¥0.2473')
  eq('Pro 输出金额（高峰 27）', moneyOf(dl, 'output'), '¥0.0524')
}

console.log('\n[8] 回执：页面上看到的东西要 POST 回宿主')
{
  const { env, ctx, api } = boot('zh-CN', { nowMs: VALLEY_MS })
  const dl = mountTurn(env, { clockText: '10:00' })
  api.scan()
  setNow(ctx, VALLEY_MS + 5000)
  env.runAllTimeouts()
  env.runAllTimeouts()
  const posts = env.fetchCalls.filter((c) => String(c.url).indexOf('/dsh-usage-cost/report') >= 0)
  ok('至少 POST 过一次回执', posts.length > 0, 'posts=' + posts.length)
  const payload = posts.length ? JSON.parse(posts[posts.length - 1].opts.body) : null
  ok('回执里带 census', payload && payload.batch.some((b) => b.census && typeof b.census.turnTails === 'number'))
  const decorate = payload && payload.batch.filter((b) => b.kind === 'decorate')[0]
  ok('回执里带每行金额', decorate && decorate.fact.money.length === 4, JSON.stringify(decorate && decorate.fact.money))
  ok('回执里带定价依据', decorate && decorate.fact.refSource === 'turn-clock' && decorate.fact.tier === 'peak',
    JSON.stringify(decorate && { refSource: decorate.fact.refSource, tier: decorate.fact.tier, atSec: decorate.fact.atSec }))
}

console.log('\n[9] 金额格式边界')
{
  const { api } = boot('zh-CN')
  const f = api.pure.formatMoney
  eq('0', f(0), '¥0.00')
  eq('极小值', f(0.000001), '<¥0.0001')
  eq('6 位小数', f(0.000592), '¥0.000592')
  eq('4 位小数', f(0.03547648), '¥0.0355')
  eq('至少 2 位', f(2.1), '¥2.10')
  eq('整数', f(12), '¥12.00')
}

console.log('\n[10] 时钟文字解析边界')
{
  const { api } = boot('zh-CN')
  const p = api.pure.parseClockText
  const hh = (sec) => new Date(sec * 1000).getHours() + ':' + new Date(sec * 1000).getMinutes()
  eq('HH:mm', hh(p('10:00')), '10:0')
  eq('M月D日 HH:mm', hh(p('10月8日 11:05')), '11:5')
  eq('Y年M月D日 HH:mm', new Date(p('2025年10月8日 11:00') * 1000).getFullYear(), 2025)
  eq('M/D HH:mm（英文）', hh(p('10/8 11:05')), '11:5')
  eq('Y-M-D HH:mm（英文）', new Date(p('2025-10-08 11:00') * 1000).getFullYear(), 2025)
  eq('不是时钟', p('用量 892.0K tok'), null)
  eq('空串', p(''), null)
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项检查）')
process.exit(failures === 0 ? 0 : 1)
