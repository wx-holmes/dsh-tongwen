/**
 * directions.jsonl —— 方向谱系，规格 §9.4。
 *
 * append-only，一行一条 JSON，≤ direction.maxLineKB。
 * 权威只在这里：交接第 4 节只写引用，索引只存 IDs，都不复制历史。
 *
 * 追加协议：锁 + O_APPEND 单行 + fsync；追加前读尾部校验 previousDirectionId 存在。
 * 校验发现断链/重复只告警，**禁止自动修复**（§14.1）。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { appendLine, readJsonl } from './atomic.js'
import { ulid } from './ulid.js'
import { pluginError } from './errors.js'

export const DIRECTIONS_SCHEMA_VERSION = '1.0'
export const RELATION_KINDS = Object.freeze(['origin', 'continuation', 'correction', 'turn'])
export const DECIDERS = Object.freeze(['user', 'dsh_inferred'])
export const USER_VERDICTS = Object.freeze(['A', 'B', 'C', 'not_applicable'])

/**
 * @typedef {object} DirectionRecord
 * @property {string} schemaVersion
 * @property {string} directionId
 * @property {string} recordedAt
 * @property {string} sessionId
 * @property {string|null} taskId
 * @property {string|null} effectiveTaskKey
 * @property {string} bucket
 * @property {string} typeSlug
 * @property {string} instance
 * @property {string} direction
 * @property {'origin'|'continuation'|'correction'|'turn'} relationToPrevious
 * @property {string|null} previousDirectionId
 * @property {string} reason
 * @property {'user'|'dsh_inferred'} decidedBy
 * @property {'A'|'B'|'C'|'not_applicable'} userVerdict
 * @property {string|null} verdictQuote
 * @property {string|null} sourceHandoffVersion
 * @property {string} note
 */

/**
 * 校验一条方向记录（写入前）。
 * @param {DirectionRecord} record
 * @param {{quoteMaxChars: number, maxLineKB: number}} limits
 */
export function validateDirection(record, limits) {
  const problems = []

  if (!RELATION_KINDS.includes(record.relationToPrevious)) {
    problems.push(`relationToPrevious 非法：${record.relationToPrevious}`)
  }
  if (record.relationToPrevious === 'origin') {
    if (record.previousDirectionId !== null && record.previousDirectionId !== undefined) {
      problems.push('origin 的 previousDirectionId 必须为 null')
    }
  } else if (!record.previousDirectionId) {
    problems.push(`${record.relationToPrevious} 必须带 previousDirectionId`)
  }

  if (!DECIDERS.includes(record.decidedBy)) problems.push(`decidedBy 非法：${record.decidedBy}`)
  if (!USER_VERDICTS.includes(record.userVerdict)) problems.push(`userVerdict 非法：${record.userVerdict}`)

  // 用户裁决必填 verdictQuote，且只摘录不改写（长度上限保护）。
  if (record.decidedBy === 'user') {
    if (!record.verdictQuote) problems.push('decidedBy=user 时 verdictQuote 必填')
    else if (record.verdictQuote.length > Number(limits.quoteMaxChars)) {
      problems.push(`verdictQuote 超长：${record.verdictQuote.length} > ${limits.quoteMaxChars}`)
    }
  }
  // dsh 不得代填用户裁决。
  if (record.decidedBy === 'dsh_inferred' && record.userVerdict !== 'not_applicable') {
    problems.push('decidedBy=dsh_inferred 时 userVerdict 只能是 not_applicable（dsh 不得代填用户裁决）')
  }
  if (record.decidedBy === 'dsh_inferred' && record.verdictQuote) {
    problems.push('decidedBy=dsh_inferred 时不得带 verdictQuote')
  }

  const line = JSON.stringify(record)
  const bytes = Buffer.byteLength(line, 'utf8')
  if (bytes > Number(limits.maxLineKB) * 1024) {
    problems.push(`单行 ${bytes} 字节，超过 direction.maxLineKB=${limits.maxLineKB}KB`)
  }

  if (problems.length > 0) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'direction', reason: problems.join('；') })
  }
  return true
}

/**
 * 加载并校验（§9.4 校验）。只返回结论，不改文件。
 *
 * @param {string} file
 * @returns {Promise<{
 *   records: DirectionRecord[],
 *   byId: Map<string, DirectionRecord>,
 *   brokenLinks: string[],
 *   duplicateIds: string[],
 *   multiOriginInstances: string[],
 *   malformedLines: number,
 * }>}
 */
export async function loadDirections(file) {
  const { records, malformed } = await readJsonl(file)
  /** @type {DirectionRecord[]} */ const valid = []
  const byId = new Map()
  const duplicateIds = []

  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (!record.directionId) continue
    if (byId.has(record.directionId)) {
      duplicateIds.push(record.directionId) // 保留首条，后面这条只告警
      continue
    }
    byId.set(record.directionId, /** @type {DirectionRecord} */ (record))
    valid.push(/** @type {DirectionRecord} */ (record))
  }

  const brokenLinks = []
  for (const record of valid) {
    if (record.relationToPrevious === 'origin') continue
    const prev = record.previousDirectionId
    if (!prev || !byId.has(prev)) {
      brokenLinks.push(`${record.directionId} → ${prev ?? 'null'}`)
    }
  }

  /** @type {Map<string, number>} */ const originCount = new Map()
  for (const record of valid) {
    if (record.relationToPrevious !== 'origin') continue
    const key = `${record.bucket}/${record.typeSlug}/${record.instance}`
    originCount.set(key, (originCount.get(key) ?? 0) + 1)
  }
  const multiOriginInstances = [...originCount.entries()].filter(([, n]) => n > 1).map(([k]) => k)

  return {
    records: valid,
    byId,
    brokenLinks,
    duplicateIds,
    multiOriginInstances,
    malformedLines: malformed.length,
  }
}

/**
 * 追加一条方向记录。
 *
 * @param {object} params
 * @param {string} params.file
 * @param {string} params.directionsDir 用于加锁的目录（通常就是 path.dirname(file)）
 * @param {string} params.sessionId
 * @param {string} params.bucket
 * @param {string} params.typeSlug
 * @param {string} params.instance
 * @param {string} params.direction
 * @param {'origin'|'continuation'|'correction'|'turn'} params.relationToPrevious
 * @param {string} params.reason
 * @param {'user'|'dsh_inferred'} params.decidedBy
 * @param {'A'|'B'|'C'|'not_applicable'} params.userVerdict
 * @param {{quoteMaxChars: number, maxLineKB: number}} params.limits
 * @param {string|null} [params.taskId]
 * @param {string|null} [params.effectiveTaskKey]
 * @param {string|null} [params.verdictQuote]
 * @param {string|null} [params.sourceHandoffVersion]
 * @param {string} [params.note]
 * @param {boolean} [params.warnBrokenLink]
 * @returns {Promise<{record: DirectionRecord, warnings: string[]}>}
 */
export async function appendDirection(params) {
  const {
    file, sessionId, bucket, typeSlug, instance, direction, relationToPrevious,
    reason, decidedBy, userVerdict, limits,
    taskId = null, effectiveTaskKey = null, verdictQuote = null,
    sourceHandoffVersion = null, note = '', warnBrokenLink = true,
  } = params

  const loaded = await loadDirections(file)
  const warnings = []

  /** @type {string|null} */ let previousDirectionId = null
  if (relationToPrevious !== 'origin') {
    // 找同实例最近一条方向作为前驱（锁内读尾部，见调用方）。
    const sameInstance = loaded.records.filter(
      (r) => r.bucket === bucket && r.typeSlug === typeSlug && r.instance === instance,
    )
    previousDirectionId = sameInstance.length > 0
      ? sameInstance[sameInstance.length - 1].directionId
      : null
    if (!previousDirectionId) {
      throw pluginError('E_VALIDATION_BLOCKING', {
        field: 'previousDirectionId',
        reason: `${relationToPrevious} 需要前一条方向，但该实例没有任何方向记录；第一次请用 origin`,
      })
    }
  }

  /** @type {DirectionRecord} */
  const record = {
    schemaVersion: DIRECTIONS_SCHEMA_VERSION,
    directionId: ulid(),
    recordedAt: new Date().toISOString(),
    sessionId,
    taskId,
    effectiveTaskKey,
    bucket,
    typeSlug,
    instance,
    direction,
    relationToPrevious,
    previousDirectionId,
    reason,
    decidedBy,
    userVerdict,
    verdictQuote,
    sourceHandoffVersion,
    note,
  }

  validateDirection(record, limits)

  if (warnBrokenLink && loaded.brokenLinks.length > 0) {
    warnings.push(`已有方向链断裂 ${loaded.brokenLinks.length} 条（不断链修复，仅记录）`)
  }

  await fsp.mkdir(path.dirname(file), { recursive: true })
  await appendLine(file, JSON.stringify(record))

  return { record, warnings }
}

/**
 * 取某实例的方向序列（由旧到新）。
 * @param {Map<string, DirectionRecord>} byId
 * @param {DirectionRecord[]} records
 * @param {string} bucket
 * @param {string} typeSlug
 * @param {string} instance
 */
export function directionsForInstance(records, bucket, typeSlug, instance) {
  return records.filter(
    (r) => r.bucket === bucket && r.typeSlug === typeSlug && r.instance === instance,
  )
}
