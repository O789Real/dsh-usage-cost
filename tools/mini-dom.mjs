/**
 * 极简 DOM 夹具：只实现 `assets/usage-cost.js` 真正用到的那点 API。
 * 目的不是模拟浏览器，而是让离线探针能在 Node 里跑真实的标注逻辑。
 */

class TextNode {
  constructor(value) {
    this.nodeType = 3
    this.nodeValue = String(value)
    this.parentNode = null
  }
  get textContent() { return this.nodeValue }
  set textContent(v) { this.nodeValue = String(v) }
}

class Element {
  constructor(tagName, doc) {
    this.nodeType = 1
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = doc
    this.childNodes = []
    this.attributes = {}
    this.parentNode = null
    this._className = ''
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1) }
  get className() { return this.attributes.class || '' }
  set className(v) { this.setAttribute('class', v) }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node)
    if (i >= 0) this.childNodes.splice(i, 1)
    node.parentNode = null
    return node
  }

  setAttribute(name, value) { this.attributes[String(name)] = String(value) }
  getAttribute(name) {
    const key = String(name)
    return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null
  }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, String(name)) }

  get textContent() {
    return this.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join('')
  }
  set textContent(value) {
    this.childNodes = []
    if (value !== '' && value !== null && value !== undefined) this.appendChild(new TextNode(value))
  }

  querySelectorAll(selector) { return this.ownerDocument.querySelectorAll(selector, this) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }

  /** 调试用：把子树还原成 HTML 串（探针断言失败时好读）。 */
  html() {
    const attrs = Object.keys(this.attributes)
      .map((k) => ` ${k}="${this.attributes[k]}"`)
      .join('')
    const inner = this.childNodes
      .map((n) => (n.nodeType === 3 ? n.nodeValue : n.html()))
      .join('')
    return `<${this.tagName.toLowerCase()}${attrs}>${inner}</${this.tagName.toLowerCase()}>`
  }
}

function parseSelector(selector) {
  const out = []
  const re = /([a-zA-Z][a-zA-Z0-9-]*)?((?:\[[^\]]+\])*)/g
  let m
  while ((m = re.exec(selector)) !== null) {
    if (!m[0]) { re.lastIndex += 1; continue }
    const attrs = []
    // 支持 [attr] / [attr="v"] / [attr*="v"] / [attr^=] / [attr$=] / [attr~=] / [attr|=]
    const attrRe = /\[([a-zA-Z0-9_:.-]+)\s*(?:([*^$~|]?=)\s*"?([^"\]]*?)"?)?\s*\]/g
    let a
    while ((a = attrRe.exec(m[2] || '')) !== null) {
      attrs.push({ name: a[1], op: a[2] || null, value: a[3] === undefined ? null : a[3] })
    }
    out.push({ tag: m[1] ? m[1].toUpperCase() : null, attrs })
  }
  return out
}

function matches(el, part) {
  if (part.tag && el.tagName !== part.tag) return false
  for (const attr of part.attrs) {
    if (!el.hasAttribute(attr.name)) return false
    if (attr.op === null) continue
    const actual = el.getAttribute(attr.name)
    const want = attr.value
    if (attr.op === '=' && actual !== want) return false
    if (attr.op === '*=' && actual.indexOf(want) === -1) return false
    if (attr.op === '^=' && actual.indexOf(want) !== 0) return false
    if (attr.op === '$=' && actual.slice(-want.length) !== want) return false
    if (attr.op === '~=' && actual.split(/\s+/).indexOf(want) === -1) return false
    if (attr.op === '|=' && actual !== want && actual.indexOf(want + '-') !== 0) return false
  }
  return true
}

class Document extends Element {
  constructor() {
    super('#document', null)
    this.ownerDocument = this
    this.readyState = 'complete'
    this.title = ''
    this._listeners = {}
    this.documentElement = new Element('html', this)
    this.head = new Element('head', this)
    this.body = new Element('body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
  }

  createElement(tag) { return new Element(tag, this) }
  createTextNode(text) { return new TextNode(text) }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn) }

  querySelectorAll(selector, root = this.documentElement) {
    const parts = parseSelector(selector)
    const last = parts[parts.length - 1]
    if (!last) return []
    const found = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue
        if (matches(child, last)) found.push(child)
        walk(child)
      }
    }
    walk(root)
    return found
  }
}

/** 造一个装了 DOM 的假 window；返回句柄供探针断言与手动触发定时器。 */
export function createEnv(options = {}) {
  const document = new Document()
  const intervals = new Map()
  const timeouts = new Map()
  let intervalSeq = 0
  let timeoutSeq = 0
  const fetchCalls = []
  const beacons = []

  const sandbox = {
    document,
    location: { href: options.url || 'dsh-app://app/' },
    navigator: { userAgent: 'probe/1.0', language: options.lang || 'zh-CN', languages: [options.lang || 'zh-CN'] },
    fetch: (url, opts) => {
      fetchCalls.push({ url, opts })
      if (String(url).indexOf('pricing.json') !== -1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(options.pricing || {})
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.records = [] }
      observe() { this.observed = true }
      disconnect() { this.observed = false }
      takeRecords() { const r = this.records; this.records = []; return r }
    },
    setInterval: (fn, ms) => {
      const id = ++intervalSeq
      intervals.set(id, { fn, ms })
      return id
    },
    clearInterval: (id) => { intervals.delete(id) },
    setTimeout: (fn, ms) => {
      const id = ++timeoutSeq
      timeouts.set(id, { fn, ms })
      return id
    },
    clearTimeout: (id) => { timeouts.delete(id) },
    addEventListener: () => {},
    console
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  return {
    sandbox,
    document,
    fetchCalls,
    beacons,
    intervals,
    timeouts,
    runInterval(id) { const e = intervals.get(id); if (e) e.fn() },
    runAllIntervals() { for (const e of intervals.values()) e.fn() },
    runAllTimeouts() {
      for (const [id, e] of Array.from(timeouts.entries())) { timeouts.delete(id); e.fn() }
    }
  }
}
