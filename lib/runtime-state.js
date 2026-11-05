/**
 * runtime-state.json —— 规格 §15.7。
 *
 * 会话级的运行态：谁在跑、上次心跳、事件去重、待补的 report 批次、降级级别。
 * 它是「上次会话是否正常结束」判定矩阵（§4.8）的权威来源之一（另一个是 snapshot.sessionEnd）。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.js'
import { jsonText } from './json-text.js'
import { RUNTIME_STATE_SCHEMA_VERSION } from './context.js'

/**
 * @typedef {object} PendingReportBatch
 * @property {string[]} journalRefs
 * @property {string} failedAt
 * @property {string} reason
 * @property {number} attemptCount
 * @property {boolean} [reportWritten]
 */

/**
 * @typedef {object} DegradedState
 * @property {'L1'|'L2'} level
 * @property {string} reason
 * @property {string} since
 * @property {string[]} triggers
 */

/**
 * @typedef {object} PendingConfirm
 * @property {string} token
 * @property {string} opHash
 * @property {string} createdAt
 */

/**
 * @typedef {object} RuntimeState
 * @property {string} schemaVersion
 * @property {string|null} sessionId
 * @property {'host'|'generated'} sessionIdSource
 * @property {string|null} startedAt
 * @property {string|null} lastHeartbeatAt
 * @property {'active'|'ended'} status
 * @property {string|null} endedAt
 * @property {number} autoTaskSeq
 * @property {string[]} recentEventIds
 * @property {PendingReportBatch} [pendingReportBatch]
 * @property {PendingConfirm[]} [pendingConfirms]
 * @property {DegradedState} [degraded]
 */

/** @returns {RuntimeState} */
export function emptyRuntimeState() {
  return {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    sessionId: null,
    sessionIdSource: 'generated',
    startedAt: null,
    lastHeartbeatAt: null,
    status: 'ended',
    endedAt: null,
    autoTaskSeq: 0,
    currentTask: null,
    recentEventIds: [],
  }
}

/**
 * 读 runtime-state。文件不存在 → 返回 null（判定矩阵要靠「不存在」这个事实）。
 * 损坏 → 返回 `{ state: null, corrupt: true }` 让调用方告警，不静默重建。
 *
 * @param {string} file
 * @returns {Promise<{state: RuntimeState|null, corrupt: boolean, raw: string|null}>}
 */
export async function readRuntimeState(file) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT') return { state: null, corrupt: false, raw: null }
    return { state: null, corrupt: true, raw: null }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: null, corrupt: true, raw }
    }
    return { state: normalizeRuntimeState(parsed), corrupt: false, raw }
  } catch {
    return { state: null, corrupt: true, raw }
  }
}

/**
 * 补齐缺省字段。缺字段不算损坏（旧版本写出来的 state 要能读）。
 * @param {any} parsed
 * @returns {RuntimeState}
 */
export function normalizeRuntimeState(parsed) {
  const base = emptyRuntimeState()
  const merged = { ...base, ...parsed }
  if (!Array.isArray(merged.recentEventIds)) merged.recentEventIds = []
  if (!Number.isFinite(merged.autoTaskSeq)) merged.autoTaskSeq = 0
  if (merged.status !== 'active' && merged.status !== 'ended') merged.status = 'ended'
  if (merged.sessionIdSource !== 'host' && merged.sessionIdSource !== 'generated') {
    merged.sessionIdSource = 'generated'
  }
  if (!Array.isArray(merged.pendingConfirms)) delete merged.pendingConfirms
  if (merged.degraded && !['L1', 'L2'].includes(merged.degraded.level)) delete merged.degraded
  return merged
}

/**
 * 写 runtime-state。原子写；失败由调用方决定是否阻断。
 * @param {string} file
 * @param {RuntimeState} state
 */
export async function writeRuntimeState(file, state) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, `${jsonText(state)}\n`)
  return state
}

/**
 * 事件去重（§4.8）：eventId 重复投递只处理一次，跨重启靠 recentEventIds。
 * 返回 true 表示「是新事件，应当处理」。
 *
 * @param {RuntimeState} state
 * @param {string} eventId
 * @param {number} maxIds
 * @returns {boolean}
 */
export function noteEventId(state, eventId, maxIds) {
  if (!eventId) return true
  if (state.recentEventIds.includes(eventId)) return false
  state.recentEventIds.push(eventId)
  const limit = Math.max(1, Number(maxIds) || 1000)
  if (state.recentEventIds.length > limit) {
    state.recentEventIds.splice(0, state.recentEventIds.length - limit)
  }
  return true
}

/**
 * 升降级级别。只升不降（§15.5：恢复唯一方式是插件外修复 + 重启）。
 * @param {RuntimeState} state
 * @param {'L1'|'L2'} level
 * @param {string} reason
 * @param {string} [trigger]
 */
export function escalateDegraded(state, level, reason, trigger) {
  const now = new Date().toISOString()
  const current = state.degraded
  if (!current) {
    state.degraded = { level, reason, since: now, triggers: trigger ? [trigger] : [] }
    return state.degraded
  }
  if (level === 'L2' && current.level === 'L1') current.level = 'L2'
  current.reason = reason
  if (trigger && !current.triggers.includes(trigger)) current.triggers.push(trigger)
  return current
}

/**
 * 记一个待确认的 confirmToken（§15.3）。一个会话有效，用后即焚。
 * @param {RuntimeState} state
 * @param {string} token
 * @param {string} opHash
 */
export function rememberConfirm(state, token, opHash) {
  if (!Array.isArray(state.pendingConfirms)) state.pendingConfirms = []
  state.pendingConfirms.push({ token, opHash, createdAt: new Date().toISOString() })
  return state.pendingConfirms
}

/**
 * 取走并焚毁一个 confirmToken。参数哈希必须一致。
 * @param {RuntimeState} state
 * @param {string} token
 * @param {string} opHash
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function consumeConfirm(state, token, opHash) {
  const list = Array.isArray(state.pendingConfirms) ? state.pendingConfirms : []
  const index = list.findIndex((item) => item.token === token)
  if (index < 0) return { ok: false, reason: '该确认令牌不存在或已使用' }
  const found = list[index]
  if (found.opHash !== opHash) return { ok: false, reason: '确认令牌与本次参数不匹配' }
  list.splice(index, 1)
  return { ok: true }
}
