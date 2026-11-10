// 把 sur 的 token 用量按**官方价目表**折成钱，再交给 record-cost 落账。
//
// 价目口径来自 lib/model-prices.js（从 sur 吸收进本插件，照官方文档维护，单位：元/百万 token）：
//   扣费 = Σ(各桶 token × 单价)，三个桶互不重叠：cacheMiss / cacheHit(+cacheWrite) / output
//   空闲时段单价 = 高峰的一半；高峰 = 北京时间周一至周五 9:00-12:00、14:00-18:00，且非法定节假日
//   来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
//
// 用法：
//   node scripts\price-usage.mjs --day 2026-11-09          # 只算，打印
//   node scripts\price-usage.mjs --day 2026-11-09 --write  # 逐时空落账（type=cost, basis=real）
//   node scripts\price-usage.mjs --day 2026-11-09 --by-project --write   按项目聚合
//
// 说明：sur 的 token-usage.jsonl 每 turn 一行，带 sid / model / b{cacheMiss,cacheHit,output,reasoning}。
// 已记过的同一天同一天空不会重复写：ref = usage:<day>:<sid 或 project>，靠 record-cost 的 ref 去重。

import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = './tongwen\\logs\\账本\\考古\\token-usage.jsonl'
const PRICES = '插件目录\\dsh-tongwen\\lib\\model-prices.js'
const LEDGER = './tongwen\\logs\\账本\\data\\records.jsonl'
const KINDS = new Set(['usage'])

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : ''
}
const has = (n) => process.argv.includes(`--${n}`)

if (!existsSync(USAGE)) {
  console.error(JSON.stringify({ ok: false, error: `找不到用量文件：${USAGE}` }))
  process.exit(2)
}
const { priceUsage, PRICE_TABLE_VERSION } = await import(pathToFileURL(PRICES).href)

const day = arg('day') || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const byProject = has('by-project')
const write = has('write')

const dayOf = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })

const rows = []
for (const line of readFileSync(USAGE, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  let r
  try {
    r = JSON.parse(line)
  } catch {
    continue
  }
  const at = r.at || r.ts || r.time || r.t
  if (!at) continue
  if (dayOf(at) !== day) continue
  const b = r.b || r.buckets || {}
  const buckets = {
    cacheMiss: Number(b.cacheMiss ?? 0),
    cacheHit: Number(b.cacheHit ?? 0),
    cacheWrite: Number(b.cacheWrite ?? 0),
    output: Number(b.output ?? 0),
    reasoning: Number(b.reasoning ?? 0),
  }
  const cny = priceUsage(buckets, { model: r.model, at: new Date(at) })
  rows.push({
    at,
    sid: r.sid || r.sessionId || 'unknown',
    model: r.model || 'unknown',
    tokens: buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite + buckets.output,
    cny,
  })
}

const key = (r) => (byProject ? r.project : r.sid)
// 项目归属：暂时没有 sid→项目 的映射表，按项目聚合时统一记 unknown（purpose 里留 sid 列表）
const groups = new Map()
for (const r of rows) {
  const k = byProject ? 'unknown' : r.sid
  const g = groups.get(k) || { amount: 0, tokens: 0, turns: 0, models: new Set(), sids: new Set() }
  g.amount += r.cny
  g.tokens += r.tokens
  g.turns += 1
  g.models.add(r.model)
  g.sids.add(r.sid)
  groups.set(k, g)
}

const out = [...groups.entries()]
  .map(([k, g]) => ({
    key: k,
    amount: Math.round(g.amount * 10000) / 10000,
    tokens: g.tokens,
    turns: g.turns,
    models: [...g.models],
    sessions: [...g.sids].slice(0, 20),
  }))
  .sort((a, b) => b.amount - a.amount)

const total = Math.round(out.reduce((s, x) => s + x.amount, 0) * 10000) / 10000
console.log(JSON.stringify({
  ok: true,
  day,
  priceTable: PRICE_TABLE_VERSION,
  source: USAGE,
  totalCny: total,
  groups: out,
  wrote: false,
}, null, 2))

if (!write) process.exit(0)

// 落账：每个分组合成一条 cost，ref 由 day+key 决定，重复跑不会重复记
mkdirSync(path.dirname(LEDGER), { recursive: true })
let appended = 0
let deduped = 0
const existing = existsSync(LEDGER)
  ? readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : []
const refs = new Set(existing.filter((r) => r?.type === 'cost' && r.data?.ref).map((r) => r.data.ref))

for (const g of out) {
  if (g.amount <= 0) continue
  const ref = `usage:${day}:${g.key}`
  if (refs.has(ref)) {
    deduped += 1
    continue
  }
  const rec = {
    type: 'cost',
    title: `${day} ${g.key} 花费`,
    at: new Date().toISOString(),
    data: {
      amount: Math.round(g.amount * 100) / 100,
      currency: 'CNY',
      kind: 'usage',
      project: byProject ? 'unknown' : undefined,
      session: byProject ? undefined : g.key,
      purpose: `${g.turns} 轮 / ${g.tokens} tokens / ${g.models.join(',')}（官方价目表 ${PRICE_TABLE_VERSION}）`,
      provider: 'deepseek',
      basis: 'real',
      ref,
    },
    source: '书同文·price-usage',
  }
  appendFileSync(LEDGER, JSON.stringify(rec) + '\n', 'utf8')
  appended += 1
}
console.log(JSON.stringify({ ok: true, appended, deduped, ledger: LEDGER }))
