// 记一笔「钱」：校验 → 去重 → 追加到账本。单一写者入口。
//
// 用法（宿主进程/中枢扣费钩子）：
//   node 插件目录\dsh-tongwen\scripts\record-cost.mjs --json '{"amount":0.83,"kind":"usage","project":"tongwen-plugin","purpose":"deepseek-chat · 41k tokens","provider":"deepseek","basis":"real","ref":"usage-1794176000123","session":"session-23491b66"}'
//   node ...\record-cost.mjs --dry --json '{...}'     只校验、打印，不写盘
//   node ...\record-cost.mjs --since 2026-11-09        按天汇总（读 records.jsonl 里的 cost）
//
// 规范：./tongwen\logs\账本\花费账本.md
// 规则：同一条流水只记一次（按 ref 去重）；没 ref 的允许记，但不参与去重。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const LEDGER = './tongwen\\logs\\账本\\data\\records.jsonl'
const KINDS = new Set(['usage', 'budget', 'payqr', 'payflow', 'manual'])
const BASIS = new Set(['real', 'estimate'])

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : ''
}
const has = (n) => process.argv.includes(`--${n}`)

function fail(code, msg) {
  console.error(JSON.stringify({ ok: false, code, error: msg }))
  process.exit(code)
}

function readCostLines() {
  if (!existsSync(LEDGER)) return []
  const out = []
  for (const line of readFileSync(LEDGER, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      if (rec?.type === 'cost') out.push(rec)
    } catch {
      // 坏行不影响记账；汇总时跳过
    }
  }
  return out
}

function validate(raw) {
  const errs = []
  const d = raw.data && typeof raw.data === 'object' ? raw.data : raw
  const num = Number(d.amount)
  if (!Number.isFinite(num)) errs.push('amount 必须是数字')
  if (!d.currency) errs.push('currency 必填（CNY）')
  if (!d.kind || !KINDS.has(String(d.kind))) errs.push(`kind 必须是 ${[...KINDS].join('|')}`)
  if (!d.project || String(d.project).trim() === '') errs.push('project 必填（说不出就写 unknown）')
  if (!d.purpose || String(d.purpose).trim() === '') errs.push('purpose 必填')
  if (!d.basis || !BASIS.has(String(d.basis))) errs.push('basis 必须是 real|estimate')
  if (errs.length) return { errs }
  return {
    errs: [],
    record: {
      type: 'cost',
      title: String(raw.title || d.purpose).slice(0, 120),
      at: raw.at || new Date().toISOString(),
      data: {
        amount: Math.round(num * 100) / 100,
        currency: String(d.currency).toUpperCase(),
        kind: String(d.kind),
        project: String(d.project),
        session: d.session ? String(d.session) : undefined,
        purpose: String(d.purpose),
        provider: d.provider ? String(d.provider) : undefined,
        basis: String(d.basis),
        ref: d.ref ? String(d.ref) : undefined,
      },
      source: String(raw.source || '中枢'),
    },
  }
}

if (has('since') || has('summary')) {
  const costs = readCostLines()
  const days = new Map()
  const dayOf = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  for (const c of costs) {
    const day = dayOf(c.at)
    const cur = days.get(day) || { real: 0, estimate: 0, n: 0, byProject: {} }
    const v = Number(c.data?.amount) || 0
    if (c.data?.basis === 'estimate') cur.estimate += v
    else cur.real += v
    cur.n += 1
    const p = c.data?.project || 'unknown'
    cur.byProject[p] = Math.round(((cur.byProject[p] || 0) + v) * 100) / 100
    days.set(day, cur)
  }
  const since = arg('since')
  const rows = [...days.entries()].filter(([d]) => !since || d >= since).sort()
  console.log(JSON.stringify({ ok: true, days: rows.map(([day, v]) => ({ day, ...v, total: Math.round((v.real + v.estimate) * 100) / 100 })) }, null, 2))
  process.exit(0)
}

const json = arg('json') || ''
if (!json) fail(2, '缺 --json（一条 cost 记录）')
let raw
try {
  raw = JSON.parse(json)
} catch (e) {
  fail(2, `--json 不是合法 JSON：${e.message}`)
}
const { errs, record } = validate(raw)
if (errs.length) fail(2, errs.join('；'))

const dup = record.data.ref ? readCostLines().find((c) => c.data?.ref === record.data.ref) : null
if (dup) {
  console.log(JSON.stringify({ ok: true, deduped: true, ref: record.data.ref, existingAt: dup.at, message: '同一条流水已记过，跳过' }))
  process.exit(0)
}

if (has('dry')) {
  console.log(JSON.stringify({ ok: true, dry: true, record }, null, 2))
  process.exit(0)
}

mkdirSync(path.dirname(LEDGER), { recursive: true })
appendFileSync(LEDGER, JSON.stringify(record) + '\n', 'utf8')
console.log(JSON.stringify({ ok: true, appended: true, at: record.at, amount: record.data.amount, project: record.data.project }))
