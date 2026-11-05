/**
 * journal —— 规格 §7.1–§7.3。
 *
 * 一次会话一篇，不可删。零变更**不落文件**（唯一例外：补记且判定矩阵 C）。
 * 只陈述现象，不做分析/归并/分类统计。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.js'

/**
 * 把 Date 渲染成 journal 标题用的本地时间。
 * @param {Date} date
 */
function formatHeading(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 生成 journal 正文（§7.2 模板）。
 *
 * @param {object} params
 * @param {Date} params.at
 * @param {string} params.sessionId
 * @param {'host'|'generated'} params.sessionIdSource
 * @param {string|null} params.windowStart
 * @param {string|null} params.windowEnd 缺结束时间（心跳/快照都早于起点）时写「（起点时间，无结束记录）」
 * @param {object} params.diff diffSelf 的结果
 * @param {import('./self-scan.js').ScanResult} params.scan
 * @param {boolean} [params.backfill] 补记
 * @param {string} [params.extraNote] 额外备注（例如快照丢失）
 * @param {object|null} [params.openTask] 崩溃时正在进行的任务（来自 runtime-state.currentTask）
 * @param {'self'|'handoff'} [params.scope] 统计范围（0.3.7 起可配）
 * @returns {string}
 */
export function buildJournal({
  at, sessionId, sessionIdSource, windowStart, windowEnd, diff, scan, backfill = false, extraNote = '', openTask = null,
  scope = 'self',
}) {
  const lines = []
  lines.push(`# ${formatHeading(at)} 变更笔记`)
  lines.push('')

  if (backfill) {
    // [补记] 只在标题里，不进文件名（§7.3）。
    lines.splice(0, 1, `# [补记] ${formatHeading(at)} 变更笔记`)
  }

  lines.push(`- 会话：${sessionId}（${sessionIdSource}）`)
  lines.push(`- 时间窗口：上次 ${windowStart ?? '（无记录）'} → 本次 ${windowEnd ?? '（起点时间，无结束记录）'}`)
  lines.push(`- 变更：新增 ${diff.added.length} / 修改 ${diff.modified.length} / 消失 ${diff.removed.length}`)
  lines.push(`- 统计范围：${scope === 'handoff' ? 'handoff/' : 'self/'}（selfScan.scope）`)

  // 崩溃时正在进行的任务也要落一笔，否则下一棒只看到「某会话异常结束」，不知道它做到哪。
  if (openTask) {
    const kind = openTask.typeDisplayName ?? openTask.typeSlug ?? '未分类'
    const taskId = openTask.taskId ? `，taskId ${openTask.taskId}` : ''
    lines.push(`- 未完成任务：${openTask.instance ?? '（未命名）'}（${openTask.bucket ?? '?'}/${kind}${taskId}）`)
    if (openTask.purpose) lines.push(`  - 目标：${openTask.purpose}`)
  }

  for (const entry of diff.added) lines.push(`  - 新增 ${entry.path}`)
  for (const item of diff.modified) {
    const suffix = item.reason === 'case_changed' ? '（大小写变化）' : '（哈希变化）'
    lines.push(`  - 修改 ${item.entry.path}${suffix}`)
  }
  for (const entry of diff.removed) lines.push(`  - 消失 ${entry.path}`)

  // 备注只写客观现象。
  /** @type {string[]} */ const notes = []
  if (scan.partial) {
    notes.push(`扫描未完成（${scan.partialReason ?? 'unknown'}），已扫描 ${scan.scanned} 项`)
  }
  const unreadable = [...(diff.unchangedUnknown ?? [])].filter((e) => e.unreadable)
  if (unreadable.length > 0) notes.push(`${unreadable.length} 项不可读`)
  const sampled = scan.files.filter((f) => f.hashMode === 'sampled').length
  const meta = scan.files.filter((f) => f.hashMode === 'meta').length
  if (sampled > 0) notes.push(`${sampled} 项按采样比对（含 mtime，touch 也会判修改）`)
  if (meta > 0) notes.push(`${meta} 项仅比对元数据`)
  // 结束时间缺失要说清是「没有记录」而不是「时间窗口塌缩」，否则读起来像又炸了。
  if (!windowEnd) notes.push('本次没有可用的结束时间：心跳与快照时间都不晚于窗口起点，变更数以起点时刻为界')
  if (extraNote) notes.push(extraNote)

  lines.push(`- 备注：${notes.length > 0 ? notes.join('；') : '无'}`)
  lines.push('')

  return lines.join('\n')
}

/**
 * 生成 journal 文件名（§7.3）：YYYY-MM-DD_HHmm.md；同分钟冲突加秒，再冲突加 -2/-3。
 *
 * @param {string} journalsDir
 * @param {Date} at
 * @returns {Promise<{name: string, absPath: string}>}
 */
export async function pickJournalName(journalsDir, at) {
  const pad = (n) => String(n).padStart(2, '0')
  const datePart = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const hhmm = `${pad(at.getHours())}${pad(at.getMinutes())}`
  const ss = `${pad(at.getSeconds())}`

  for (const stem of [`${datePart}_${hhmm}`, `${datePart}_${hhmm}${ss}`]) {
    const name = `${stem}.md`
    if (!(await exists(path.join(journalsDir, name)))) {
      return { name, absPath: path.join(journalsDir, name) }
    }
  }

  const baseStem = `${datePart}_${hhmm}${ss}`
  for (let n = 2; n < 1000; n += 1) {
    const name = `${baseStem}-${n}.md`
    if (!(await exists(path.join(journalsDir, name)))) {
      return { name, absPath: path.join(journalsDir, name) }
    }
  }
  throw new Error(`journal 文件名冲突无法解决：${baseStem}`)
}

/**
 * 写 journal。
 * @param {object} params
 * @param {string} params.journalsDir
 * @param {Date} params.at
 * @param {string} params.content
 * @returns {Promise<{name: string, relPath: string, absPath: string}>}
 */
export async function writeJournal({ journalsDir, at, content }) {
  await fsp.mkdir(journalsDir, { recursive: true })
  const { name, absPath } = await pickJournalName(journalsDir, at)
  await writeFileAtomic(absPath, content)
  return { name, relPath: `handoff/self/journals/${name}`, absPath }
}

/** @param {string} file */
async function exists(file) {
  try {
    await fsp.stat(file)
    return true
  } catch {
    return false
  }
}
