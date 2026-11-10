// 命令行入口：只做参数解析，逻辑全在 lib/sync.js（和开场注入共用一份）
//
//   node sync-check.mjs --manifest                     重建清单快照（给人看）
//   node sync-check.mjs --session <sid> [--brief]       全量差异 / 一行相关提示
//   node sync-check.mjs --session <sid> --ack <path>    这条读过了，别再说
//   node sync-check.mjs --session <sid> --related a,b   临时追加相关文件
//   node sync-check.mjs --who                          每个时空的落后状态

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  collectFiles,
  versionOf,
  refresh,
  syncBrief,
  loadState,
  saveState,
  stateFile,
} from '../lib/sync.js'

const ROOT = process.env.TONGWEN_ROOT || './tongwen'
const STATE = path.join(ROOT, 'logs', 'state')
const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
const sid = arg('--session')

if (argv.includes('--manifest')) {
  const files = collectFiles(ROOT)
  const v = versionOf(files)
  mkdirSync(STATE, { recursive: true })
  writeFileSync(
    path.join(STATE, 'sync-manifest.json'),
    JSON.stringify({ version: v, builtAt: new Date().toISOString(), files: Object.fromEntries(Object.entries(files).map(([k, x]) => [k, x.h])) }, null, 2),
    'utf8',
  )
  console.log(`manifest ${v} files=${Object.keys(files).length}`)
} else if (argv.includes('--who')) {
  const dir = path.join(STATE, 'sync')
  let n = 0
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      let s = {}
      try {
        s = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
      } catch {
        /* 坏文件跳过 */
      }
      const pend = (s.pending || []).length
      console.log(`${f.replace(/\.json$/, '')}  pending=${pend}  seen=${s.version ?? '-'}  at=${s.sawAt ?? '-'}`)
      n++
    }
  } catch {
    /* 没人对齐过 */
  }
  if (!n) console.log('(no session has synced yet)')
} else if (sid && arg('--ack')) {
  const st = loadState(ROOT, sid)
  const before = (st.pending || []).length
  st.pending = (st.pending || []).filter((p) => p.path !== arg('--ack').replace(/\\/g, '/'))
  saveState(ROOT, sid, st)
  console.log(`ack ${arg('--ack')} (${before} -> ${st.pending.length})`)
} else if (sid) {
  if (argv.includes('--brief')) {
    const line = syncBrief(ROOT, sid, new Set((arg('--related') || '').split(',').map((s) => s.trim()).filter(Boolean)))
    if (line) console.log(line)
  } else {
    const r = refresh(ROOT, sid)
    console.log(`version: now=${r.state.version} files=${Object.keys(r.state.files).length}${r.firstRun ? ' (first run: baseline)' : ''}`)
    if (r.changed.length) console.log(`changed(${r.changed.length}): ${r.changed.join(', ')}`)
    if (r.added.length) console.log(`added(${r.added.length}): ${r.added.join(', ')}`)
    if (r.removed.length) console.log(`removed(${r.removed.length}): ${r.removed.join(', ')}`)
    const pend = r.state.pending || []
    if (pend.length) console.log(`pending(${pend.length}): ${pend.map((p) => `${path.basename(p.path)}${p.shown ? '*' : ''}`).join(', ')}`)
  }
} else {
  console.log('usage: --manifest | --who | --session <sid> [--brief] [--ack path] [--related a,b]')
}
