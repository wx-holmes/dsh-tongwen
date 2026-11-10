// 读信封：这条消息到底是给谁的？（2026-11-09 09:59 改为共用 header 模块）
//
// 为什么需要它：转发件不写收件人时，每个时空都会把「你……」读成对自己说的。
// 格式只认一份：外部通道工具的 src/message-header.mjs（白板 channel-rules #4）
//
// 用法：
//   node scripts\mailcheck.mjs --head "[来源:意识（生命）(session-c8b82b3a) · 收件人:书同文（韵柚）(session-23491b66) · 08:57 · id:wm_1]"
//   node scripts\mailcheck.mjs --head "..." --json

import { parseHeader } from 'file:///A:/tools/wormhole/src/message-header.mjs'

const MY_SESSION = process.env.DSH_SESSION_ID || ''

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return null
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : ''
}

const head = arg('head') ?? ''
if (!head) {
  console.error('缺 --head：把消息第一行的信封原样贴进来')
  process.exit(2)
}

const shortOf = (s) => {
  const m = String(s ?? '').match(/session-([0-9a-f]{8})/i)
  return m ? m[1] : null
}

const parsed = parseHeader(head)
if (!parsed) {
  console.log(JSON.stringify({ ok: false, code: 'bad-header', head, rule: 'handoff/手册/通道规则.md §三' }, null, 2))
  process.exit(2)
}

const { sender, recipient, at, msgId, broadcast } = parsed
const myShort = shortOf(MY_SESSION)
const toShort = shortOf(recipient)

let verdict
let action
if (broadcast) {
  verdict = 'broadcast'
  action = '广播/通知：只当知情，不认领任务，不回复'
} else if (!recipient) {
  verdict = 'no-recipient'
  action = '缺收件人：不认领任务，回一条问清楚再办'
} else if (toShort && myShort && toShort === myShort) {
  verdict = 'mine'
  action = '这封是给我的：可以办，回信带 --re <id>'
} else {
  verdict = 'not-mine'
  action = '不是给我的：不动手；要看情况回一句「我不是收件人」'
}

const result = {
  ok: true,
  head: parsed.raw,
  sender,
  recipient: recipient ?? null,
  at: at ?? null,
  msgId,
  mySession: MY_SESSION || null,
  verdict,
  action,
  rule: 'handoff/手册/通道规则.md §四',
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`来源：${sender ?? '（未写）'}`)
  console.log(`收件人：${recipient ?? '（未写）'}`)
  console.log(`时间：${at ?? '（未写）'}`)
  console.log(`消息 id：${msgId ?? '（未写）'}`)
  console.log(`判定：${verdict}`)
  console.log(`该做什么：${action}`)
}
