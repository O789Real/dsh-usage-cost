/**
 * 探针：价格表 / 峰谷规则 / 金额换算。
 * 直接抠 assets/usage-cost.js 里的实现来算（和小鲸鱼挂件 dsh-whale-widget/lib/index.js
 * 的 PRICING / isPeakTime 同源，两处数字必须一致）。
 *
 * 跑法：node tools/probe-pricing.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createEnv } from './mini-dom.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'assets', 'usage-cost.js')

let failures = 0
let checks = 0
function eq(label, actual, expected) {
  checks += 1
  const pass = actual === expected
  if (!pass) failures += 1
  console.log('  ' + (pass ? '✓' : '✗') + ' ' + label + ' → ' + JSON.stringify(actual) + (pass ? '' : '（期望 ' + JSON.stringify(expected) + '）'))
}

const env = createEnv({ lang: 'zh-CN' })
const ctx = vm.createContext(env.sandbox)
vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), ctx, { filename: 'usage-cost.js' })
const pure = env.sandbox.__DSH_USAGE_COST__.pure

const bj = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min, 0) / 1000 // 北京时间 → epoch 秒

console.log('\n[峰谷判定]')
eq('工作日 10:00（高峰）', pure.isPeakTime(bj(2026, 10, 8, 10)), true)
eq('工作日 09:00（高峰起点）', pure.isPeakTime(bj(2026, 10, 8, 9)), true)
eq('工作日 12:00（午休，谷）', pure.isPeakTime(bj(2026, 10, 8, 12)), false)
eq('工作日 15:00（高峰）', pure.isPeakTime(bj(2026, 10, 8, 15)), true)
eq('工作日 18:00（谷）', pure.isPeakTime(bj(2026, 10, 8, 18)), false)
eq('工作日 08:59（谷）', pure.isPeakTime(bj(2026, 10, 8, 8, 59)), false)
eq('周六 10:00（周末全天谷价）', pure.isPeakTime(bj(2026, 10, 10, 10)), false)
eq('周日 15:00（周末全天谷价）', pure.isPeakTime(bj(2026, 10, 11, 15)), false)
eq('国庆 10-01 10:00（法定节假日全天谷价）', pure.isPeakTime(bj(2026, 10, 1, 10)), false)
eq('调休上班的周六 10-10 10:00（谷）', pure.isPeakTime(bj(2026, 10, 10, 10)), false)

console.log('\n[模型 → 价目档位]')
eq('deepseek-flash', JSON.stringify(pure.priceFor('deepseek-flash')), JSON.stringify({ hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }))
eq('带 provider 前缀也能认', JSON.stringify(pure.priceFor('deepseek-account/deepseek-flash')), JSON.stringify({ hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }))
eq('旧名 deepseek-v4-flash', JSON.stringify(pure.priceFor('deepseek-v4-flash')), JSON.stringify({ hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }))
eq('deepseek-v4-pro', JSON.stringify(pure.priceFor('deepseek-v4-pro')), JSON.stringify({ hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] }))
eq('未知模型回落 Flash 档', JSON.stringify(pure.priceFor('something-else')), JSON.stringify({ hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }))

console.log('\n[单价（元/百万 token）]')
eq('Flash 高峰', JSON.stringify(pure.unitPrices('deepseek-flash', bj(2026, 10, 8, 10))), JSON.stringify({ uncachedInput: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }))
eq('Flash 谷价', JSON.stringify(pure.unitPrices('deepseek-flash', bj(2026, 10, 8, 13))), JSON.stringify({ uncachedInput: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }))
eq('Pro 高峰', JSON.stringify(pure.unitPrices('deepseek-v4-pro', bj(2026, 10, 8, 10))), JSON.stringify({ uncachedInput: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 }))

console.log('\n[token 文本解析]')
eq('1,036 tok', pure.parseTokens('1,036 tok'), 1036)
eq('886,912 tok', pure.parseTokens('886,912 tok'), 886912)
eq('0 tok', pure.parseTokens('0 tok'), 0)
eq('12.2K tok', pure.parseTokens('12.2K tok'), 12200)
eq('1.5M tok', pure.parseTokens('1.5M tok'), 1500000)
eq('1.2万 tok', pure.parseTokens('1.2万 tok'), 12000)
eq('读不出（—）', pure.parseTokens('—'), null)

console.log('\n[行标签识别]')
eq('未缓存输入', pure.roleOfLabel('未缓存输入'), 'uncachedInput')
eq('缓存读取', pure.roleOfLabel('缓存读取'), 'cacheRead')
eq('缓存写入', pure.roleOfLabel('缓存写入'), 'cacheWrite')
eq('输出', pure.roleOfLabel('输出'), 'output')
eq('缓存命中', pure.roleOfLabel('缓存命中'), 'cacheHit')
eq('提供方 / 模型', pure.roleOfLabel('提供方 / 模型'), 'model')
eq('Uncached input', pure.roleOfLabel('Uncached input'), 'uncachedInput')
eq('Cached input', pure.roleOfLabel('Cached input'), 'cacheRead')
eq('Cache write', pure.roleOfLabel('Cache write'), 'cacheWrite')
eq('Output', pure.roleOfLabel('Output'), 'output')
eq('无关标签', pure.roleOfLabel('本轮总用时'), null)

console.log('\n[金额格式]')
eq('0.000592', pure.formatMoney(0.000592), '¥0.000592')
eq('0.03547648', pure.formatMoney(0.03547648), '¥0.0355')
eq('2.1', pure.formatMoney(2.1), '¥2.10')
eq('12', pure.formatMoney(12), '¥12.00')
eq('0.000001', pure.formatMoney(0.000001), '<¥0.0001')
eq('0', pure.formatMoney(0), '¥0.00')

console.log('\n[合计自检：一组真实数据]')
{
  const u = pure.unitPrices('deepseek-flash', bj(2026, 10, 8, 10))
  const total = (296 / 1e6) * u.uncachedInput + (886912 / 1e6) * u.cacheRead + (0 / 1e6) * u.cacheWrite + (923 / 1e6) * u.output
  eq('本轮合计（高峰）', pure.formatMoney(total), '¥0.0435')
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项检查）')
process.exit(failures === 0 ? 0 : 1)
