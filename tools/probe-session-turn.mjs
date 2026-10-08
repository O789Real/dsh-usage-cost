// 从会话日志里找出「本轮用量 = 7,288,570 tok」的那一轮，打印权威 usage 与时刻
import fs from 'node:fs'

const file = process.argv[2] || 'tmp_s71b.jsonl'
const target = Number(process.argv[3] || 7288570)
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)

const agg = new Map() // turn -> {buckets, time, model, steps}
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.type === 'turn/start') { agg.set(e.data.turn, { turn: e.data.turn, start: e.time, end: null, steps: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, models: new Set() }); continue }
  if (e.type === 'turn/end') { const a = agg.get(e.data.turn); if (a) a.end = e.time; continue }
  if (e.type !== 'assistant/message') continue
  const d = e.data || {}
  const u = d.usage
  if (!u) continue
  const turn = Number(d.turn)
  const a = agg.get(turn) || { turn, start: null, end: null, steps: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, models: new Set() }
  a.steps += 1
  a.uncached += Number(u.inputTokens) || 0
  a.cacheRead += Number(u.cacheReadTokens) || 0
  a.cacheWrite += Number(u.cacheWriteTokens) || 0
  a.output += Number(u.outputTokens) || 0
  const m = d.message && d.message.source && d.message.source.model
  if (m) a.models.add(m)
  a.lastMsgTime = e.time
  agg.set(turn, a)
}

const rows = [...agg.values()].filter((a) => a.steps > 0)
console.log('turn  steps  uncached    cacheRead   cacheWrite  output      total      本地时间(结束)')
for (const a of rows) {
  const total = a.uncached + a.cacheRead + a.cacheWrite + a.output
  const t = new Date(a.lastMsgTime || a.end || a.start || 0)
  const hit = total === target ? '   <== 命中目标' : ''
  console.log(String(a.turn).padStart(4) + '  ' + String(a.steps).padStart(5) + '  '
    + String(a.uncached).padStart(9) + '  ' + String(a.cacheRead).padStart(10) + '  '
    + String(a.cacheWrite).padStart(10) + '  ' + String(a.output).padStart(8) + '  '
    + String(total).padStart(11) + '  ' + t.toLocaleString('zh-CN') + hit
    + (a.models.size ? '  [' + [...a.models].join(',') + ']' : ''))
}
