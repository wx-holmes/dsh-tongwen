/**
 * open-items.jsonl —— 未闭环项事件流，规格 §15.4。
 *
 * append-only。只追加，不修改已有行，不删行，不静默关闭。
 * 同一个 stableKey 在未关闭前只允许追加 note；close 必须带 closeReason；
 * 关闭后同 key 再现，是一条**新的** itemId，不是复活旧条目。
 */

import { appendLine, readJsonl } from './atomic.js'
import { ulid } from './ulid.js'
import { pluginError } from './errors.js'

export const OPEN_ITEMS_SCHEMA_VERSION = '1.0'

/**
 * 显式 category —— 必须写事件流的那些。
 * 每项带 close 条件，close 校验直接查这张表。
 */
export const OPEN_ITEM_CATEGORIES = Object.freeze({
  direction_conflict: ['user_decided'],
  task_unclosed: ['resolved', 'abandoned'],
  backfill_journal_pending: ['resolved'],
  migration_failure: ['user_decided'],
  weak_idempotency: ['user_decided', 'abandoned'],
  snapshot_pending: ['resolved'],
  lock_stale: ['user_decided'],
  config_degraded: ['resolved'],
  audit_write_failed: ['resolved'],
  direction_broken: ['user_decided', 'resolved'],
  report_write_failed: ['resolved'],
  unknown_errno: ['user_decided'],
  restored_pending_user_check: ['resolved'],
  scratch_purge_failed: ['resolved', 'abandoned'],
  recovery_log_write_failed: ['resolved', 'user_decided'],
  snapshot_lost_rebaseline: ['user_decided'],
  index_inconsistent: ['resolved'],
  typeSlug_recovered_warn: ['user_decided'],
  duplicate_entry_warn: ['user_decided'],
})

/**
 * 派生类 —— 启动时实时派生，**不写事件流**。
 * 列在这里是为了让调用方知道哪些名字不能拿去 append。
 */
export const DERIVED_CATEGORIES = Object.freeze([
  'incomplete_instance',
  'unverified_assumption',
  'artifact_missing',
  'lost_entry',
  'scan_partial',
  'path_anomaly',
  'hash_degraded',
])

export const CLOSE_REASONS = Object.freeze(['resolved', 'user_decided', 'abandoned', 'superseded'])

/**
 * @typedef {object} OpenItemEvent
 * @property {string} schemaVersion
 * @property {string} itemId
 * @property {'open'|'note'|'close'} event
 * @property {string} category
 * @property {string} stableKey
 * @property {string} openedAt
 * @property {string} recordedAt
 * @property {string} sessionId
 * @property {string|null} taskId
 * @property {object} related
 * @property {string} summary
 * @property {string|null} closeReason
 * @property {number} attemptCount
 * @property {string|null} lastAttemptAt
 */

/**
 * 读事件流并归并出「当前还开着」的项。
 *
 * @param {string} file
 * @returns {Promise<{active: Map<string, OpenItemEvent>, all: OpenItemEvent[], malformed: number}>}
 */
export async function readOpenItems(file) {
  const { records, malformed } = await readJsonl(file)
  /** @type {Map<string, OpenItemEvent>} */ const active = new Map()

  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const key = String(record.stableKey ?? '')
    if (!key) continue
    if (record.event === 'open') {
      active.set(key, record)
    } else if (record.event === 'close') {
      active.delete(key)
    } else if (record.event === 'note') {
      const current = active.get(key)
      if (current) {
        current.attemptCount = Number(record.attemptCount ?? current.attemptCount ?? 1)
        current.lastAttemptAt = record.recordedAt ?? current.lastAttemptAt ?? null
      }
    }
  }

  return { active, all: /** @type {OpenItemEvent[]} */ (records), malformed }
}

/**
 * 追加一条 open / note 事件。
 *
 * @param {object} params
 * @param {string} params.file
 * @param {'open'|'note'} params.event
 * @param {string} params.category
 * @param {string} params.stableKey
 * @param {string} params.summary
 * @param {string} params.sessionId
 * @param {object} [params.related]
 * @param {string|null} [params.taskId]
 * @param {number} [params.maxActive] 超过上限只告警，不阻断
 * @returns {Promise<{record: OpenItemEvent, activeCount: number, overLimit: boolean}>}
 */
export async function appendOpenItem({
  file, event, category, stableKey, summary, sessionId, related = {}, taskId = null, maxActive = 200,
}) {
  if (DERIVED_CATEGORIES.includes(category)) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'category',
      reason: `${category} 是派生类，只在启动时实时派生，不得写入事件流`,
    })
  }
  if (!Object.hasOwn(OPEN_ITEM_CATEGORIES, category)) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'category',
      reason: `未登记的 category：${category}`,
    })
  }

  const now = new Date().toISOString()
  const { active } = await readOpenItems(file)
  const existing = active.get(stableKey)

  if (event === 'note' && !existing) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'stableKey',
      reason: '要追加 note，但该 stableKey 当前没有未关闭的项',
    })
  }
  if (event === 'open' && existing) {
    // 未关闭前只允许 note，不允许重复 open。
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'stableKey',
      reason: `该 stableKey 已存在未关闭项（${existing.itemId}），只能追加 note`,
    })
  }

  /** @type {OpenItemEvent} */
  const record = {
    schemaVersion: OPEN_ITEMS_SCHEMA_VERSION,
    itemId: existing && event === 'note' ? existing.itemId : ulid(),
    event,
    category,
    stableKey,
    openedAt: existing && event === 'note' ? existing.openedAt : now,
    recordedAt: now,
    sessionId,
    taskId,
    related,
    summary: String(summary ?? '').slice(0, 1000),
    closeReason: null,
    attemptCount: event === 'note' && existing ? Number(existing.attemptCount ?? 1) + 1 : 1,
    lastAttemptAt: event === 'note' ? now : null,
  }

  await appendLine(file, JSON.stringify(record))

  const activeCount = event === 'open' ? active.size + 1 : active.size
  return { record, activeCount, overLimit: activeCount > Number(maxActive) }
}

/**
 * 关闭一项。close 必须带合法 closeReason，且要符合该 category 的 close 条件。
 *
 * @param {object} params
 * @param {string} params.file
 * @param {string} params.category
 * @param {string} params.stableKey
 * @param {'resolved'|'user_decided'|'abandoned'|'superseded'} params.closeReason
 * @param {string} params.sessionId
 * @param {string} [params.summary]
 * @param {object} [params.related]
 */
export async function closeOpenItem({ file, category, stableKey, closeReason, sessionId, summary, related = {} }) {
  if (!CLOSE_REASONS.includes(closeReason)) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'closeReason',
      reason: `closeReason 必须是 ${CLOSE_REASONS.join(' / ')}，收到：${closeReason}`,
    })
  }

  const allowed = OPEN_ITEM_CATEGORIES[category]
  if (!allowed) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'category',
      reason: `未登记的 category：${category}`,
    })
  }
  if (!allowed.includes(closeReason)) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'closeReason',
      reason: `${category} 的 closeReason 只能是 ${allowed.join(' / ')}，收到：${closeReason}`,
    })
  }

  const { active } = await readOpenItems(file)
  const existing = active.get(stableKey)
  if (!existing) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'stableKey',
      reason: '要关闭的项不存在或已关闭',
    })
  }

  const now = new Date().toISOString()
  /** @type {OpenItemEvent} */
  const record = {
    schemaVersion: OPEN_ITEMS_SCHEMA_VERSION,
    itemId: existing.itemId,
    event: 'close',
    category,
    stableKey,
    openedAt: existing.openedAt,
    recordedAt: now,
    sessionId,
    taskId: existing.taskId ?? null,
    related: { ...existing.related, ...related },
    summary: String(summary ?? existing.summary ?? '').slice(0, 1000),
    closeReason,
    attemptCount: Number(existing.attemptCount ?? 1),
    lastAttemptAt: existing.lastAttemptAt ?? null,
  }

  await appendLine(file, JSON.stringify(record))
  return record
}

/**
 * 按 category 汇总，供启动简报用（§15.4 启动简报）。
 * @param {Map<string, OpenItemEvent>} active
 */
export function summarizeOpenItems(active) {
  /** @type {Record<string, number>} */ const byCategory = {}
  for (const item of active.values()) {
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1
  }
  return { total: active.size, byCategory }
}
