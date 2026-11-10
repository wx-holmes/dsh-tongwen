// 回信助手（2026-11-09 08:40 起）：把「回错人」从自觉问题变成机械问题。
//
// 用它的原因：虫洞转发来的信，信头是 `[虫洞 · 08:33 · 来源:意识（生命）]`——
// 最显眼的位置是「虫洞」，真实来源在二级字段；而且信里没有可回复的地址或消息 id，
// 每次回信都要人脑挑一次收件人。挑错一次就误投，发送端也校验不出来。
//
// 这里的硬规矩：
//   1. 收件人必须是**完整地址**（dsh://session/... 或 qq://...），不接受名字——多个时空同名「韵柚」，按名字选必然歧义
//   2. `--re` 必须给信头里的**来源**那一项（原样抄），并在日志里把它和收件人对在一起
//   3. 抄进来的 `--re` 名字必须能在 `--to` 的地址里找到出处，否则拒绝发（exit 2）
//
// 用法：
//   node scripts\reply.mjs --re "意识（生命）" --to dsh://session/session-c8b82b3a-... --text "..."
//   node scripts\reply.mjs --re "虫洞" --to 虫洞 --text "..."        ← 会被拒：不认名字
//
// 日志：./tongwen\logs\通道\replies.jsonl

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SPACES = './tongwen\\logs\\state\\spaces.json'
const LOG = './tongwen\\logs\\通道\\replies.jsonl'
const SAY = 'C:\\tools\\wormhole\\bin\\say.mjs'
const NODE = 'C:\\ai\\node.exe'
const ME = process.env.DSH_SPACE_ADDRESS || `dsh://session/${process.env.DSH_SESSION_ID ?? ''}`

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return null
  const next = process.argv[i + 1]
  if (!next || next.startsWith('--')) return ''
  return next
}
const has = (n) => process.argv.includes(`--${n}`)

const re = arg('re')
const to = arg('to')
const text = arg('text')

const fail = (code, msg) => {
  console.error(msg)
  process.exit(code)
}

if (!re) fail(2, '缺 --re：把信头里的「来源:」那项原样抄进来（例如 --re "意识（生命）"）。没有它就分不清在回谁。')
if (!to) fail(2, '缺 --to：给完整地址（dsh://session/... 或 qq://...）。不接受名字。')
if (!text) fail(2, '缺 --text：要回的话。')

if (!/^(dsh:\/\/session\/|qq:\/\/)/.test(to)) {
  fail(2, `收件人必须是完整地址，不能是名字：${to}\n多个时空同名「韵柚」，按名字选必然歧义；请从 space_list 取地址。`)
}
if (to.startsWith('qq://') && !/^dsh:\/\/session\/session-cacb1b48/.test(ME)) {
  fail(2, '外部通道只有中枢能发（通道规则 §九）。你当前身份不是中枢。')
}

// 核验：--re 里给的名字，必须对应到 --to 这个地址（或至少是盘上登记过的时空名）
let known = []
try {
  const raw = JSON.parse(readFileSync(SPACES, 'utf8'))
  const arr = Array.isArray(raw) ? raw : Object.values(raw?.spaces ?? raw?.sessions ?? raw ?? {})
  known = arr.filter(Boolean).map((s) => ({
    name: s.name || s.title || s.displayName || '',
    address: s.address || (s.sessionId ? `dsh://session/${s.sessionId}` : ''),
  })).filter((s) => s.address)
} catch {
  known = []
}
const reRaw = String(re)
const isId = /^(wm_|dsh:\/\/|qq:\/\/)/.test(reRaw.trim())
const reClean = reRaw.replace(/[（(].*?[)）]/g, '').trim()

// --re 是消息 id 或地址时，不做名字核验（地址本身就是要核的东西）
if (!isId) {
  const hit = known.find((s) => s.name && (s.name.includes(reClean) || reClean.includes(s.name)))
  if (known.length && hit && hit.address && hit.address !== to) {
    fail(2, `对不上：--re「${re}」在盘上对应 ${hit.name} = ${hit.address}，但你 --to 填的是 ${to}。\n这就是发错人的机械形态——先改，再发。`)
  }
  if (known.length && !hit) {
    fail(2, `--re「${re}」在盘上找不到这个时空名。要么抄错名字，要么改用消息 id（wm_…）。`)
  }
}

const r = spawnSync(NODE, [SAY, '--to', to, '--from', ME === 'dsh://session/' ? '' : ME, '--text', text].filter(Boolean), { encoding: 'utf8' })
const ok = r.status === 0
mkdirSync(path.dirname(LOG), { recursive: true })
appendFileSync(LOG, JSON.stringify({
  at: new Date().toISOString(),
  re,
  to,
  from: ME,
  ok,
  status: r.status,
  chars: text.length,
  preview: text.slice(0, 60),
}) + '\n', 'utf8')

if (!ok) {
  console.error(r.stdout || '')
  console.error(r.stderr || '')
  console.error(`发送失败（exit ${r.status}）；已记日志 ${LOG}`)
  process.exit(r.status || 1)
}
console.log(r.stdout?.trim() || 'ok')
console.log(JSON.stringify({ ok: true, re, to, logged: LOG }))
