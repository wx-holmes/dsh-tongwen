/**
 * recovery-log.jsonl —— 回收记录，规格 §10.3。
 *
 * append-only，永久保留：不参与 archive.trashRetentionDays，不在任何清理列表里。
 *
 * 写入顺序是硬要求：**先写 committed 记录，再移动文件**。
 * 移动失败补一条 abort；写 log 本身就失败 → 这次操作整个失败，不移动文件。
 */

import fsp from 'node:fs/promises'
import { readJsonl, appendLine } from './atomic.js'
import { ulid } from './ulid.js'

export const RECOVERY_LOG_SCHEMA_VERSION = '1.0'
export const RECOVERY_EVENTS = Object.freeze(['trash', 'restore', 'abort'])
export const RECOVERY_SOURCES = Object.freeze(['bucket_soft_delete', 'versions_cleanup', 'restore'])

/**
 * @typedef {object} RecoveryRecord
 * @property {string} schemaVersion
 * @property {string} recoveryId
 * @property {'trash'|'restore'|'abort'} event
 * @property {string} originalPath
 * @property {string} physicalPath
 * @property {'bucket_soft_delete'|'versions_cleanup'|'restore'} source
 * @property {string} trashedAt
 * @property {string|null} restoredAt
 * @property {number} size
 * @property {string|null} hash
 * @property {string} reason
 * @property {string} sessionId
 * @property {string|null} taskId
 * @property {'committed'|'aborted'} result
 */

/**
 * @param {string} file
 * @returns {Promise<{records: RecoveryRecord[], malformed: number}>}
 */
export async function loadRecoveryLog(file) {
  const { records, malformed } = await readJsonl(file)
  return { records: /** @type {RecoveryRecord[]} */ (records), malformed: malformed.length }
}

/**
 * 写一条回收记录。**调用方必须先写成功，再动文件**。
 *
 * @param {object} params
 * @param {string} params.file
 * @param {'trash'|'restore'|'abort'} params.event
 * @param {string} params.originalPath
 * @param {string} params.physicalPath
 * @param {'bucket_soft_delete'|'versions_cleanup'|'restore'} params.source
 * @param {number} params.size
 * @param {string|null} params.hash
 * @param {string} params.reason
 * @param {string} params.sessionId
 * @param {string|null} [params.taskId]
 * @param {'committed'|'aborted'} [params.result]
 * @returns {Promise<RecoveryRecord>}
 */
export async function appendRecoveryRecord(params) {
  const now = new Date().toISOString()
  /** @type {RecoveryRecord} */
  const record = {
    schemaVersion: RECOVERY_LOG_SCHEMA_VERSION,
    recoveryId: ulid(),
    event: params.event,
    originalPath: params.originalPath,
    physicalPath: params.physicalPath,
    source: params.source,
    trashedAt: params.event === 'restore' ? now : now,
    restoredAt: params.event === 'restore' ? now : null,
    size: Number(params.size ?? 0),
    hash: params.hash ?? null,
    reason: params.reason ?? '',
    sessionId: params.sessionId,
    taskId: params.taskId ?? null,
    result: params.result ?? 'committed',
  }

  await fsp.mkdir(requireDir(params.file), { recursive: true }).catch(() => {})
  await appendLine(params.file, JSON.stringify(record))
  return record
}

/**
 * 找一条「可恢复」的 trash 记录（§10.3 查找规则）：
 *   只认 event=trash 且 result=committed，
 *   且其后没有同 originalPath 的 event=restore committed，
 *   同 originalPath 多次 trash 取最新未抵消的。
 *
 * @param {RecoveryRecord[]} records
 * @param {string} originalPath
 * @returns {{found: true, record: RecoveryRecord} | {found: false, reason: string}}
 */
export function findRestorable(records, originalPath) {
  let candidate = null
  let restoredAfter = false

  for (const record of records) {
    if (record.originalPath !== originalPath) continue
    if (record.event === 'trash' && record.result === 'committed') {
      candidate = record
      restoredAfter = false
    } else if (record.event === 'restore' && record.result === 'committed') {
      if (candidate) restoredAfter = true
    }
  }

  if (!candidate) return { found: false, reason: '没有该路径的 trash 记录' }
  if (restoredAfter) return { found: false, reason: '该路径已恢复过一次，不得再次恢复' }
  return { found: true, record: candidate }
}

/**
 * 同 originalPath 是否已经恢复过（用于 restore 的前置拒绝）。
 * @param {RecoveryRecord[]} records
 * @param {string} originalPath
 */
export function alreadyRestored(records, originalPath) {
  return records.some(
    (r) => r.originalPath === originalPath && r.event === 'restore' && r.result === 'committed',
  )
}

/** 延迟取目录名，避免在模块顶层 import path 只为一个函数。 */
function requireDir(file) {
  // eslint-disable-next-line no-undef
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))
}
