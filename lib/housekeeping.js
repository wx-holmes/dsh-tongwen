/**
 * housekeeping —— 过期文件清扫报告（只报告，不删除）
 *
 * 主人在 2026-11-05 拍板「A 方案」：到期的文件不自动删，只列清单和体积，
 * 他点头之后再由时空动手（删除必须走 archive/trash，scratch 真删先问人）。
 *
 * 报告写到 `logs/清扫报告.md`；状态写 `logs/housekeeping.json`。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/** 默认保留期（天）。配置里可以覆盖：housekeeping.auditDays 等。 */
export const DEFAULT_RETENTION = Object.freeze({
  auditDays: 90,
  ledgerDays: 180,
  trashDays: 90,
  scratchDays: 14,
  reportEveryDays: 7,
})

/** 读配置里的保留期，缺省用默认值。 */
export function retentionOf(config) {
  const pick = (key) => {
    const raw = config?.[`housekeeping.${key}`]
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION[key]
  }
  return {
    auditDays: pick('auditDays'),
    ledgerDays: pick('ledgerDays'),
    trashDays: pick('trashDays'),
    scratchDays: pick('scratchDays'),
    reportEveryDays: pick('reportEveryDays'),
  }
}

async function walkFiles(dir, out = [], depth = 0) {
  if (depth > 8) return out
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(full, out, depth + 1)
    } else if (entry.isFile()) {
      try {
        const st = await fsp.stat(full)
        out.push({ path: full, bytes: st.size, mtime: st.mtimeMs })
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  return out
}

function olderThan(files, days, nowMs) {
  const cutoff = nowMs - days * 24 * 3600 * 1000
  return files.filter((f) => f.mtime < cutoff)
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function stampLocal(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return d.toISOString().replace('T', ' ').slice(0, 16)
}

/**
 * 扫一遍过期文件，返回分组结果（不写盘）。
 * @param {object} ctx 插件上下文
 * @param {object} config 插件配置
 * @param {number} [nowMs]
 */
export async function collectStale(ctx, config, nowMs = Date.now()) {
  const retention = retentionOf(config)
  const logsDir = ctx.bucketDir('logs')
  const groups = []

  const auditDir = ctx.auditDir || path.join(logsDir, 'audit')
  const auditFiles = await walkFiles(auditDir)
  groups.push({
    key: 'audit',
    label: '审计日志（logs/audit）',
    days: retention.auditDays,
    files: olderThan(auditFiles, retention.auditDays, nowMs),
  })

  const ledgerDir = path.join(logsDir, '账本')
  const ledgerFiles = (await walkFiles(ledgerDir)).filter(
    (f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(path.basename(f.path)),
  )
  groups.push({
    key: 'ledger',
    label: '账本日报（logs/账本/<日期>.md）',
    days: retention.ledgerDays,
    files: olderThan(ledgerFiles, retention.ledgerDays, nowMs),
  })

  const trashFiles = await walkFiles(ctx.trashDir)
  groups.push({
    key: 'trash',
    label: '回收站（archive/trash）',
    days: retention.trashDays,
    files: olderThan(trashFiles, retention.trashDays, nowMs),
  })

  const scratchFiles = await walkFiles(ctx.bucketDir('scratch'))
  groups.push({
    key: 'scratch',
    label: '临时区（scratch）',
    days: retention.scratchDays,
    files: olderThan(scratchFiles, retention.scratchDays, nowMs),
  })

  for (const g of groups) {
    g.bytes = g.files.reduce((sum, f) => sum + f.bytes, 0)
    g.files.sort((a, b) => a.mtime - b.mtime)
  }

  const totalFiles = groups.reduce((n, g) => n + g.files.length, 0)
  const totalBytes = groups.reduce((n, g) => n + g.bytes, 0)

  return {
    generatedAt: nowMs,
    retention,
    groups,
    totalFiles,
    totalBytes,
  }
}

/** 把结果写成 Markdown 报告。只写报告，不动被列出的文件。 */
export function renderReport(result) {
  const lines = []
  lines.push('# 过期文件清扫报告')
  lines.push('')
  lines.push(
    `> 生成于 ${stampLocal(result.generatedAt)}（北京时间）。**这只是清单，没有删任何东西**：要删我再动手，删除一律先进 archive/trash。`,
  )
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push('| 组 | 保留期 | 过期文件 | 体积 |')
  lines.push('| --- | --- | --- | --- |')
  for (const g of result.groups) {
    lines.push(`| ${g.label} | ${g.days} 天 | ${g.files.length} 个 | ${fmtBytes(g.bytes)} |`)
  }
  lines.push(`| **合计** | — | **${result.totalFiles} 个** | **${fmtBytes(result.totalBytes)}** |`)
  lines.push('')

  const listed = result.groups.filter((g) => g.files.length > 0)
  if (listed.length === 0) {
    lines.push('没有过期文件，干净得很。')
    lines.push('')
    return lines.join('\n')
  }

  for (const g of listed) {
    lines.push(`## ${g.label}（${g.files.length} 个，${fmtBytes(g.bytes)}）`)
    lines.push('')
    lines.push('| 最后修改 | 文件 | 体积 |')
    lines.push('| --- | --- | --- |')
    const shown = g.files.slice(0, 40)
    for (const f of shown) {
      const rel = f.path.replace(/^[A-Za-z]:\\/, '').replace(/\\/g, '/')
      lines.push(`| ${stampLocal(f.mtime)} | \`${rel}\` | ${fmtBytes(f.bytes)} |`)
    }
    if (g.files.length > shown.length) {
      lines.push(`| … | 另有 ${g.files.length - shown.length} 个未列出 | |`)
    }
    lines.push('')
  }

  lines.push('## 删除规矩')
  lines.push('')
  lines.push('- 这些文件到点只是「可以清」，不是「已经清」；动手前请主人点头。')
  lines.push('- 删除一律先软删进 `archive/trash/<时间>/from-<档>/`，写 `archive/trash/recovery-log.jsonl`。')
  lines.push('- `scratch` 真删要先问人（九档硬规则④）。')
  lines.push('')
  return lines.join('\n')
}

/** 读状态文件（上次报告时间）。 */
export async function readHousekeepingState(ctx) {
  const file = path.join(ctx.bucketDir('logs'), 'housekeeping.json')
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return { lastGeneratedAt: null }
  }
}

/**
 * 生成报告（写 logs/清扫报告.md 与状态）。
 * @param {object} ctx
 * @param {object} config
 * @param {{ force?: boolean, now?: number }} [options]
 */
export async function runHousekeeping(ctx, config, options = {}) {
  const now = options.now ?? Date.now()
  const state = await readHousekeepingState(ctx)
  const everyMs = retentionOf(config).reportEveryDays * 24 * 3600 * 1000
  if (!options.force && state.lastGeneratedAt && now - state.lastGeneratedAt < everyMs) {
    return { ok: true, skipped: true, lastGeneratedAt: state.lastGeneratedAt, reportPath: state.reportPath ?? null }
  }

  const result = await collectStale(ctx, config, now)
  const logsDir = ctx.bucketDir('logs')
  await fsp.mkdir(logsDir, { recursive: true })
  const reportPath = path.join(logsDir, '清扫报告.md')
  await fsp.writeFile(reportPath, renderReport(result), 'utf8')

  const stateFile = path.join(ctx.bucketDir('logs'), 'housekeeping.json')
  const nextState = {
    lastGeneratedAt: now,
    reportPath,
    totalFiles: result.totalFiles,
    totalBytes: result.totalBytes,
  }
  await fsp.writeFile(stateFile, JSON.stringify(nextState, null, 2) + '\n', 'utf8')

  return { ok: true, skipped: false, ...result, reportPath }
}
