/**
 * dsh-usage-cost —— 浏览器半（**经典脚本，不是 ES 模块**）
 * ============================================================================
 * 干什么：在 DSH 自带「用量」弹窗（本轮用量 / 会话 Token 用量）里，
 *         把「未缓存输入 / 缓存读取 / 缓存写入 / 输出」每一行的 token 数
 *         折算成金额，显示在该行 token 数字的右边，并在末尾追加一行合计。
 *
 * 金额口径：DeepSeek 官方价目表 + 峰谷价，与右下角小鲸鱼挂件
 *          (`dsh-whale-widget/lib/index.js` 的 PRICING / isPeakTime) 同源。
 *
 * 怎么进来：宿主半 lib/index.js 通过 webserver/index-inject 往页面塞一段
 *          内联脚本，那段脚本再 append 一个
 *          `<script src="/dsh-usage-cost/client.js">`（本文件即由该路由吐出）。
 *          ⇒ 改本文件**不用重启 DSH**，页面里刷新一次即可（路由按 mtime 重读）。
 *
 * ⚠️ 本文件顶层**不能出现 import / export**（经典脚本，出现即整页起不来）。
 *    上线前务必跑：node tools/probe-syntax.mjs
 *
 * @module dsh-usage-cost/client
 */
;(function () {
  'use strict'

  var W = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this)
  var VERSION = '0.2.0'

  // 幂等：tapIndex 与 index-inject 两条注入通道可能各来一次，只跑第一份。
  if (W.__DSH_USAGE_COST__ && W.__DSH_USAGE_COST__.version) return

  // ==========================================================================
  // @pricing-core —— 价格与峰谷（与 dsh-whale-widget 同源，官方调价改这里）
  // ==========================================================================
  var CURRENCY = '¥'

  // [空闲时段价, 高峰时段价]，单位：元 / 百万 token
  var BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] } // deepseek-flash
  var PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] } // deepseek-v4-pro
  var PRICING = {
    'deepseek-flash': BASE_PRICE,
    'deepseek-v4-flash': BASE_PRICE, // 旧名，仍由 V4.1-Flash 提供、按 Flash 计价
    'deepseek-v4-flash-vision-exp': BASE_PRICE,
    'deepseek-v4-pro': PRO_PRICE,
    _default: BASE_PRICE
  }
  // 高峰 = 北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00；其余含周末全天谷价。
  var PEAK_HOURS = [[9, 12], [14, 18]]
  var WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // 北京时间 2026-08-23 00:00
  // 法定节假日全天谷价（国务院办公厅 2026 年放假安排）：每年 11 月发布次年安排后要补下一年。
  var HOLIDAY_VALLEY = {
    '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
    '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
    '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
    '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
    '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
    '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
    '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
    '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
    '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1
  }
  var HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000) // 北京时间 2026-09-19 00:00

  /** 该时刻（epoch 秒）是否高峰时段；与挂件 isPeakTime 逐行同源。 */
  function isPeakTime(timeSec) {
    if (!isFinite(Number(timeSec))) return false
    var n = Number(timeSec)
    var bj = new Date(n * 1000 + 8 * 3600 * 1000)
    if (n >= WEEKEND_VALLEY_FROM_SEC) {
      var dow = bj.getUTCDay() // 0=周日 6=周六
      if (dow === 0 || dow === 6) return false
    }
    if (n >= HOLIDAY_VALLEY_FROM_SEC) {
      var key = bj.toISOString().slice(0, 10)
      if (HOLIDAY_VALLEY[key]) return false
    }
    var hour = bj.getUTCHours()
    for (var i = 0; i < PEAK_HOURS.length; i++) {
      if (hour >= PEAK_HOURS[i][0] && hour < PEAK_HOURS[i][1]) return true
    }
    return false
  }

  /** 模型名 → 价目档位（子串匹配，键长降序，避免短键误伤）。 */
  function priceFor(model) {
    var m = String(model || '').toLowerCase()
    var keys = Object.keys(PRICING).filter(function (k) { return k !== '_default' })
    keys.sort(function (a, b) { return b.length - a.length })
    for (var i = 0; i < keys.length; i++) {
      if (m && m.indexOf(keys[i]) !== -1) return PRICING[keys[i]]
    }
    return PRICING._default
  }

  /** 四个 token 环节的单价（元/百万），已按峰谷取值。 */
  function unitPrices(model, atSec, override) {
    var p = (override && override.model) || priceFor(model)
    var off = isPeakTime(atSec) ? 1 : 0
    return { uncachedInput: p.miss[off], cacheRead: p.hit[off], cacheWrite: p.miss[off], output: p.out[off] }
  }

  /**
   * 金额显示：按量级选精度（≥0.01 给 4 位、更小给 6 位），去掉多余的 0，
   * 至少保留 2（小额 4）位小数；小于 0.00005 元给下界标记。
   */
  function formatMoney(value) {
    var v = Number(value)
    if (!isFinite(v) || v <= 0) return CURRENCY + '0.00'
    if (v < 0.00005) return '<' + CURRENCY + '0.0001'
    var big = v >= 0.01
    var s = v.toFixed(big ? 4 : 6)
    if (s.indexOf('.') !== -1) {
      s = s.replace(/0+$/, '')
      var minDecimals = big ? 2 : 4
      var dot = s.indexOf('.')
      if (dot === s.length - 1) s += '0'.repeat(minDecimals)
      while (s.length - dot - 1 < minDecimals) s += '0'
    }
    return CURRENCY + s
  }

  // ==========================================================================
  // DOM 侧：识别弹窗、抠 token 数、标注金额
  // ==========================================================================
  var PANEL_ATTRS = ['data-turn-usage-details', 'data-session-stats-usage']
  var MARK = 'data-dsh-usage-cost-role'
  var DEFAULT_MODEL = 'deepseek-flash'

  // 行标签 → 环节（中英双语；官方 locale 就这两套）
  var ROW_ROLES = [
    { role: 'model', zh: '提供方 / 模型', en: 'provider / model', alias: ['模型', 'model'] },
    { role: 'cacheHit', zh: '缓存命中', en: 'cache hit', alias: [] },
    { role: 'uncachedInput', zh: '未缓存输入', en: 'uncached input', alias: ['缓存未命中', '未命中输入', 'cache miss'] },
    { role: 'cacheRead', zh: '缓存读取', en: 'cached input', alias: ['缓存命中读取', 'cache read'] },
    { role: 'cacheWrite', zh: '缓存写入', en: 'cache write', alias: ['缓存写入量'] },
    { role: 'output', zh: '输出', en: 'output', alias: [] }
  ]
  // 要标金额的环节（cacheHit 是百分比行，不是 token 行）
  var MONEY_ROLES = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']

  function normLabel(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim()
  }

  function roleOfLabel(label) {
    var s = normLabel(label).toLowerCase()
    if (!s) return null
    for (var i = 0; i < ROW_ROLES.length; i++) {
      var r = ROW_ROLES[i]
      if (s === r.zh.toLowerCase() || s === r.en.toLowerCase()) return r.role
    }
    for (var j = 0; j < ROW_ROLES.length; j++) {
      var q = ROW_ROLES[j]
      var names = [q.zh, q.en].concat(q.alias)
      for (var k = 0; k < names.length; k++) {
        var n = String(names[k] || '').toLowerCase()
        if (n && s.indexOf(n) !== -1) return q.role
      }
    }
    return null
  }

  function isZh() {
    try {
      var lang = String((W.navigator && (W.navigator.language || (W.navigator.languages && W.navigator.languages[0]))) || '')
      var t = String((W.document && W.document.documentElement && W.document.documentElement.getAttribute('lang')) || '')
      return /^zh/i.test(lang) || /^zh/i.test(t) || /[\u4e00-\u9fa5]/.test(String((W.document && W.document.title) || ''))
    } catch (err) { return true }
  }

  /** dd 里第一个文本节点的内容（官方结构：`<dd>1,036 tok<span>（其中推理 …）</span></dd>`）。 */
  function countTextOf(dd) {
    if (!dd) return ''
    var kids = dd.childNodes || []
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] && kids[i].nodeType === 3 && String(kids[i].nodeValue || '').trim()) {
        return String(kids[i].nodeValue)
      }
    }
    return String(dd.textContent || '')
  }

  /** "1,036 tok" / "12.2K tok" / "1.2万 tok" → 1036 / 12200 / 12000；读不出返回 null。 */
  function parseTokens(text) {
    var s = String(text == null ? '' : text).replace(/[\u00A0\u202F\u2009]/g, ' ')
    var m = /(-?[0-9][0-9, ]*(?:\.[0-9]+)?)\s*(亿|万|[KkMm])?/.exec(s)
    if (!m) return null
    var digits = m[1].replace(/[ ,]/g, '')
    var value = Number(digits)
    if (!isFinite(value) || value < 0) return null
    var unit = (m[2] || '').toLowerCase()
    if (unit === 'k') value *= 1e3
    else if (unit === 'm') value *= 1e6
    else if (unit === '万') value *= 1e4
    else if (unit === '亿') value *= 1e8
    return Math.round(value)
  }

  function elementChildren(el) {
    if (!el) return []
    if (el.children && typeof el.children.length === 'number') return Array.prototype.slice.call(el.children)
    var out = []
    var kids = el.childNodes || []
    for (var i = 0; i < kids.length; i++) if (kids[i] && kids[i].nodeType === 1) out.push(kids[i])
    return out
  }

  function tagOf(el) { return el && el.tagName ? String(el.tagName).toUpperCase() : '' }

  // --------------------------------------------------------------------------
  // 峰谷定价的「按哪一刻算」——按**本轮自己的时间**，不是「你查看的这一刻」
  // --------------------------------------------------------------------------
  // 官方 MessageIconActions 会在每轮的动作行末尾渲染一个时钟（class 以 `_timeEnd` 结尾），
  // 内容来自该轮 `closing.time`：同一天 `HH:mm`、今年更早 `M月D日 HH:mm`、跨年 `Y年M月D日 HH:mm`
  // （英文 `M/D HH:mm` / `Y-M-D HH:mm`）。弹窗是 createPortal 到 body 的，拿不到"属于哪一轮"，
  // 但**打开中的触发器还在那一轮的动作行里**（aria-expanded="true"）⇒ 顺着它回溯到
  // `[data-turn-tail]` 就能读到该轮时间，用那一轮的时间判峰谷。
  /** 把时钟文字解析成 epoch 秒（本地时区）；读不出返回 null。 */
  function parseClockText(text) {
    var s = String(text == null ? '' : text).replace(/[\u00A0\u202F]/g, ' ').replace(/\s+/g, ' ').trim()
    var m = /^(?:(\d{4})\s*[年\-\/.]\s*)?(?:(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})\s*日?)?\s*(\d{1,2}):(\d{2})\s*$/.exec(s)
    if (!m) return null
    var now = new Date()
    var year = m[1] ? Number(m[1]) : now.getFullYear()
    var month = m[2] ? Number(m[2]) : now.getMonth() + 1
    var day = m[3] ? Number(m[3]) : now.getDate()
    var hh = Number(m[4])
    var mi = Number(m[5])
    if (!(hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59)) return null
    var d = new Date(year, month - 1, day, hh, mi, 0, 0)
    if (!isFinite(d.getTime())) return null
    // 没写年份 = 今年；万一落在未来（跨年边界那几天），回退一年
    if (!m[1] && d.getTime() > now.getTime() + 86400000) d.setFullYear(year - 1)
    return Math.floor(d.getTime() / 1000)
  }

  /** 从「打开中的弹窗所在的轮次」读出该轮时间。 */
  function turnRefFromDom() {
    try {
      var tails = W.document.querySelectorAll('[data-turn-tail]')
      for (var i = 0; i < tails.length; i++) {
        var open = tails[i].querySelector('[aria-haspopup="dialog"][aria-expanded="true"]')
        if (!open) continue
        var turn = tails[i].getAttribute ? String(tails[i].getAttribute('data-turn-tail') || '') : ''
        var clock = tails[i].querySelector('[class*="_timeEnd"]')
        var text = clock ? normLabel(clock.textContent) : ''
        return { atSec: parseClockText(text), text: text, turn: turn }
      }
    } catch (err) { /* 读不到就退回"现在" */ }
    return null
  }

  /** 本轮费用还是合计费用、按哪个时段定价，都写在合计行右侧，避免"这是哪一刻的价"含糊。 */
  function tierNote(isSession, peak, refText) {
    if (isSession) {
      return { text: '（按当前时段价）', title: '会话合计跨多轮，无法归到单一时段，按当前时段单价估算。' }
    }
    var tier = peak ? '高峰价' : '谷价'
    var basis = refText ? '按本轮时间 ' + refText + ' 判定' : '按当前时间判定'
    return { text: '（' + tier + '）', title: basis + '：' + tier + '。峰谷规则见 dsh-usage-cost README。' }
  }

  /** 会话级用量弹窗（带 data-session-stats-usage）还是本轮用量弹窗。 */
  function isSessionPanel(dl) {
    if (!dl || !dl.getAttribute) return false
    if (typeof dl.hasAttribute === 'function') {
      if (dl.hasAttribute('data-session-stats-usage')) return true
    }
    return String(dl.getAttribute('data-session-stats-usage') || '') !== ''
  }

  /** 收集 <dl> 里的 dt/dd 配对。 */
  function collectPairs(dl) {
    var kids = elementChildren(dl)
    var pairs = []
    for (var i = 0; i < kids.length; i++) {
      if (tagOf(kids[i]) !== 'DT') continue
      var dd = null
      for (var j = i + 1; j < kids.length; j++) {
        if (tagOf(kids[j]) === 'DD') { dd = kids[j]; break }
        if (tagOf(kids[j]) === 'DT') break
      }
      pairs.push({ dt: kids[i], dd: dd, label: normLabel(kids[i].textContent) })
    }
    return pairs
  }

  function ownChild(parent, role) {
    var kids = elementChildren(parent)
    for (var i = 0; i < kids.length; i++) {
      var v = kids[i].getAttribute ? kids[i].getAttribute(MARK) : null
      if (v === role) return kids[i]
    }
    return null
  }

  function makeNode(tag, role, className) {
    var el = W.document.createElement(tag)
    if (el.setAttribute) el.setAttribute(MARK, role)
    else el[MARK] = role
    if (className) el.className = className
    return el
  }

  function setMoneySpan(dd, role, text) {
    var span = ownChild(dd, role)
    if (!span) {
      span = makeNode('span', role, 'dsh-usage-cost-money')
      span.textContent = text
      dd.appendChild(span)
      return 'inserted'
    }
    if (String(span.textContent) !== text) { span.textContent = text; return 'updated' }
    return 'same'
  }

  function setTotalRow(dl, role, label, value, note) {
    var isSession = role === 'session'
    var labelRole = isSession ? 'total-label-session' : 'total-label'
    var totalRole = isSession ? 'total-session' : 'total'
    var dt = ownChild(dl, labelRole)
    if (!dt) { dt = makeNode('dt', labelRole, 'dsh-usage-cost-total-label'); dl.appendChild(dt) }
    var dd = ownChild(dl, totalRole)
    if (!dd) { dd = makeNode('dd', totalRole, 'dsh-usage-cost-total'); dl.appendChild(dd) }
    if (String(dt.textContent) !== label) dt.textContent = label
    var currentAmount = dd.getAttribute ? dd.getAttribute('data-dsh-usage-cost-amount') : null
    if (currentAmount !== value) {
      dd.textContent = value
      if (dd.setAttribute) dd.setAttribute('data-dsh-usage-cost-amount', value)
    }
    if (note) {
      var span = ownChild(dd, totalRole + '-note')
      if (!span) { span = makeNode('span', totalRole + '-note', 'dsh-usage-cost-note'); dd.appendChild(span) }
      if (String(span.textContent) !== note.text) span.textContent = note.text
      if (span.setAttribute) span.setAttribute('title', note.title)
      if (dd.setAttribute) dd.setAttribute('title', note.title)
    }
  }

  /** 会话级弹窗没有模型行：退而从输入框上方的模型选择器 aria-label 里读。 */
  function modelFromComposer() {
    try {
      var btns = W.document.querySelectorAll('button[aria-label]')
      var limit = Math.min(btns.length, 500)
      for (var i = 0; i < limit; i++) {
        var a = String(btns[i].getAttribute('aria-label') || '')
        var m = /选择模型[，,]\s*当前\s*([^，,]+)/.exec(a) || /Select model,\s*current\s*([^,]+)/.exec(a)
        if (m) return m[1].trim()
      }
    } catch (err) { /* 找不到就算了，走默认档 */ }
    return null
  }

  function modelIdOf(raw) {
    var s = String(raw == null ? '' : raw).split(',')[0].trim()
    if (!s) return ''
    var parts = s.split('/')
    return parts[parts.length - 1].trim()
  }

  /** 标注一个弹窗；返回本次事实（给回执/自述用）。 */
  function decoratePanel(dl, pricing) {
    var pairs = collectPairs(dl)
    if (pairs.length === 0) return null
    var fact = { rows: [], total: 0, model: '', modelSource: '', money: [], unknown: [] }
    var buckets = {}
    var model = ''

    for (var i = 0; i < pairs.length; i++) {
      var role = roleOfLabel(pairs[i].label)
      if (!role) { if (pairs[i].label) fact.unknown.push(pairs[i].label); continue }
      if (role === 'model') {
        if (!pairs[i].dd) continue
        var rawModel = normLabel(pairs[i].dd.textContent)
        model = modelIdOf(rawModel) || model
        fact.modelRaw = rawModel
        fact.modelSource = 'panel'
        continue
      }
      if (MONEY_ROLES.indexOf(role) === -1) continue
      if (!pairs[i].dd) continue
      var tokens = parseTokens(countTextOf(pairs[i].dd))
      fact.rows.push({ role: role, label: pairs[i].label, text: normLabel(countTextOf(pairs[i].dd)), tokens: tokens })
      if (tokens === null) continue
      buckets[role] = tokens
    }

    if (!model) {
      var guessed = modelFromComposer()
      model = modelIdOf(guessed) || DEFAULT_MODEL
      fact.modelSource = guessed ? 'composer' : 'default'
      fact.modelRaw = guessed || ''
    }
    fact.model = model

    // 峰谷按「这一轮发生的那一刻」判，不是「你点开弹窗的那一刻」：
    // 本轮用量弹窗 → 顺着打开中的触发器回溯到 [data-turn-tail]，读它自己的时钟；
    // 会话合计弹窗（跨多轮）→ 归不到单一时段，只能用当前时刻，并在界面上标明。
    var isSession = isSessionPanel(dl)
    var ref = isSession ? null : turnRefFromDom()
    var atSec = ref && ref.atSec ? ref.atSec : Math.floor(Date.now() / 1000)
    var refSource = ref && ref.atSec ? 'turn-clock' : 'now'
    var override = pricing && pricing.models ? { model: pricing.models[model] || pricing.models._default } : null
    var unit = unitPrices(model, atSec, override)
    var total = 0
    var anyPriced = false

    for (var r = 0; r < MONEY_ROLES.length; r++) {
      var name = MONEY_ROLES[r]
      if (buckets[name] === undefined) continue
      var dd = null
      for (var q = 0; q < pairs.length; q++) {
        if (roleOfLabel(pairs[q].label) === name) { dd = pairs[q].dd; break }
      }
      if (!dd) continue
      var amount = (buckets[name] / 1e6) * unit[name]
      total += amount
      anyPriced = true
      setMoneySpan(dd, name, formatMoney(amount))
      fact.money.push({ role: name, tokens: buckets[name], amount: Number(amount.toFixed(8)), unit: unit[name], text: formatMoney(amount) })
    }

    if (!anyPriced) return fact

    var peak = isPeakTime(atSec)
    var label = isZh()
      ? (isSession ? '合计费用' : '本轮费用')
      : (isSession ? 'Total cost' : 'Turn cost')
    var note = tierNote(isSession, peak, ref ? ref.text : '')
    setTotalRow(dl, isSession ? 'session' : 'turn', label, formatMoney(total), note)

    fact.total = Number(total.toFixed(8))
    fact.totalText = formatMoney(total)
    fact.peak = peak
    fact.tier = peak ? 'peak' : 'valley'
    fact.atSec = atSec
    fact.atText = new Date(atSec * 1000).toLocaleString()
    fact.refSource = refSource
    fact.refClock = ref ? ref.text : ''
    fact.refTurn = ref ? ref.turn : ''
    fact.panelKind = isSession ? 'session' : 'turn'
    fact.totalNote = note.text
    return fact
  }

  // 属性锚点全丢时的兜底：按「标签文字 + ≥2 组 dt/dd」反查容器。
  function findPanelsByText() {
    var out = []
    try {
      var dls = W.document.querySelectorAll('dl')
      for (var i = 0; i < dls.length; i++) {
        var pairs = collectPairs(dls[i])
        var hits = 0
        for (var j = 0; j < pairs.length; j++) if (roleOfLabel(pairs[j].label)) hits += 1
        if (hits >= 2 && pairs.length >= 2) out.push(dls[i])
      }
    } catch (err) { /* ignore */ }
    return out
  }

  function findPanels() {
    var out = []
    try {
      for (var i = 0; i < PANEL_ATTRS.length; i++) {
        var list = W.document.querySelectorAll('[' + PANEL_ATTRS[i] + ']')
        for (var j = 0; j < list.length; j++) out.push(list[j])
      }
    } catch (err) { /* ignore */ }
    if (out.length > 0) return { panels: out, via: 'attr' }
    var byText = findPanelsByText()
    return { panels: byText, via: byText.length ? 'text' : 'none' }
  }

  function census() {
    function count(sel) {
      try { return W.document.querySelectorAll(sel).length } catch (err) { return -1 }
    }
    return {
      url: String((W.location && W.location.href) || ''),
      title: String((W.document && W.document.title) || ''),
      turnTails: count('[data-turn-tail]'),
      turnPanels: count('[data-turn-usage-details]'),
      statsPanels: count('[data-session-stats-usage]'),
      composerStats: count('[data-composer-stats]'),
      dialogs: count('[role="dialog"]'),
      dls: count('dl'),
      bodyLen: W.document && W.document.body ? String(W.document.body.textContent || '').length : -1
    }
  }

  // ==========================================================================
  // 回执通道：把「页面里到底看到了什么」POST 回宿主，落盘成 jsonl 便于排障
  // ==========================================================================
  var REPORT_URL = '/dsh-usage-cost/report'
  var queue = []
  var lastSent = 0
  var flushTimer = null
  var sent = 0

  function flush() {
    if (queue.length === 0) return
    var now = Date.now()
    if (now - lastSent < 1200) {
      if (!flushTimer) {
        flushTimer = setTimeout(function () { flushTimer = null; flush() }, 1200 - (now - lastSent))
      }
      return
    }
    var batch = queue.splice(0, queue.length)
    lastSent = now
    sent += 1
    try {
      var body = JSON.stringify({ v: VERSION, at: now, batch: batch })
      var res = W.fetch(REPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      })
      if (res && typeof res.catch === 'function') res.catch(function () {})
    } catch (err) { /* 回执失败绝不影响标注 */ }
  }

  function report(kind, extra) {
    try {
      var payload = { kind: kind, at: Date.now(), census: census() }
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k]
      queue.push(payload)
      if (queue.length > 40) queue.splice(0, queue.length - 40)
      flush()
    } catch (err) { /* ignore */ }
  }

  // ==========================================================================
  // 扫描循环：MutationObserver（事件驱动）+ 定时兜底
  // ==========================================================================
  var state = { scans: 0, decorated: 0, lastError: null, lastVia: 'none', lastFact: null, lastSig: '', observer: false, timer: false, pricing: null, pricingSource: 'builtin' }
  var scheduleTimer = null
  var observer = null

  function scan() {
    state.scans += 1
    try {
      var found = findPanels()
      state.lastVia = found.via
      if (found.panels.length === 0) return 0
      var n = 0
      for (var i = 0; i < found.panels.length; i++) {
        var fact = decoratePanel(found.panels[i], state.pricing)
        if (!fact) continue
        n += 1
        state.lastFact = fact
        // 只在「第一次」和「内容变了」时回执，避免刷屏
        var sig = JSON.stringify({ k: fact.panelKind, m: fact.money, t: fact.total, model: fact.model, src: fact.modelSource, via: found.via, unknown: fact.unknown })
        if (sig !== state.lastSig) {
          state.lastSig = sig
          report('decorate', { via: found.via, fact: fact })
        }
      }
      state.decorated = n
      return n
    } catch (err) {
      state.lastError = String((err && err.message) || err)
      report('scan-error', { error: state.lastError })
      return 0
    } finally {
      if (observer && typeof observer.takeRecords === 'function') { try { observer.takeRecords() } catch (e) {} }
    }
  }

  function schedule(delay) {
    if (scheduleTimer) return
    scheduleTimer = setTimeout(function () { scheduleTimer = null; scan() }, delay || 180)
  }

  function fetchPricing() {
    try {
      var res = W.fetch('/dsh-usage-cost/pricing.json', { cache: 'no-store' })
      if (!res || typeof res.then !== 'function') return
      res.then(function (r) { return r && r.ok ? r.json() : null }).then(function (data) {
        if (!data || typeof data !== 'object') return
        if (data.models && typeof data.models === 'object') {
          for (var k in data.models) {
            if (!Object.prototype.hasOwnProperty.call(data.models, k)) continue
            var v = data.models[k]
            if (v && v.hit && v.miss && v.out) PRICING[k] = { hit: v.hit, miss: v.miss, out: v.out }
          }
        }
        if (Array.isArray(data.peakHours) && data.peakHours.length) PEAK_HOURS = data.peakHours
        if (data.holidays && typeof data.holidays === 'object') HOLIDAY_VALLEY = data.holidays
        if (typeof data.weekendValleyFromSec === 'number') WEEKEND_VALLEY_FROM_SEC = data.weekendValleyFromSec
        if (typeof data.currency === 'string' && data.currency) CURRENCY = data.currency
        state.pricing = data
        state.pricingSource = 'host'
        schedule(0)
      }).catch(function () {})
    } catch (err) { /* ignore */ }
  }

  function injectStyle() {
    try {
      var doc = W.document
      if (!doc || doc.querySelector('style[data-dsh-usage-cost-style]')) return
      var style = doc.createElement('style')
      style.setAttribute('data-dsh-usage-cost-style', '1')
      style.textContent =
        '.dsh-usage-cost-money{margin-left:6px;color:var(--dsw-alias-label-tertiary,#8a8f99);' +
        'font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}' +
        '.dsh-usage-cost-total-label{color:var(--dsw-alias-label-tertiary,#8a8f99)}' +
        '.dsh-usage-cost-total{color:var(--dsw-alias-label-primary,inherit);font-weight:500;' +
        'font-variant-numeric:tabular-nums}' +
        '.dsh-usage-cost-note{margin-left:6px;color:var(--dsw-alias-label-tertiary,#8a8f99);' +
        'font-size:11px;font-weight:400;white-space:nowrap}'
      ;(doc.head || doc.documentElement).appendChild(style)
    } catch (err) { /* ignore */ }
  }

  function start() {
    injectStyle()
    try {
      if (W.MutationObserver && W.document && W.document.documentElement) {
        observer = new W.MutationObserver(function () { schedule(180) })
        observer.observe(W.document.documentElement, { childList: true, subtree: true, characterData: true })
        state.observer = true
      }
    } catch (err) { state.lastError = 'observer: ' + String((err && err.message) || err) }
    try {
      setInterval(function () { scan() }, 1500)
      state.timer = true
    } catch (err) { /* ignore */ }
    scan()
    fetchPricing()
    report('boot', {
      version: VERSION,
      observer: state.observer,
      timer: state.timer,
      zh: isZh(),
      ua: String((W.navigator && W.navigator.userAgent) || '').slice(0, 160)
    })
  }

  var api = {
    version: VERSION,
    scan: scan,
    schedule: schedule,
    decoratePanel: decoratePanel,
    findPanels: findPanels,
    census: census,
    report: report,
    state: state,
    // 供离线探针使用的纯函数
    pure: {
      isPeakTime: isPeakTime,
      priceFor: priceFor,
      unitPrices: unitPrices,
      formatMoney: formatMoney,
      parseTokens: parseTokens,
      roleOfLabel: roleOfLabel,
      collectPairs: collectPairs,
      decoratePanel: decoratePanel,
      normLabel: normLabel,
      parseClockText: parseClockText,
      turnRefFromDom: turnRefFromDom,
      tierNote: tierNote
    }
  }
  W.__DSH_USAGE_COST__ = api

  if (W.document && W.document.documentElement) {
    if (W.document.readyState === 'loading') {
      W.document.addEventListener('DOMContentLoaded', start)
    } else {
      start()
    }
  }
})()

// 供离线探针（tools/probe-*.mjs）以经典脚本方式求值后取用；浏览器里是个普通全局。
