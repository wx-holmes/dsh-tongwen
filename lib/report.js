/**
 * report —— 规格 §7.4 / §7.5。
 *
 * 一段聚合，不是逐篇复述。两条硬约束：
 *   第 2 段按 self/ 下**实际目录**归并，不按内容分类；
 *   第 4 段只陈述客观现象，不写评价词。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.js'

/**
 * 双条件先到先出（§7.5）。
 *
 * 计数口径：pendingJournalCount = 上次 report 后新增 journal 数；
 * 零变更 self-change **不计入**，也不触发 report。
 *
 * @param {object} params
 * @param {import('./index-store.js').SelfState} params.selfState
 * @param {Record<string, any>} params.config
 * @param {Date} [params.now]
 * @returns {{trigger: boolean, reason: 'count'|'days'|null, dueBy: string|null}}
 */
export function shouldTriggerReport({ selfState, config, now = new Date() }) {
  const triggerCount = Number(config['report.triggerJournalCount'])
  const triggerDays = Number(config['report.triggerDays'])

  if (Number(selfState.pendingJournalCount ?? 0) >= triggerCount) {
    return { trigger: true, reason: 'count', dueBy: selfState.nextReportDueBy ?? null }
  }

  const lastReportAt = selfState.lastReportAt ? new Date(selfState.lastReportAt) : null
  const base = lastReportAt ?? (selfState.baselineEstablishedAt ? new Date(selfState.baselineEstablishedAt) : null)
  if (!base) return { trigger: false, reason: null, dueBy: null }

  const elapsedDays = (now.getTime() - base.getTime()) / 86_400_000
  if (elapsedDays >= triggerDays) {
    return { trigger: true, reason: 'days', dueBy: base.toISOString() }
  }

  const dueBy = new Date(base.getTime() + triggerDays * 86_400_000).toISOString()
  return { trigger: false, reason: null, dueBy }
}

/**
 * 从一篇 journal 正文里取出变化条目。
 * 只认模板行，不做语义理解。
 *
 * @param {string} text
 * @returns {{added: string[], modified: string[], removed: string[], unreadableCount: number, partial: boolean}}
 */
export function parseJournalBody(text) {
  const added = []
  const modified = []
  const removed = []
  let unreadableCount = 0
  let partial = false

  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    let m
    if ((m = /^-\s+新增\s+(.+)$/.exec(trimmed))) added.push(m[1].trim())
    else if ((m = /^-\s+修改\s+(.+?)(?:（[^）]*）)?$/.exec(trimmed))) modified.push(m[1].trim())
    else if ((m = /^-\s+消失\s+(.+)$/.exec(trimmed))) removed.push(m[1].trim())
    else if (/^-\s+备注：/.test(trimmed)) {
      if (/扫描未完成/.test(trimmed)) partial = true
      const u = /(\d+)\s*项不可读/.exec(trimmed)
      if (u) unreadableCount = Number(u[1])
    }
  }

  return { added, modified, removed, unreadableCount, partial }
}

/**
 * 按 self/ 下的一级目录归并（第 2 段的唯一分类维度）。
 *
 * @param {{added: string[], modified: string[], removed: string[]}} aggregate
 * @returns {Array<{dir: string, added: number, modified: number, removed: number}>}
 */
export function groupByTopDirectory(aggregate) {
  /** @type {Map<string, {dir: string, added: number, modified: number, removed: number}>} */ const map = new Map()

  const touch = (p) => {
    const segment = String(p).split('/')[0] || '(根)'
    if (!map.has(segment)) map.set(segment, { dir: segment, added: 0, modified: 0, removed: 0 })
    return map.get(segment)
  }

  for (const p of aggregate.added) touch(p).added += 1
  for (const p of aggregate.modified) touch(p).modified += 1
  for (const p of aggregate.removed) touch(p).removed += 1

  return [...map.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1))
}

/**
 * 渲染 report 正文（§7.4 四段）。
 *
 * @param {object} params
 * @param {string} params.periodStart
 * @param {string} params.periodEnd
 * @param {string[]} params.coveredJournalRefs
 * @param {Array<{added: string[], modified: string[], removed: string[], unreadableCount: number, partial: boolean}>} params.journalDiffs
 * @param {{fileCount: number, totalBytes: number, previousFileCount: number|null, previousTotalBytes: number|null}} params.intensity
 * @returns {string}
 */
export function buildReport({ periodStart, periodEnd, coveredJournalRefs, journalDiffs, intensity }) {
  const lines = []

  lines.push(`# ${periodEnd.slice(0, 10)} 阶段性报告`)
  lines.push('')

  // ── 1. 覆盖范围 ──
  lines.push('## 1. 覆盖范围')
  lines.push('')
  lines.push(`时间：${periodStart} → ${periodEnd}`)
  lines.push(`覆盖 ${coveredJournalRefs.length} 篇变更笔记：`)
  for (const ref of coveredJournalRefs) lines.push(`- ${path.posix.basename(ref)}`)
  lines.push('')

  /** @type {{added: string[], modified: string[], removed: string[]}} */
  const aggregate = { added: [], modified: [], removed: [] }
  let unreadableCount = 0
  let partialCount = 0
  for (const diff of journalDiffs) {
    aggregate.added.push(...diff.added)
    aggregate.modified.push(...diff.modified)
    aggregate.removed.push(...diff.removed)
    unreadableCount += diff.unreadableCount
    if (diff.partial) partialCount += 1
  }

  // ── 2. 这段时间变了什么（按实际目录归并）──
  lines.push('## 2. 这段时间变了什么')
  lines.push('')
  const groups = groupByTopDirectory(aggregate)
  if (groups.length === 0) {
    lines.push('这段时间没有文件变化。')
  } else {
    for (const group of groups) {
      const parts = []
      if (group.added > 0) parts.push(`新增 ${group.added}`)
      if (group.modified > 0) parts.push(`修改 ${group.modified}`)
      if (group.removed > 0) parts.push(`消失 ${group.removed}`)
      lines.push(`- ${group.dir}/：${parts.join('，')}`)
    }
  }
  lines.push('')

  // ── 3. 变化强度 ──
  lines.push('## 3. 变化强度')
  lines.push('')
  lines.push(`当前文件数 ${intensity.fileCount}，总大小 ${formatBytes(intensity.totalBytes)}。`)
  if (intensity.previousFileCount === null || intensity.previousTotalBytes === null) {
    lines.push('这是第一份报告，没有可比对象。')
  } else {
    const deltaFiles = intensity.fileCount - intensity.previousFileCount
    const deltaBytes = intensity.totalBytes - intensity.previousTotalBytes
    lines.push(`与上一份相比：文件数 ${deltaFiles >= 0 ? '+' : ''}${deltaFiles}，大小 ${deltaBytes >= 0 ? '+' : '-'}${formatBytes(Math.abs(deltaBytes))}。`)
  }
  const sampled = journalDiffs.reduce((n, d) => n + (d.sampledCount ?? 0), 0)
  if (sampled > 0) lines.push(`其中 ${sampled} 项按采样/元数据比对，精度有限。`)
  lines.push('')

  // ── 4. 客观异常提示（只陈述现象）──
  lines.push('## 4. 客观异常提示')
  lines.push('')
  /** @type {string[]} */ const anomalies = []
  if (unreadableCount > 0) anomalies.push(`本时段有 ${unreadableCount} 项文件读取失败，数量未计入变化统计。`)
  if (partialCount > 0) anomalies.push(`本时段有 ${partialCount} 次扫描未完成（达到上限），变化统计不完整。`)

  if (anomalies.length === 0) lines.push('本时段未发现客观异常。')
  else for (const item of anomalies) lines.push(`- ${item}`)
  lines.push('')

  return lines.join('\n')
}

/**
 * 报告文件名（§7.4）：YYYY-MM-DD.md；同天多份加 -2/-3。
 * @param {string} reportsDir
 * @param {Date} at
 */
export async function pickReportName(reportsDir, at) {
  const pad = (n) => String(n).padStart(2, '0')
  const datePart = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const first = `${datePart}.md`
  if (!(await exists(path.join(reportsDir, first)))) return first
  for (let n = 2; n < 1000; n += 1) {
    const name = `${datePart}-${n}.md`
    if (!(await exists(path.join(reportsDir, name)))) return name
  }
  throw new Error(`report 文件名冲突无法解决：${datePart}`)
}

/**
 * 写报告文件。
 * @param {object} params
 * @param {string} params.reportsDir
 * @param {Date} params.at
 * @param {string} params.content
 */
export async function writeReportFile({ reportsDir, at, content }) {
  await fsp.mkdir(reportsDir, { recursive: true })
  const name = await pickReportName(reportsDir, at)
  const absPath = path.join(reportsDir, name)
  await writeFileAtomic(absPath, content)
  return { name, absPath, relPath: `handoff/self/reports/${name}` }
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} 字节`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
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
