/**
 * 时空在场感知（0.5.5）。
 *
 * 为什么有这个东西：重启会杀掉**所有**时空。以前只能拍一个固定延迟（75 秒保险、
 * 25 秒最快），不管现场有没有别人在干活——一个人在电脑前也要等一分多钟，
 * 而真正忙的时候 25 秒又可能把别人写到一半的交接撕了。
 *
 * 现在：先看现场，再决定等多久。
 *
 * 看什么（不靠猜，都是磁盘上现成的痕迹）：
 *   ① 会话库 mtime：<DSH_HOME>\sessions\<工作区>\<session-xxxx>\*.jsonl，每次工具调用/
 *      消息都会追加，所以「最大 mtime」≈ 这个时空最后一次动的时间（秒级）。
 *   ② open-tasks.json：本插件在 begin_task 时记一笔、end_task 时划掉——用来区分
 *      「闲着」和「开着任务干到一半」。
 *
 * 三档（阈值写死，见 TIER_* / WARM_MS / IDLE_MS）：
 *   - 慢 75 秒：有别的时空开着任务没收尾、且 2 分钟内动过（最可能正在写文件）
 *   - 常 45 秒：有别的时空 2 分钟内动过（可能正在写，但没开任务记录）
 *   - 快 25 秒：别的时空都静默超过 5 分钟（或者根本不存在）
 *
 * 边界（必须说清）：mtime 只能说明「最近有没有动」，不能保证「此刻不在写盘」。
 * 25 秒那档的保险是「对方已经静默 5 分钟以上」，不是「保证不撞」。
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const OPEN_TASKS_REL = 'logs/state/open-tasks.json'
export const TIER_FAST_SEC = 25
export const TIER_NORMAL_SEC = 45
export const TIER_SLOW_SEC = 75
/** 别的时空 2 分钟内动过 → 当它「可能在写」。 */
export const WARM_MS = 2 * 60 * 1000
/** 静默超过 5 分钟 → 当它「已经停手」。 */
export const IDLE_MS = 5 * 60 * 1000

/** 会话库根目录（DSH_HOME/sessions，退回 ~/.dsh/sessions）。 */
export function sessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/** 一个目录下所有文件里最新的 mtime（深一点，会话目录里还有子目录）。 */
function latestMtimeUnder(dir, depth = 0) {
  if (depth > 3) return 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let best = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = latestMtimeUnder(full, depth + 1)
      if (inner > best) best = inner
      continue
    }
    try {
      const st = statSync(full).mtimeMs
      if (st > best) best = st
    } catch {
      /* 文件可能刚被删 */
    }
  }
  return best
}

/**
 * 扫一遍会话库，返回每个时空最后活动时间。
 *
 * @param {{root?: string, now?: number, selfSessionId?: string}} [options]
 * @returns {{sessionId: string, lastActiveAt: number, ageMs: number}[]}
 */
export function scanSpaces({ root = sessionsRoot(), now = Date.now(), selfSessionId = '' } = {}) {
  const latest = scanAllSpaces({ root })
  const self = String(selfSessionId || '')
  return [...latest.entries()]
    .filter(([sessionId]) => sessionId !== self)
    .map(([sessionId, lastActiveAt]) => ({ sessionId, lastActiveAt, ageMs: Math.max(0, now - lastActiveAt) }))
    .sort((a, b) => a.ageMs - b.ageMs)
}

/** 内部：扫全部会话（含自己）→ Map<sessionId, lastActiveAt> */
function scanAllSpaces({ root = sessionsRoot() } = {}) {
  const latest = new Map()
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (/^session-/.test(entry.name)) {
        const at = latestMtimeUnder(full)
        if (at > 0) {
          const prev = latest.get(entry.name) ?? 0
          if (at > prev) latest.set(entry.name, at)
        }
        continue
      }
      walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return latest
}

/**
 * 我自己最后一次动是多少毫秒前（0.5.36）。
 *
 * 为什么要它：`scanSpaces` 按设计过滤掉自己，于是「现场只有我在动」被读成「安全」——
 * 可实际上「我在动」=「我还在思考/还在写」，这就是 2026-11-08 03:10 那次自己杀自己的原因。
 * 重启决策必须把自己的活跃当成**危险信号**，不是安全信号。
 *
 * @param {{root?: string, selfSessionId?: string, now?: number}} [options]
 * @returns {number|null} 毫秒；不知道自己是谁或没有会话文件时返回 null
 */
export function selfLastActiveMs({ root = sessionsRoot(), selfSessionId = '', now = Date.now() } = {}) {
  const self = String(selfSessionId || '')
  if (!self) return null
  const latest = scanAllSpaces({ root })
  const at = latest.get(self)
  if (!at) return null
  return Math.max(0, now - at)
}

/** open-tasks.json 的路径。 */
export function openTasksPath(ctx) {
  return path.join(ctx.root, OPEN_TASKS_REL)
}

/** 读「开了任务还没收尾」的登记（坏了就当没有，不拖垮重启）。 */
export function readOpenTasksSync(ctx) {
  try {
    const parsed = JSON.parse(readFileSync(openTasksPath(ctx), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeOpenTasksSync(ctx, table) {
  try {
    mkdirSync(path.dirname(openTasksPath(ctx)), { recursive: true })
    writeFileSync(openTasksPath(ctx), `${JSON.stringify(table, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 开了任务：记一笔（给别的时空的重启判断用）。失败就算了，不影响主流程。 */
export function markTaskOpen(ctx, { sessionId, taskId, displayName, project } = {}) {
  const key = String(sessionId || '')
  if (!key) return false
  const table = readOpenTasksSync(ctx)
  table[key] = {
    taskId: String(taskId || ''),
    displayName: String(displayName || ''),
    project: String(project || ''),
    startedAt: new Date().toISOString(),
  }
  return writeOpenTasksSync(ctx, table)
}

/** 任务收尾：划掉。 */
export function clearTaskOpen(ctx, sessionId) {
  const key = String(sessionId || '')
  if (!key) return false
  const table = readOpenTasksSync(ctx)
  if (!(key in table)) return false
  delete table[key]
  return writeOpenTasksSync(ctx, table)
}

/** 「4 分钟前」这种人话。 */
function ageText(ageMs) {
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))} 秒前`
  if (ageMs < 3600_000) return `${Math.round(ageMs / 60_000)} 分钟前`
  return `${Math.round(ageMs / 3600_000)} 小时前`
}

/**
 * 按现场决定这次重启该等多久。
 *
 * @param {{ctx: any, selfSessionId?: string, now?: number, root?: string}} options
 * @returns {{tier: 'fast'|'normal'|'slow', delaySec: number, label: string,
 *            reasons: string[], spaces: object[], busy: object[], others: number}}
 */
export function decideRestartDelay({ ctx, selfSessionId = '', now = Date.now(), root = sessionsRoot() } = {}) {
  const spaces = scanSpaces({ root, now, selfSessionId })
  const tasks = readOpenTasksSync(ctx)
  const warm = spaces.filter((s) => s.ageMs <= WARM_MS)
  const busy = warm.filter((s) => tasks[s.sessionId])
  const reasons = []

  let tier = 'fast'
  let delaySec = TIER_FAST_SEC
  let label = '快档（别的时空都静默、我也停了）'

  if (busy.length > 0) {
    tier = 'slow'
    delaySec = TIER_SLOW_SEC
    label = '慢档（有别的时空开着任务）'
    for (const s of busy.slice(0, 3)) {
      const t = tasks[s.sessionId] ?? {}
      const what = t.displayName || t.taskId || '未知任务'
      reasons.push(`${s.sessionId} 开着「${what}」还没收尾，${ageText(s.ageMs)}还在动`)
    }
  } else if (warm.length > 0) {
    tier = 'normal'
    delaySec = TIER_NORMAL_SEC
    label = '常档（有别的时空刚动过）'
    for (const s of warm.slice(0, 3)) reasons.push(`${s.sessionId} ${ageText(s.ageMs)}动过，可能正在写`)
  } else {
    reasons.push(
      spaces.length === 0
        ? '会话库里没有别的时空'
        : `别的 ${spaces.length} 个时空都静默超过 ${Math.round(IDLE_MS / 60_000)} 分钟`,
    )
  }

  // 0.5.36：我自己也是「可能在写」的一方。scanSpaces 按设计不看自己，
  // 于是「别人都静默」容易被读成「可以快」——可我自己刚写过，就说明我还在这一轮里干活。
  // 这条必须放在最后，覆盖前面所有「快档」判断。
  const selfAgeMs = selfLastActiveMs({ root, selfSessionId, now })
  if (selfAgeMs !== null && selfAgeMs < WARM_MS) {
    tier = 'slow'
    delaySec = TIER_SLOW_SEC
    label = '慢档（我自己还在写）'
    reasons.push(`我自己 ${ageText(selfAgeMs)}刚写过——重启会杀掉正在思考的这一轮，不许给自己按快档`)
  }

  return { tier, delaySec, label, reasons, spaces, busy, others: spaces.length, selfAgeMs }
}

/** 一行说明，给 restart_dsh 的回执用。 */
export function describePresence(decision) {
  if (!decision) return ''
  return `${decision.label} → 等 ${decision.delaySec} 秒；依据：${decision.reasons.join('；')}`
}
