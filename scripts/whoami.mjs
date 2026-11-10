// 我是谁：一句话回答「本时空是不是中枢」（2026-11-09 08:54，你要求先区分中枢与其他时空）。
//
// 依据：中枢只有一个会话地址，写在 ./tongwen\logs\state\hub.json 里（单点真相）。
// 判断只认会话 id，不认名字——所有时空都叫「韵柚」，名字没法区分。
//
// 用法：
//   node scripts\whoami.mjs          # 人看的
//   node scripts\whoami.mjs --json   # 机器用的

import { existsSync, readFileSync } from 'node:fs'

const HUB_FILE = './tongwen\\logs\\state\\hub.json'
const MY_SESSION = process.env.DSH_SESSION_ID || ''
const MY_ADDRESS = `dsh://session/${MY_SESSION}`

let hub = null
try {
  hub = JSON.parse(readFileSync(HUB_FILE, 'utf8'))
} catch {
  hub = null
}

const hubAddress = hub?.address ?? 'dsh://session/session-cacb1b48-1fb6-434e-a1ef-b196e483eb51'
const hubSession = hubAddress.replace('dsh://session/', '')
const isHub = Boolean(MY_SESSION) && MY_SESSION === hubSession

let name = '（未登记）'
try {
  const raw = JSON.parse(readFileSync('./tongwen\\logs\\state\\spaces.json', 'utf8'))
  const arr = Array.isArray(raw) ? raw : Object.values(raw?.spaces ?? raw ?? {})
  const me = arr.find((s) => (s?.sessionId === MY_SESSION) || (s?.address || '').endsWith(MY_SESSION))
  if (me) name = me.name || me.title || name
} catch {
  /* 名字查不到不影响判断 */
}

const result = {
  ok: true,
  sessionId: MY_SESSION || null,
  address: MY_ADDRESS,
  name,
  isHub,
  role: isHub ? '中枢（唯一可以写共享记忆卡、唯一可以往外部通道发的那个）' : '普通时空（不写共享卡、不发外部通道）',
  hubAddress,
  rule: 'handoff/手册/通道规则.md §九 · handoff/手册/时空边界.md §七',
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`我是「${name}」  ${MY_ADDRESS}`)
  console.log(isHub ? '身份：中枢' : '身份：普通时空')
  console.log(`中枢地址：${hubAddress}`)
  console.log(`能做的：${isHub ? '写共享记忆卡、往 聊天/外部通道发' : '不写共享卡、不发外部通道；要发先问你'}`)
}
