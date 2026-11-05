/**
 * index.machine.json —— 规格 §6。
 *
 * 结构化全量索引。三条性质决定了这里的写法：
 *   1. 增量更新；写失败不阻断主流程（唯一例外是 types 首次映射，§3.4 要求原子写）
 *   2. 可自愈：真实目录与索引比对，缺失补录，多余标「疑似残留」不自动删
 *   3. 可重建：损坏时保留旧文件、扫磁盘回填，回填不了的就标 lost，不伪造
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.js'
import { jsonText } from './json-text.js'
import { INDEX_SCHEMA_VERSION, STRUCTURE_VERSION } from './context.js'
import { parseMachine } from './handoff.js'
import { ulid } from './ulid.js'

/**
 * @typedef {object} TypeRecord
 * @property {string} typeDisplayName
 * @property {string} typeSlug
 * @property {'registered'|'unregistered'} status
 * @property {string} createdAt
 * @property {string|null} originTaskId
 * @property {string} notes
 */

/**
 * @typedef {object} IndexEntry
 * @property {string} entryId
 * @property {'instance'|'journal'|'report'|'self-change'} kind
 * @property {string} bucket
 * @property {string|null} typeSlug
 * @property {string|null} instance
 * @property {string|null} displayName
 * @property {string|null} purpose
 * @property {'active'|'done'|'abandoned'|'lost'} status
 * @property {string|null} machineHandoff
 * @property {string|null} userHandoff
 * @property {string|null} lastUpdated
 * @property {string|null} contentHash
 * @property {string|null} originTaskId
 * @property {string|null} effectiveTaskKey
 * @property {string|null} taskIdScope
 * @property {string|null} taskIdSource
 * @property {string|null} sessionId
 * @property {'strong'|'weak'|'unavailable'} idempotency
 * @property {string|null} eventId
 * @property {string|null} latestDirectionId
 * @property {string[]} directionIds
 * @property {boolean} directionBroken
 * @property {string[]} [coveredJournalRefs]
 * @property {string|null} [originalEntryId]
 * @property {string} notes
 */

/**
 * @typedef {object} SelfState
 * @property {string|null} lastJournalAt
 * @property {number} pendingJournalCount
 * @property {string|null} lastReportAt
 * @property {string|null} nextReportDueBy
 * @property {string|null} lastSessionId
 * @property {string|null} lastSessionEndAt
 * @property {'normal'|'abnormal'|'unknown'} lastSessionEndStatus
 * @property {string|null} lastJournalRef
 * @property {boolean} lastSessionZeroChange
 * @property {string|null} baselineEstablishedAt
 * @property {'L1'|'L2'|null} degradedLevel
 * @property {number} openItemsCount
 * @property {Record<string, number>} openItemsByCategory
 * @property {string|null} lastOpenItemsScanAt
 * @property {number} [pendingCountRecovered]
 */

/**
 * @typedef {object} MachineIndex
 * @property {number} schemaVersion
 * @property {string} updatedAt
 * @property {string} structureVersion
 * @property {TypeRecord[]} types
 * @property {IndexEntry[]} entries
 * @property {SelfState} selfState
 */

/** 顶层必填字段（§6.3 损坏判定之二）。 */
const REQUIRED_TOP_LEVEL = ['schemaVersion', 'updatedAt', 'structureVersion', 'types', 'entries', 'selfState']

/** @returns {SelfState} */
export function emptySelfState() {
  return {
    lastJournalAt: null,
    pendingJournalCount: 0,
    lastReportAt: null,
    nextReportDueBy: null,
    lastSessionId: null,
    lastSessionEndAt: null,
    lastSessionEndStatus: 'unknown',
    lastJournalRef: null,
    lastSessionZeroChange: false,
    baselineEstablishedAt: null,
    degradedLevel: null,
    openItemsCount: 0,
    openItemsByCategory: {},
    lastOpenItemsScanAt: null,
  }
}

/** @returns {MachineIndex} */
export function emptyIndex() {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    structureVersion: STRUCTURE_VERSION,
    types: [],
    entries: [],
    selfState: emptySelfState(),
  }
}

/**
 * 损坏判定（§6.3 六条）。
 * @param {any} parsed
 * @returns {{corrupt: boolean, problems: string[]}}
 */
export function diagnoseIndex(parsed) {
  const problems = []

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { corrupt: true, problems: ['顶层不是对象'] }
  }
  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in parsed)) problems.push(`缺顶层字段 ${field}`)
  }
  if ('entries' in parsed && !Array.isArray(parsed.entries)) problems.push('entries 不是数组')
  if ('types' in parsed && !Array.isArray(parsed.types)) problems.push('types 不是数组')
  if ('structureVersion' in parsed && parsed.structureVersion !== STRUCTURE_VERSION) {
    problems.push(`structureVersion 未知：${String(parsed.structureVersion)}`)
  }

  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  if (entries.length > 0) {
    const missing = entries.filter(
      (e) => !e || typeof e !== 'object' || !e.kind || !e.bucket || !e.instance,
    ).length
    if (missing / entries.length > 0.05) {
      problems.push(`${missing}/${entries.length} 条目缺 kind/bucket/instance（>5%）`)
    }
  }

  // 同 typeSlug 下重复 instance（非 lost）>1
  /** @type {Map<string, Set<string>>} */ const seen = new Map()
  for (const entry of entries) {
    if (!entry || entry.status === 'lost' || entry.kind !== 'instance') continue
    const key = entry.typeSlug ?? ''
    if (!seen.has(key)) seen.set(key, new Set())
    const set = seen.get(key)
    if (set.has(entry.instance)) {
      problems.push(`typeSlug=${key} 下 instance 重复：${entry.instance}`)
    }
    set.add(entry.instance)
  }

  return { corrupt: problems.length > 0, problems }
}

/**
 * 读索引。
 * @param {string} file
 * @returns {Promise<{index: MachineIndex|null, status: 'ok'|'missing'|'corrupt', problems: string[], raw: string|null}>}
 */
export async function loadIndex(file) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT') return { index: null, status: 'missing', problems: [], raw: null }
    return { index: null, status: 'corrupt', problems: [`读不出：${code}`], raw: null }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { index: null, status: 'corrupt', problems: ['JSON 解析失败'], raw }
  }

  const { corrupt, problems } = diagnoseIndex(parsed)
  if (corrupt) return { index: null, status: 'corrupt', problems, raw }

  return { index: normalizeIndex(parsed), status: 'ok', problems: [], raw }
}

/**
 * 补齐缺省字段，不让旧版本写出来的索引在读取时炸掉。
 * @param {any} parsed
 * @returns {MachineIndex}
 */
export function normalizeIndex(parsed) {
  const base = emptyIndex()
  return {
    ...base,
    ...parsed,
    types: Array.isArray(parsed.types) ? parsed.types : [],
    entries: Array.isArray(parsed.entries) ? parsed.entries.map(normalizeEntry) : [],
    selfState: { ...base.selfState, ...(parsed.selfState ?? {}) },
  }
}

/**
 * @param {any} entry
 * @returns {IndexEntry}
 */
function normalizeEntry(entry) {
  return {
    entryId: entry.entryId ?? ulid(),
    kind: entry.kind ?? 'instance',
    bucket: entry.bucket ?? '',
    typeSlug: entry.typeSlug ?? null,
    instance: entry.instance ?? null,
    displayName: entry.displayName ?? null,
    purpose: entry.purpose ?? null,
    // 0.4.5：交接按项目寻址——「属于哪个项目」「交给谁」，漏掉这两项会被这里静默丢掉
    project: entry.project ?? null,
    to: entry.to ?? null,
    status: entry.status ?? 'active',
    machineHandoff: entry.machineHandoff ?? null,
    userHandoff: entry.userHandoff ?? null,
    lastUpdated: entry.lastUpdated ?? null,
    contentHash: entry.contentHash ?? null,
    originTaskId: entry.originTaskId ?? null,
    effectiveTaskKey: entry.effectiveTaskKey ?? null,
    taskIdScope: entry.taskIdScope ?? null,
    taskIdSource: entry.taskIdSource ?? null,
    sessionId: entry.sessionId ?? null,
    idempotency: entry.idempotency ?? 'unavailable',
    eventId: entry.eventId ?? null,
    latestDirectionId: entry.latestDirectionId ?? null,
    directionIds: Array.isArray(entry.directionIds) ? entry.directionIds : [],
    directionBroken: Boolean(entry.directionBroken),
    ...(entry.coveredJournalRefs ? { coveredJournalRefs: entry.coveredJournalRefs } : {}),
    ...(entry.originalEntryId ? { originalEntryId: entry.originalEntryId } : {}),
    notes: entry.notes ?? '',
  }
}

/**
 * 原子写索引。
 * @param {string} file
 * @param {MachineIndex} index
 */
export async function saveIndex(file, index) {
  index.updatedAt = new Date().toISOString()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, `${jsonText(index)}\n`)
  return index
}

/**
 * 把损坏的索引改名保留，返回归档路径。
 * @param {string} file
 * @param {string} raw
 */
export async function archiveCorruptIndex(file, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.corrupt-${stamp}`
  if (raw !== null) {
    await writeFileAtomic(target, raw)
    await fsp.rm(file, { force: true }).catch(() => {})
  } else {
    await fsp.rename(file, target).catch(() => {})
  }
  return target
}

/**
 * 扫描磁盘重建索引（§6.3 重建回填）。
 *
 * 能回填的：handoff/<typeSlug>/*.machine.md 的 instance 与 types；
 *          handoff/self/journals、reports；directions 的 latestDirectionId。
 * 回填不了的：self-change → 标 selfChangeLost，不伪造。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @returns {Promise<{index: MachineIndex, inconsistencies: string[], selfChangeLost: boolean}>}
 */
export async function rebuildIndex(ctx) {
  const index = emptyIndex()
  const inconsistencies = []
  let selfChangeLost = false

  /** @type {Map<string, TypeRecord>} */ const typeBySlug = new Map()

  // ── handoff/machine/<日期>/<实例>.machine.md ──
  // 主人 2026-10-31 裁决的布局：根下分 machine / user，各自按日期分目录。
  const machineRoot = path.join(ctx.bucketDir('handoff'), 'machine')
  let dayDirs = []
  try {
    dayDirs = await fsp.readdir(machineRoot, { withFileTypes: true })
  } catch { /* handoff 还没建，重建出空索引即可 */ }

  for (const dirent of dayDirs) {
    if (!dirent.isDirectory()) continue
    const day = dirent.name
    const dayDir = path.join(machineRoot, day)

    let files = []
    try {
      files = await fsp.readdir(dayDir)
    } catch { continue }

    for (const name of files) {
      if (!name.endsWith('.machine.md')) continue
      const instance = name.slice(0, -'.machine.md'.length)
      const relPath = `handoff/machine/${day}/${name}`
      const abs = path.join(dayDir, name)

      let parsed = null
      let contentHash = null
      try {
        const text = await fsp.readFile(abs, 'utf8')
        parsed = parseMachine(text).structured
        contentHash = await sha256Text(text)
      } catch { /* 读不出就只回填路径 */ }

      const typeSlug = parsed?.identity?.typeSlug ?? 'unknown'
      const displayName = parsed?.identity?.displayName ?? instance
      const typeDisplayName = parsed?.identity?.typeDisplayName ?? typeSlug

      if (!typeBySlug.has(typeSlug)) {
        typeBySlug.set(typeSlug, {
          typeDisplayName,
          typeSlug,
          status: 'unregistered',
          createdAt: new Date().toISOString(),
          originTaskId: null,
          notes: '重建索引时回填，状态未核实',
        })
      }

      index.entries.push(normalizeEntry({
        entryId: ulid(),
        kind: 'instance',
        bucket: 'created',
        typeSlug,
        instance,
        displayName,
        status: 'active',
        machineHandoff: relPath,
        userHandoff: `handoff/user/${day}/${instance}.user.md`,
        lastUpdated: parsed?.identity?.updatedAt ?? null,
        contentHash,
        originTaskId: parsed?.identity?.taskId ?? null,
        effectiveTaskKey: parsed?.identity?.effectiveTaskKey ?? null,
        taskIdScope: parsed?.identity?.taskIdScope ?? null,
        sessionId: parsed?.identity?.sessionId ?? null,
        idempotency: 'weak',
        latestDirectionId: parsed?.direction?.directionId ?? null,
        directionIds: parsed?.direction?.directionId ? [parsed.direction.directionId] : [],
        notes: '重建索引时回填',
      }))

      const userAbs = path.join(typeDir, `${instance}.user.md`)
      const userExists = await fsp.stat(userAbs).then(() => true).catch(() => false)
      if (!userExists) inconsistencies.push(`缺用户版：handoff/${typeSlug}/${instance}.user.md`)
    }
  }

  // ── handoff/self/journals 与 reports ──
  for (const [kind, dir, relPrefix] of [
    ['journal', ctx.journalsDir, 'handoff/self/journals'],
    ['report', ctx.reportsDir, 'handoff/self/reports'],
  ]) {
    let names = []
    try {
      names = await fsp.readdir(dir)
    } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const abs = path.join(dir, name)
      let contentHash = null
      try {
        contentHash = await sha256Text(await fsp.readFile(abs, 'utf8'))
      } catch { /* 留空 */ }
      index.entries.push(normalizeEntry({
        entryId: ulid(),
        kind,
        bucket: 'handoff',
        typeSlug: 'self',
        instance: name.replace(/\.md$/, ''),
        displayName: name,
        status: 'done',
        contentHash,
        idempotency: 'weak',
        notes: `重建索引时回填（${relPrefix}）`,
      }))
    }
  }

  // ── self-change：无法回填，不伪造 ──
  selfChangeLost = true

  index.types = [...typeBySlug.values()]

  return { index, inconsistencies, selfChangeLost }
}

/**
 * 启动时确保索引可用：正常就用，缺失/损坏就走重建。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @returns {Promise<{index: MachineIndex, action: 'loaded'|'created'|'rebuilt', problems: string[], corruptArchive: string|null}>}
 */
export async function ensureIndex(ctx) {
  const loaded = await loadIndex(ctx.indexFile)

  if (loaded.status === 'ok') {
    return { index: /** @type {MachineIndex} */ (loaded.index), action: 'loaded', problems: [], corruptArchive: null }
  }

  if (loaded.status === 'missing') {
    const index = emptyIndex()
    await saveIndex(ctx.indexFile, index)
    return { index, action: 'created', problems: [], corruptArchive: null }
  }

  // 损坏：先留旧文件，再重建。
  const corruptArchive = await archiveCorruptIndex(ctx.indexFile, loaded.raw)
  const rebuilt = await rebuildIndex(ctx)
  await saveIndex(ctx.indexFile, rebuilt.index)

  const problems = [...loaded.problems]
  if (rebuilt.selfChangeLost) problems.push('self-change 历史无法回填，已标注 selfChangeLost')
  problems.push(...rebuilt.inconsistencies)

  return { index: rebuilt.index, action: 'rebuilt', problems, corruptArchive }
}

/**
 * 找类型记录。
 * @param {MachineIndex} index
 * @param {string} displayName
 * @returns {TypeRecord|undefined}
 */
export function findTypeByDisplayName(index, displayName) {
  return index.types.find((t) => t.typeDisplayName === displayName)
}

/**
 * @param {MachineIndex} index
 * @param {string} typeSlug
 * @returns {TypeRecord|undefined}
 */
export function findTypeBySlug(index, typeSlug) {
  return index.types.find((t) => t.typeSlug === typeSlug)
}

/**
 * 找实例条目（同 typeSlug 下）。
 * @param {MachineIndex} index
 * @param {string} typeSlug
 * @param {string} instance
 * @returns {IndexEntry|undefined}
 */
export function findInstanceEntry(index, typeSlug, instance) {
  return index.entries.find(
    (e) => e.kind === 'instance' && e.typeSlug === typeSlug && e.instance === instance && e.status !== 'lost',
  )
}

/**
 * upsert 实例条目：同 typeSlug + instance 已存在就合并，不产生重复目录（§3.2 第 8 步「复用不新建」）。
 * @param {MachineIndex} index
 * @param {IndexEntry} entry
 * @returns {{entry: IndexEntry, created: boolean}}
 */
export function upsertInstanceEntry(index, entry) {
  const normalized = normalizeEntry(entry)
  const existing = findInstanceEntry(index, normalized.typeSlug, normalized.instance)
  if (existing) {
    Object.assign(existing, {
      ...normalized,
      entryId: existing.entryId, // entryId 不因更新而变
      originalEntryId: existing.originalEntryId, // 来源追踪不被覆盖
    })
    return { entry: existing, created: false }
  }
  index.entries.push(normalized)
  return { entry: normalized, created: true }
}

/**
 * 写一次类型映射。§3.4 要求首次分配必须原子写索引；这条失败就必须阻断建目录。
 * @param {import('./context.js').PluginContext} ctx
 * @param {MachineIndex} index
 * @param {TypeRecord} record
 */
export async function persistIndexStrict(ctx, index) {
  await saveIndex(ctx.indexFile, index)
}

/** @param {string} text */
async function sha256Text(text) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text).digest('hex')
}
