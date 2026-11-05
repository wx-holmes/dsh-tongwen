/**
 * self-snapshot.json —— 规格 §8.6。
 *
 * 基线 + 会话结束标记。判定「上次是否正常结束」靠它和 runtime-state 两处对照，
 * 单看其中任何一个都不算数（§14.1 明确禁止）。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.js'
import { jsonText } from './json-text.js'
import { SNAPSHOT_SCHEMA_VERSION } from './context.js'

/**
 * @typedef {object} SessionEndBlock
 * @property {string} sessionId
 * @property {string} endedAt
 * @property {'normal'|'abnormal'} status
 * @property {boolean} zeroChange
 * @property {boolean} journalWritten
 * @property {string|null} journalRef
 * @property {boolean} [partial]
 * @property {'timeout'|'maxDepth'|'maxFiles'} [partialReason]
 * @property {boolean} [baselineEstablished]
 * @property {boolean} [baselinePending]
 */

/**
 * @typedef {object} Snapshot
 * @property {string} schemaVersion
 * @property {string|null} lastScanAt
 * @property {string|null} lastCompleteScanAt
 * @property {'best_effort'} scanConsistency
 * @property {import('./self-scan.js').SelfFileEntry[]} files
 * @property {'self'|'handoff'} [scope] 统计范围（0.3.7）；缺省视为 self
 * @property {boolean} baselineEstablished
 * @property {string|null} baselineEstablishedAt
 * @property {boolean} baselinePending
 * @property {SessionEndBlock|null} sessionEnd
 */

/** @returns {Snapshot} */
export function emptySnapshot() {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    lastScanAt: null,
    lastCompleteScanAt: null,
    scanConsistency: 'best_effort',
    files: [],
    scope: 'self',
    baselineEstablished: false,
    baselineEstablishedAt: null,
    baselinePending: false,
    sessionEnd: null,
  }
}

/**
 * 读快照。文件不存在 → `{snapshot: null}`（这是判定矩阵的输入，不能悄悄造一个）。
 * 损坏 → corrupt=true，由调用方走「快照丢失」分支。
 *
 * @param {string} file
 * @returns {Promise<{snapshot: Snapshot|null, corrupt: boolean}>}
 */
export async function readSnapshot(file) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT') {
      // §10.6：上次快照写失败的 tmp 会留成 .pending.json，读它兜底。
      const pending = file.replace(/\.json$/, '.pending.json')
      try {
        const pendingRaw = await fsp.readFile(pending, 'utf8')
        return { snapshot: normalizeSnapshot(JSON.parse(pendingRaw)), corrupt: false }
      } catch {
        return { snapshot: null, corrupt: false }
      }
    }
    return { snapshot: null, corrupt: true }
  }
  try {
    return { snapshot: normalizeSnapshot(JSON.parse(raw)), corrupt: false }
  } catch {
    return { snapshot: null, corrupt: true }
  }
}

/**
 * @param {any} parsed
 * @returns {Snapshot}
 */
export function normalizeSnapshot(parsed) {
  const base = emptySnapshot()
  const merged = { ...base, ...(parsed ?? {}) }
  if (!Array.isArray(merged.files)) merged.files = []
  if (merged.sessionEnd && typeof merged.sessionEnd !== 'object') merged.sessionEnd = null
  return merged
}

/**
 * 写快照。快照失败**不阻断**会话收尾，但要留 pending 供下次补提交（§10.6）。
 * @param {string} file
 * @param {Snapshot} snapshot
 */
export async function writeSnapshot(file, snapshot) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, `${jsonText(snapshot)}\n`, {
    onFailureTmp: 'keep-pending',
  })
  return snapshot
}

/**
 * 判断是不是「首次」（§8.6）：快照不存在，或 files 空且没有 sessionEnd。
 * @param {Snapshot|null} snapshot
 * @param {boolean} corrupt
 */
export function isFirstRun(snapshot, corrupt) {
  if (corrupt) return false // 损坏走「快照丢失」分支，不是首次
  if (!snapshot) return true
  // 建过基线就不再是首次——self/ 本来就可能是空的，files 空不能反证没建过。
  if (snapshot.baselineEstablished) return false
  return snapshot.files.length === 0 && !snapshot.sessionEnd
}

/**
 * 建立首次基线：全部文件入基线，不产生「新增」，不触发 report，不写 journal。
 * 首次 partial → 不建基线，标 baselinePending（§8.6 / §14.1）。
 *
 * @param {Snapshot} snapshot
 * @param {import('./self-scan.js').ScanResult} scan
 * @param {string} now
 */
export function establishBaseline(snapshot, scan, now) {
  snapshot.lastScanAt = now

  if (scan.partial) {
    snapshot.baselinePending = true
    snapshot.baselineEstablished = false
    return snapshot
  }

  snapshot.files = scan.files
  snapshot.baselineEstablished = true
  snapshot.baselineEstablishedAt = now
  snapshot.baselinePending = false
  snapshot.lastCompleteScanAt = now
  return snapshot
}

/**
 * 会话结束执行结果应用（§4.6 / §8.6）。
 *
 * partial 时**只写 sessionEnd 标 partial，不更新 files 与 lastCompleteScanAt**（§8.5）。
 *
 * @param {Snapshot} snapshot
 * @param {object} params
 * @param {import('./self-scan.js').ScanResult} params.scan
 * @param {string} params.sessionId
 * @param {string} params.endedAt
 * @param {boolean} params.zeroChange
 * @param {boolean} params.journalWritten
 * @param {string|null} params.journalRef
 */
export function applySessionEnd(snapshot, { scan, sessionId, endedAt, zeroChange, journalWritten, journalRef }) {
  snapshot.lastScanAt = endedAt

  if (!scan.partial) {
    snapshot.files = scan.files
    snapshot.lastCompleteScanAt = endedAt
    snapshot.baselineEstablished = true
    snapshot.baselineEstablishedAt = snapshot.baselineEstablishedAt ?? endedAt
    snapshot.baselinePending = false
  }

  snapshot.sessionEnd = {
    sessionId,
    endedAt,
    status: 'normal',
    zeroChange,
    journalWritten,
    journalRef,
    ...(scan.partial ? { partial: true, partialReason: scan.partialReason ?? 'timeout' } : {}),
  }
  return snapshot
}
