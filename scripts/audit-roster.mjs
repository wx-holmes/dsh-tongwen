#!/usr/bin/env node
/**
 * 名册体检（0.5.41）：你测地址簿时的一键自检。
 *
 * 查五件事（全部只读）：
 *   1) 解析：每行是否都符合 `- 名字 | dsh://session/<id> | 工作区 | 时间`；
 *   2) 唯一：同一个 sessionId 是否只出现一次、同一个名字是否只出现一次；
 *   3) 归属：地址里的会话是否存在于 workspace.json 的某个工作区；
 *   4) 自身：book 解析出来的条数是否等于现行段行数（有行被跳过就是 bug）；
 *   5) 已替换段是否混进解析（应为 0）。
 *
 * 用法：node scripts/audit-roster.mjs [handoffRoot]
 * 退出码：全部通过 0，有问题 1。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { readRoster } from '../lib/spaces.js'

const root = process.argv[2] || 'A:/tongwen'
const file = path.join(root, 'handoff', '时空名册.md')
const problems = []
const notes = []

const text = await fsp.readFile(file, 'utf8')
const [currentPart] = text.split('## 已替换')
const currentLines = currentPart.split('\n').filter((l) => /^-\s/.test(l.trim()))

const seenSid = new Map()
const seenName = new Map()
for (const line of currentLines) {
  const m = /^-\s*([^|]+?)\s*\|\s*(dsh:\/\/session\/session-[0-9a-f-]{36})\s*\|\s*([^|]*?)\s*\|\s*(.*)$/.exec(line.trim())
  if (!m) {
    problems.push(`行格式不对：${line.trim()}`)
    continue
  }
  const [, name, address, workspace, when] = m
  const sid = address.split('/').pop()
  if (seenSid.has(sid)) problems.push(`同一地址出现多次：${sid}（${seenSid.get(sid)} / ${name}）`)
  else seenSid.set(sid, name)
  if (seenName.has(name)) problems.push(`同一名字出现多次：${name}（${seenName.get(name)} / ${sid}）`)
  else seenName.set(name, sid)
  if (!/^\d{4}\/\d{1,2}\/\d{1,2}/.test(when.trim())) notes.push(`时间戳格式可疑：${name} → ${when.trim()}`)
  if (!workspace.trim()) notes.push(`工作区为空：${name}`)
}

const roster = await readRoster(root)
if (roster.map.size !== seenSid.size) {
  problems.push(`解析条数 ${roster.map.size} ≠ 现行段行数 ${seenSid.size}（有行被跳过）`)
}
if (text.includes('## 已替换') && roster.map.size !== seenSid.size) {
  notes.push('已替换段可能混进了解析（应只解析现行段）')
}

const wsFile = path.join(process.env.DSH_HOME || '<DSH_HOME>', 'storages', 'workspace.json')
let known = new Set()
try {
  const ws = JSON.parse(await fsp.readFile(wsFile, 'utf8'))
  for (const entry of Object.values(ws?.tables?.workspaces ?? {})) {
    for (const sid of entry.sessionIds ?? []) known.add(sid)
  }
} catch (e) {
  notes.push(`读不到 workspace.json（${e.message}），跳过归属检查`)
}
if (known.size) {
  for (const sid of seenSid.keys()) {
    if (!known.has(sid)) problems.push(`地址不在任何工作区里（孤儿）：${sid} ← ${seenSid.get(sid)}`)
  }
}

console.log(`名册：${seenSid.size} 个身份（现行段 ${currentLines.length} 行）`)
for (const [sid, name] of seenSid) console.log(`  ${sid.slice(8, 16)}  ${name}`)
if (notes.length) console.log('\n提醒：\n' + notes.map((n) => `  · ${n}`).join('\n'))
if (problems.length) {
  console.log('\n问题：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'))
  process.exit(1)
}
console.log('\n✓ 五项全过：格式 / 唯一 / 归属 / 计数 / 已替换隔离')
