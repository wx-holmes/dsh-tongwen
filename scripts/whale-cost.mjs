// 按「小鲸鱼」插件的余额/花费记录落账（2026-11-09 06:49 你定：以它为准）。
//
// 数据源：<DSH_HOME>\.dshw-usage.json
//   todayUsage        今天到目前为止的花费（元）
//   history[日期]     每天的花费（元）
//   lastBalance       最近一次余额（元）
//
// 纪律：
//   - 只落**已经过完的日期**（今天还在涨，零点后再记，避免记一半再改）
//   - ref = whale:<日期>，重复跑只回 deduped
//   - 不改旧行；数字有更正就补一条负数冲销
//
// 用法：
//   node scripts\whale-cost.mjs                 # 只打印（今天 + 最近几天）
//   node scripts\whale-cost.mjs --write         # 把已过完的日期写进账本
//   node scripts\whale-cost.mjs --write --since 2026-10-29

import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import path from 'node:path'

const SRC = '<DSH_HOME>\\.dshw-usage.json'
const LEDGER = './tongwen\\logs\\账本\\data\\records.jsonl'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : ''
}
const has = (n) => process.argv.includes(`--${n}`)

if (!existsSync(SRC)) {
  console.error(JSON.stringify({ ok: false, error: `找不到 ${SRC}` }))
  process.exit(2)
}
const data = JSON.parse(readFileSync(SRC, 'utf8'))
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const since = arg('since') || '2026-10-29'

const closed = Object.entries(data.history || {})
  .filter(([day]) => day < today && day >= since)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([day, cny]) => ({ day, amount: Math.round(Number(cny) * 100) / 100 }))

const total = Math.round(closed.reduce((s, x) => s + x.amount, 0) * 100) / 100

console.log(JSON.stringify({
  ok: true,
  source: SRC,
  today,
  liveTodayCny: data.todayUsage,
  balanceCny: data.lastBalance,
  closedDays: closed,
  closedTotalCny: total,
  wrote: false,
}, null, 2))

if (!has('write')) process.exit(0)

mkdirSync(path.dirname(LEDGER), { recursive: true })
const existing = existsSync(LEDGER)
  ? readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : []
const refs = new Set(existing.filter((r) => r?.type === 'cost' && r.data?.ref).map((r) => r.data.ref))

let appended = 0
let deduped = 0
for (const d of closed) {
  const ref = `whale:${d.day}`
  if (refs.has(ref)) { deduped += 1; continue }
  const rec = {
    type: 'cost',
    title: `${d.day} 全天花费`,
    at: new Date(`${d.day}T23:59:59+08:00`).toISOString(),
    data: {
      amount: d.amount,
      currency: 'CNY',
      kind: 'usage',
      project: 'unknown',
      purpose: '小鲸鱼插件当日合计（按你指定基准）',
      provider: 'deepseek',
      basis: 'real',
      ref,
    },
    source: 'dsh-whale-widget',
  }
  appendFileSync(LEDGER, JSON.stringify(rec) + '\n', 'utf8')
  appended += 1
}
console.log(JSON.stringify({ ok: true, appended, deduped, ledger: LEDGER }))
