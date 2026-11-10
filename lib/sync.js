// 信息同步的公共实现：收集 → 比版本 → 只给相关的那一条。
// 派生状态，随时可丢；事实永远在盘上。CLI（scripts/sync-check.mjs）和开场注入共用这一份。

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const ALWAYS = [
  'handoff/时空名册.md',
  'handoff/能力卡.md',
  'handoff/手册/通道规则.md',
  'handoff/手册/交接规范.md',
  'handoff/手册/时空边界.md',
]
const WATCH = ['handoff/动态白板.md', 'handoff/README.md']
const WATCH_DIRS = ['handoff/projects', 'handoff/手册']
const IGNORE = /\.bak|\.old$|~$|\.tmp$/
const MAX_SHOW = 3
const EXPIRE_MS = 24 * 3600 * 1000

export function hashFile(file) {
  try {
    const buf = readFileSync(file)
    return { h: createHash('sha256').update(buf).digest('hex').slice(0, 12), size: buf.length, mtimeMs: statSync(file).mtimeMs }
  } catch {
    return null
  }
}

export function collectFiles(root) {
  const files = {}
  const add = (rel) => {
    if (IGNORE.test(rel)) return
    const v = hashFile(path.join(root, rel))
    if (v) files[rel.replace(/\\/g, '/')] = v
  }
  for (const rel of [...WATCH, ...ALWAYS]) add(rel)
  for (const dir of WATCH_DIRS) {
    let entries = []
    try {
      entries = readdirSync(path.join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) if (e.isFile() && e.name.endsWith('.md')) add(path.join(dir, e.name))
  }
  return files
}

export function versionOf(files) {
  const sorted = Object.keys(files).sort().map((k) => `${k}:${files[k].h}`)
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 12)
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 谁的一棒交给了我 → 那些项目白板算相关 */
export function myProjects(root, sid) {
  const dir = path.join(root, 'handoff', 'projects')
  const mine = new Set()
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return mine
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue
    let text = ''
    try {
      text = readFileSync(path.join(dir, f), 'utf8')
    } catch {
      continue
    }
    const m = text.match(/##\s*当前一棒\s*\n([\s\S]*?)(\n##\s|$)/)
    if (!m) continue
    const to = (m[1].match(/交给[：:]\s*(.+)/) || [])[1]?.trim() ?? ''
    // 地址可能带或不带 session- 前缀，白板里两种写法都见过：只认 UUID 那一段
    if (to.includes(sid.replace(/^session-/, ''))) mine.add(`handoff/projects/${f}`)
  }
  return mine
}

export function isRelevant(root, rel, sid, extra = new Set()) {
  if (ALWAYS.includes(rel)) return true
  if (extra.has(rel)) return true
  return myProjects(root, sid).has(rel)
}

export function stateFile(root, sid) {
  return path.join(root, 'logs', 'state', 'sync', `${sid}.json`)
}

export function loadState(root, sid) {
  return readJson(stateFile(root, sid), { version: null, files: {}, pending: [] })
}

export function saveState(root, sid, state) {
  mkdirSync(path.dirname(stateFile(root, sid)), { recursive: true })
  writeFileSync(stateFile(root, sid), JSON.stringify(state, null, 2), 'utf8')
}

/** 比一次；返回 {state, firstRun, changed, added, removed}。会写回状态。 */
export function refresh(root, sid) {
  const files = collectFiles(root)
  const state = loadState(root, sid)
  const prev = state.files || {}
  const firstRun = !state.version
  const pending = (state.pending || []).filter((p) => Date.now() - (p.at || 0) < EXPIRE_MS)
  const changed = []
  const added = []
  const removed = []
  for (const [rel, v] of Object.entries(files)) {
    const oldH = prev[rel]?.h ?? prev[rel]
    if (!oldH) added.push(rel)
    else if (oldH !== v.h) changed.push(rel)
  }
  for (const rel of Object.keys(prev)) if (!files[rel]) removed.push(rel)
  const touched = firstRun ? [] : [...changed, ...added]
  for (const rel of touched) {
    const h = files[rel].h
    const seen = pending.find((p) => p.path === rel)
    if (seen && seen.h === h) continue
    const at = Date.now()
    if (seen) Object.assign(seen, { h, at, shown: 0 })
    else pending.push({ path: rel, h, at, shown: 0 })
  }
  for (const rel of removed) {
    const i = pending.findIndex((p) => p.path === rel)
    if (i >= 0) pending.splice(i, 1)
  }
  state.files = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.h]))
  state.version = versionOf(files)
  state.pending = pending.slice(-20)
  state.sawAt = new Date().toISOString()
  saveState(root, sid, state)
  return { state, firstRun, changed, added, removed, files }
}

/**
 * 开场注入要的那一行：「同步：X 有变（读一下再干）」。
 * 没有相关变更时返回 null（一个字都不出现）。
 */
export function syncBrief(root, sid, extra = new Set()) {
  const r = refresh(root, sid)
  if (r.firstRun) return null
  // 2026-11-09 23:21 修：显示**不消耗**。
  // 原来一显示就写 shown=1，结果同一轮里若 buildPrimer 被调用两次（宿主会这样），
  // 第二次就返回 null，而模型拿到的是第一次的缓存提示——提示被「吃掉」但没人看见。
  // 现在只有显式 --ack 才清；6 小时未被 ack 自动过期，避免永久纠缠。
  const hot = r.state.pending
    .filter((p) => !p.acked && Date.now() - (p.at || 0) < 6 * 3600 * 1000 && isRelevant(root, p.path, sid, extra))
    .slice(0, MAX_SHOW)
  if (!hot.length) return null
  const names = hot.slice(0, 2).map((p) => path.basename(p.path, '.md')).join('、')
  const more = hot.length > 2 ? ` 等 ${hot.length} 份` : ''
  return `同步：${names}${more} 有变（读完跑 sync-check --ack；不读会一直提醒）`
}
