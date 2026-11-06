/**
 * 工具实现 —— 规格 §4.9。
 *
 * 八个工具共用一个统一返回壳：
 *   {ok, sessionId, effectiveTaskKey, idempotency, degradedLevel, errorCode}
 *
 * 这一层只做「校验 + 调 lib + 包返回」，不自己发明规则。
 * 工具**抛错**给模型是没有意义的（模型只会看到一段异常文本），
 * 所以所有 pluginError 都在这里被折成带 errorCode 的正常返回。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { BUCKET_KEYS, RESTORE_TARGET_BUCKETS } from './buckets.js'
import { pluginError } from './errors.js'
import { parseMachine, parseUser } from './handoff.js'
import { updateHandoffReadme, updateProjectOverview } from './catalog.js'
import { loadIndex, saveIndex } from './index-store.js'
import { writeRuntimeState } from './runtime-state.js'
import { writeFileAtomic } from './atomic.js'
import { backupBeforeOverwrite, backupDataFile, listDataVersions } from './versions.js'
import {
  loadRecoveryLog,
  findRestorable,
  appendRecoveryRecord,
  alreadyRestored,
} from './recovery-log.js'
import { beginTask as beginTaskCore, endTask as endTaskCore, assertUpdatableSection, timestampForDir } from './task.js'
import { describeBroadcast, pendingBroadcastSync } from './restart.js'
import { markTaskOpen } from './presence.js'
import {
  projectIdOf,
  readProject,
  listProjects,
  upsertProject,
  PROJECT_STATUSES,
} from './projects.js'
import {
  readInbox,
  appendRequest,
  appendClose,
  filterInbox,
  BROADCAST,
} from './inbox.js'
import { routeFocus } from './relevance.js'
import { sha256 } from './hash.js'
import { toPosix } from './paths.js'
import { appendOpenItem } from './open-items.js'
import { appendDirection } from './directions.js'
import { ulid } from './ulid.js'

/** 短句索引匹配的原因枚举（§4.9 施工时定）。 */
export const MATCH_REASONS = Object.freeze([
  'instance_exact',
  'instance_partial',
  'display_partial',
  'type_partial',
])

/**
 * 工具返回必须是 lossless JSON：undefined / NaN / Infinity / BigInt 都会让宿主拒收。
 * 这里统一剥掉，避免任何分支漏一个 undefined 就整次调用失败。
 * @param {unknown} value
 */
function stripNonJson(value) {
  if (Array.isArray(value)) return value.map(stripNonJson)
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) {
      const cleaned = stripNonJson(inner)
      if (cleaned !== undefined) out[key] = cleaned
    }
    return out
  }
  return value
}

/**
 * 统一返回壳。
 * @param {object} runtime
 * @param {object} payload
 */
export function envelope(runtime, payload) {
  return stripNonJson({
    ok: payload.ok ?? true,
    sessionId: runtime.sessionId,
    effectiveTaskKey: payload.effectiveTaskKey ?? runtime.currentTask?.effectiveTaskKey ?? null,
    idempotency: payload.idempotency ?? runtime.currentTask?.idempotency ?? (runtime.sessionIdSource === 'generated' ? 'weak' : 'unavailable'),
    degradedLevel: runtime.degradedLevel,
    errorCode: payload.errorCode ?? null,
    ...payload,
  })
}

/**
 * 把异常折成统一返回。
 * @param {object} runtime
 * @param {unknown} error
 */
export function failure(runtime, error) {
  const code = error?.code && /^E_[A-Z_]+$/.test(String(error.code)) ? String(error.code) : 'E_IO'
  return envelope(runtime, {
    ok: false,
    errorCode: code,
    message: String(error?.message ?? error ?? '未知错误'),
  })
}

/* ------------------------------------------------------------------ */
/* locate                                                             */
/* ------------------------------------------------------------------ */

/**
 * 按关键词找实例。返回候选，不替用户决定。
 *
 * @param {object} runtime
 * @param {{query?: string, bucket?: string, typeSlug?: string, limit?: number}} input
 */
export async function locate(runtime, input) {
  const query = typeof input?.query === 'string' ? input.query.trim() : ''
  if (!query) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'query', reason: '查询内容不能为空' })
  }

  const limit = clampLimit(input?.limit, runtime.config['tools.listHandoffsDefaultLimit'], runtime.config['tools.listHandoffsMaxLimit'])
  const { index } = await loadIndex(runtime.ctx.indexFile)
  const needle = query.toLowerCase()

  /** @type {Array<{bucket: string, typeSlug: string, instance: string, displayName: string, machineHandoff: string|null, matchReason: string, score: number}>} */
  const hits = []

  for (const entry of index.entries) {
    if (entry.kind !== 'instance') continue
    if (entry.status === 'lost') continue
    if (input?.bucket && entry.bucket !== input.bucket) continue
    if (input?.typeSlug && entry.typeSlug !== input.typeSlug) continue

    const instance = String(entry.instance ?? '')
    const displayName = String(entry.displayName ?? '')
    const typeDisplay = String(index.types.find((t) => t.typeSlug === entry.typeSlug)?.typeDisplayName ?? entry.typeSlug ?? '')

    let matchReason = null
    let score = 0
    if (instance.toLowerCase() === needle) {
      matchReason = 'instance_exact'
      score = 100
    } else if (instance.toLowerCase().includes(needle)) {
      matchReason = 'instance_partial'
      score = 60
    } else if (displayName.toLowerCase().includes(needle)) {
      matchReason = 'display_partial'
      score = 40
    } else if (typeDisplay.toLowerCase().includes(needle)) {
      matchReason = 'type_partial'
      score = 20
    }
    if (!matchReason) continue

    hits.push({
      bucket: entry.bucket,
      typeSlug: entry.typeSlug,
      instance: entry.instance,
      displayName: entry.displayName ?? entry.instance,
      machineHandoff: entry.machineHandoff ?? null,
      matchReason,
      score,
    })
  }

  hits.sort((a, b) => b.score - a.score || String(a.instance).localeCompare(String(b.instance)))
  const trimmed = hits.slice(0, limit).map(({ score, ...rest }) => rest)

  if (trimmed.length === 0) {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_NOT_FOUND',
      candidates: [],
      total: 0,
      message: `没有找到匹配「${query}」的实例`,
    })
  }

  return envelope(runtime, { candidates: trimmed, total: hits.length })
}

/* ------------------------------------------------------------------ */
/* inspect_handoff                                                    */
/* ------------------------------------------------------------------ */

/**
 * 读一份交接。path 优先于 instance；路径越界直接拒绝。
 *
 * @param {object} runtime
 * @param {{path?: string, instance?: string, kind?: 'machine'|'user', version?: number}} input
 */
export async function inspectHandoff(runtime, input) {
  const kind = input?.kind === 'user' ? 'user' : 'machine'
  const maxBytes = Number(runtime.config['tools.inspectMaxKB']) * 1024

  let absPath = null
  let isLatest = true
  let versionNumber = null
  let archivedAt = null

  if (typeof input?.path === 'string' && input.path.trim()) {
    const resolved = await resolveHandoffPath(runtime, input.path.trim())
    absPath = resolved.absPath
    isLatest = resolved.isLatest
    versionNumber = resolved.versionNumber
    archivedAt = resolved.archivedAt
    if (!resolved.isLatest && kind !== inferKindFromPath(input.path)) {
      // path 已指明具体文件，kind 只影响解析方式，不重定向
    }
  } else if (typeof input?.instance === 'string' && input.instance.trim()) {
    const found = await findHandoffByInstance(runtime, input.instance.trim(), kind, input?.version)
    absPath = found.absPath
    isLatest = found.isLatest
    versionNumber = found.versionNumber
    archivedAt = found.archivedAt
  } else {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'path', reason: '需要提供 path 或 instance' })
  }

  let raw
  try {
    raw = await fsp.readFile(absPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return envelope(runtime, { ok: false, errorCode: 'E_NOT_FOUND', message: `不存在：${toPosix(absPath)}` })
    }
    throw error
  }

  const truncated = Buffer.byteLength(raw, 'utf8') > maxBytes
  const text = truncated ? `${raw.slice(0, maxBytes)}\n\n...（已截断，原文 ${Buffer.byteLength(raw, 'utf8')} 字节）` : raw

  const structured = kind === 'machine' ? parseMachine(text).structured : parseUser(text)

  return envelope(runtime, {
    path: toPosix(path.relative(runtime.ctx.root, absPath)),
    kind,
    structured,
    raw: text,
    isLatest,
    versionNumber,
    archivedAt,
    truncated,
  })
}

/** @param {string} specPath */
function inferKindFromPath(specPath) {
  return specPath.includes('.user.md') ? 'user' : 'machine'
}

/**
 * 解析 handoff/ 或 archive/versions/ 下的路径（§4.9 硬约束）。
 * @param {object} runtime
 * @param {string} specPath
 */
async function resolveHandoffPath(runtime, specPath) {
  const normalized = specPath.replace(/\\/g, '/')
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.includes('..')) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'path', reason: '只接受 handoff/ 或 archive/versions/ 下的相对路径' })
  }

  const absPath = path.resolve(runtime.ctx.root, ...normalized.split('/'))
  const rel = toPosix(path.relative(runtime.ctx.root, absPath))
  const inHandoff = rel.startsWith('handoff/')
  const inVersions = rel.startsWith('archive/versions/')
  if (!inHandoff && !inVersions) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'path', reason: '路径必须落在 handoff/ 或 archive/versions/ 内' })
  }

  if (inHandoff) return { absPath, isLatest: true, versionNumber: null, archivedAt: null }

  // archive/versions/<实例>/<文件>.<n>
  const match = /^archive\/versions\/([^/]+)\/(.+)\.(\d+)$/.exec(rel)
  if (!match) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'path', reason: '版本文件路径格式应为 archive/versions/<实例>/<文件>.<n>' })
  }
  let archivedAt = null
  try {
    archivedAt = (await fsp.stat(absPath)).mtime.toISOString()
  } catch {
    archivedAt = null
  }
  return { absPath, isLatest: false, versionNumber: Number(match[3]), archivedAt }
}

/**
 * 按实例名找交接文件。
 * @param {object} runtime
 * @param {string} instance
 * @param {'machine'|'user'} kind
 * @param {number|undefined} version
 */
async function findHandoffByInstance(runtime, instance, kind, version) {
  const { index } = await loadIndex(runtime.ctx.indexFile)
  const entry = index.entries.find((item) => item.kind === 'instance' && item.instance === instance)
  if (!entry) {
    throw pluginError('E_NOT_FOUND', { path: instance, reason: '索引里没有这个实例' })
  }

  const fileName = `${instance}.${kind}.md`
  if (!version) {
    const rel = kind === 'machine' ? entry.machineHandoff : entry.userHandoff
    if (!rel) throw pluginError('E_NOT_FOUND', { path: `${instance}（${kind} 版）`, reason: '索引里没有登记这份交接' })
    const absPath = path.resolve(runtime.ctx.root, ...toPosix(rel).split('/'))
    return { absPath, isLatest: true, versionNumber: null, archivedAt: null }
  }

  const versionsDir = path.join(runtime.ctx.versionsDir, instance)
  const absPath = path.join(versionsDir, `${fileName}.${version}`)
  let archivedAt = null
  try {
    archivedAt = (await fsp.stat(absPath)).mtime.toISOString()
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw pluginError('E_NOT_FOUND', { path: `${instance} 第 ${version} 版`, reason: '版本文件不存在' })
    }
    throw error
  }
  return { absPath, isLatest: false, versionNumber: version, archivedAt }
}

/* ------------------------------------------------------------------ */
/* list_handoffs                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {object} runtime
 * @param {{typeSlug?: string, status?: string, from?: string, to?: string, limit?: number, offset?: number}} input
 */
export async function listHandoffs(runtime, input) {
  const limit = clampLimit(input?.limit, runtime.config['tools.listHandoffsDefaultLimit'], runtime.config['tools.listHandoffsMaxLimit'])
  const offset = Math.max(0, Number(input?.offset) || 0)

  if (input?.limit !== undefined && Number(input.limit) > Number(runtime.config['tools.listHandoffsMaxLimit'])) {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_LIMIT_EXCEEDED',
      limit,
      message: `limit 超过上限 ${runtime.config['tools.listHandoffsMaxLimit']}`,
    })
  }

  const { index } = await loadIndex(runtime.ctx.indexFile)
  const fromMs = parseTime(input?.from)
  const toMs = parseTime(input?.to)

  let items = index.entries.filter((entry) => entry.kind === 'instance')
  if (input?.typeSlug) items = items.filter((entry) => entry.typeSlug === input.typeSlug)
  if (input?.status) items = items.filter((entry) => entry.status === input.status)
  if (fromMs !== null) items = items.filter((entry) => Date.parse(entry.lastUpdated ?? '') >= fromMs)
  if (toMs !== null) items = items.filter((entry) => Date.parse(entry.lastUpdated ?? '') <= toMs)

  items = items.sort((a, b) => Date.parse(b.lastUpdated ?? '') - Date.parse(a.lastUpdated ?? ''))
  const page = items.slice(offset, offset + limit)

  return envelope(runtime, {
    items: page.map((entry) => ({
      entryId: entry.entryId,
      bucket: entry.bucket,
      typeSlug: entry.typeSlug,
      instance: entry.instance,
      displayName: entry.displayName,
      status: entry.status,
      machineHandoff: entry.machineHandoff,
      userHandoff: entry.userHandoff,
      lastUpdated: entry.lastUpdated,
      latestDirectionId: entry.latestDirectionId,
    })),
    total: items.length,
    limit,
    offset,
  })
}

/** @param {unknown} value */
function parseTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** @param {unknown} limit @param {number} fallback @param {number} max */
function clampLimit(limit, fallback, max) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return Number(fallback) || 20
  return Math.min(Math.floor(n), Number(max) || 100)
}

/* ------------------------------------------------------------------ */
/* update_handoff                                                     */
/* ------------------------------------------------------------------ */

/**
 * 只允许改四节，整节替换，强制版本化（§4.9）。
 *
 * @param {object} runtime
 * @param {{instance?: string, section?: string, content?: string}} input
 */
export async function updateHandoff(runtime, input) {
  if (runtime.degradedLevel !== 'normal') {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_DEGRADED_READONLY',
      message: '当前为降级只读，未执行任何写入',
    })
  }

  const instance = typeof input?.instance === 'string' ? input.instance.trim() : ''
  if (!instance) throw pluginError('E_VALIDATION_BLOCKING', { field: 'instance', reason: '需要实例名' })

  const section = assertUpdatableSection(String(input?.section ?? '').trim())
  const content = String(input?.content ?? '')
  if (!content.trim()) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'content', reason: '整节内容不能为空' })
  }

  const { index } = await loadIndex(runtime.ctx.indexFile)
  const entry = index.entries.find((item) => item.kind === 'instance' && item.instance === instance)
  if (!entry?.machineHandoff) {
    return envelope(runtime, { ok: false, errorCode: 'E_NOT_FOUND', message: `不存在：${instance}` })
  }

  const absPath = path.resolve(runtime.ctx.root, ...toPosix(entry.machineHandoff).split('/'))
  let original
  try {
    original = await fsp.readFile(absPath, 'utf8')
  } catch {
    return envelope(runtime, { ok: false, errorCode: 'E_NOT_FOUND', message: `不存在：${entry.machineHandoff}` })
  }

  const replaced = replaceSection(original, section, content)
  if (replaced === null) {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_VALIDATION_BLOCKING',
      message: `交接里没有「${section}」这一节，无法替换`,
    })
  }

  // 版本化
  const names = { machine: `${instance}.machine.md` }
  const backup = await backupBeforeOverwrite({
    sourcePath: absPath,
    versionsDir: path.join(runtime.ctx.versionsDir, instance),
    baseName: names.machine,
  })
  if (backup.status === 'skipped') {
    await runtime.writer.write({ op: 'versions.duplicateSkipped', target: names.machine, result: 'ok' })
  }

  await writeFileAtomic(absPath, replaced)

  const newHash = sha256(replaced)
  entry.contentHash = newHash
  entry.lastUpdated = new Date().toISOString()
  try {
    await saveIndex(runtime.ctx.indexFile, index)
  } catch {
    // 索引失败不阻断
  }

  await runtime.writer.write({
    op: 'tools.update_handoff',
    target: entry.machineHandoff,
    beforeHash: sha256(original),
    afterHash: newHash,
    result: 'ok',
    sessionId: runtime.sessionId,
  })

  return envelope(runtime, {
    path: entry.machineHandoff,
    section,
    versionNumber: backup.status === 'backed-up' ? backup.versionNumber : null,
  })
}

/**
 * 把某一节整体替换掉。节标题精确匹配 `## <标题>`。
 * 返回 null 表示原文里没有这一节。
 *
 * @param {string} text
 * @param {string} section
 * @param {string} content
 */
export function replaceSection(text, section, content) {
  const lines = String(text).split('\n')
  const headerIndex = lines.findIndex((line) => line.trim() === `## ${section}`)
  if (headerIndex < 0) return null

  let endIndex = lines.length
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      endIndex = i
      break
    }
  }

  const body = content.trim().endsWith('\n') ? content.trim() : `${content.trim()}`
  const replacement = [`## ${section}`, '', ...body.split('\n'), '']
  return [...lines.slice(0, headerIndex), ...replacement, ...lines.slice(endIndex)].join('\n')
}

/* ------------------------------------------------------------------ */
/* heartbeat                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} runtime
 */
export async function heartbeat(runtime) {
  const at = new Date().toISOString()
  runtime.runtimeState.lastHeartbeatAt = at
  try {
    await writeRuntimeState(runtime.ctx.runtimeStateFile, runtime.runtimeState)
  } catch {
    // 心跳写失败静默（§4.9 heartbeat 错误码列为「静默」）
  }
  return envelope(runtime, { lastHeartbeatAt: at })
}

/* ------------------------------------------------------------------ */
/* restore                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从 archive/trash 或 archive/versions 恢复（§10.3）。
 *
 * @param {object} runtime
 * @param {{originalPath?: string, targetBucket?: string}} input
 */
export async function restore(runtime, input) {
  if (runtime.degradedLevel !== 'normal') {
    return envelope(runtime, { ok: false, errorCode: 'E_DEGRADED_READONLY', message: '当前为降级只读，未执行恢复' })
  }

  const originalPath = String(input?.originalPath ?? '').trim()
  if (!originalPath) throw pluginError('E_VALIDATION_BLOCKING', { field: 'originalPath', reason: '需要来源路径' })

  const { records } = await loadRecoveryLog(runtime.ctx.recoveryLogFile)
  if (alreadyRestored(records, originalPath)) {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_VALIDATION_BLOCKING',
      message: '这个路径已经恢复过，不再重复恢复',
    })
  }

  const found = findRestorable(records, originalPath)
  if (!found.found) {
    return envelope(runtime, { ok: false, errorCode: 'E_NOT_FOUND', message: found.reason ?? '没有可恢复的记录' })
  }

  const record = found.record
  const isFromVersions = String(record.source) === 'versions_cleanup' || originalPath.startsWith('archive/versions/')

  let targetBucket = typeof input?.targetBucket === 'string' ? input.targetBucket.trim().toLowerCase() : ''
  if (isFromVersions) {
    // 从 versions 恢复必须显式指定，且只能用允许集合（§4.9）
    if (!targetBucket) {
      return envelope(runtime, {
        ok: false,
        errorCode: 'E_VALIDATION_BLOCKING',
        message: `从版本备份恢复必须显式指定 targetBucket（允许：${RESTORE_TARGET_BUCKETS.join(' / ')}）`,
      })
    }
    if (!RESTORE_TARGET_BUCKETS.includes(targetBucket)) {
      return envelope(runtime, {
        ok: false,
        errorCode: 'E_VALIDATION_BLOCKING',
        message: `targetBucket 不允许：${targetBucket}（允许：${RESTORE_TARGET_BUCKETS.join(' / ')}）`,
      })
    }
  } else {
    if (!targetBucket) targetBucket = originalPath.split('/')[0]
    if (!BUCKET_KEYS.includes(targetBucket)) {
      return envelope(runtime, { ok: false, errorCode: 'E_VALIDATION_BLOCKING', message: `targetBucket 非法：${targetBucket}` })
    }
  }

  // trash/<ts>/from-<bucket>/<相对路径> 与 versions 的 physicalPath 都从第 5 段起是「档内相对路径」
  const restoreRoot = path.join(
    runtime.ctx.restoredDir,
    timestampForDir(new Date()),
    isFromVersions ? 'from-archive' : `from-${targetBucket}`,
  )
  const physicalSegments = toPosix(String(record.physicalPath ?? '')).split('/')
  const targetAbs = path.join(restoreRoot, ...physicalSegments.slice(4))

  const physicalAbs = path.resolve(runtime.ctx.root, ...physicalSegments)

  try {
    await fsp.stat(targetAbs)
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_RESTORE_CONFLICT',
      message: `恢复目标已存在：${toPosix(path.relative(runtime.ctx.root, targetAbs))}`,
    })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  await fsp.mkdir(path.dirname(targetAbs), { recursive: true })
  try {
    await fsp.rename(physicalAbs, targetAbs)
  } catch (error) {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_IO',
      message: `恢复移动失败：${error?.code ?? '未知错误'}`,
    })
  }

  let size = 0
  try {
    size = (await fsp.stat(targetAbs)).size
  } catch {
    size = 0
  }

  await appendRecoveryRecord({
    file: runtime.ctx.recoveryLogFile,
    event: 'restore',
    originalPath,
    physicalPath: toPosix(path.relative(runtime.ctx.root, targetAbs)),
    source: 'restore',
    size,
    hash: null,
    reason: 'restore 工具调用',
    sessionId: runtime.sessionId,
    result: 'committed',
  })

  // 恢复后进索引：新 entryId，不复用原实例
  const { index } = await loadIndex(runtime.ctx.indexFile)
  const originalEntry = findOriginalEntry(index, originalPath)
  const instanceName = originalEntry?.instance ?? instanceNameFromPath(originalPath)
  const entry = {
    entryId: ulid(),
    kind: 'instance',
    bucket: targetBucket,
    typeSlug: originalEntry?.typeSlug ?? typeSlugFromPath(originalPath),
    instance: instanceName,
    displayName: originalEntry?.displayName ?? instanceName,
    purpose: null,
    status: 'active',
    machineHandoff: toPosix(path.relative(runtime.ctx.root, targetAbs)),
    userHandoff: null,
    lastUpdated: new Date().toISOString(),
    contentHash: null,
    originTaskId: null,
    effectiveTaskKey: runtime.currentTask?.effectiveTaskKey ?? null,
    taskIdScope: null,
    taskIdSource: null,
    sessionId: runtime.sessionId,
    idempotency: 'weak',
    eventId: null,
    latestDirectionId: null,
    directionIds: [],
    directionBroken: false,
    originalEntryId: originalEntry?.entryId ?? null,
    notes: `恢复自 ${originalPath}，原实例 ${instanceName}`,
  }
  index.entries.push(entry)
  try {
    await saveIndex(runtime.ctx.indexFile, index)
  } catch {
    // 索引失败不阻断
  }

  // 方向记录：固定字段（§4.9）
  try {
    const result = await appendDirection({
      file: runtime.ctx.directionsFile,
      sessionId: runtime.sessionId,
      bucket: targetBucket,
      typeSlug: entry.typeSlug,
      instance: entry.instance,
      direction: `从 ${originalPath} 恢复`,
      relationToPrevious: 'origin',
      reason: 'restore 工具调用',
      decidedBy: 'dsh_inferred',
      userVerdict: 'not_applicable',
      verdictQuote: null,
      limits: {
        maxLineKB: Number(runtime.config['direction.maxLineKB']),
        quoteMaxChars: Number(runtime.config['direction.quoteMaxChars']),
      },
    })
    entry.latestDirectionId = result.record.directionId
    entry.directionIds = [result.record.directionId]
  } catch {
    // 方向记录失败不阻断
  }

  await appendOpenItem({
    file: runtime.ctx.openItemsFile,
    event: 'open',
    category: 'restored_pending_user_check',
    stableKey: originalPath,
    summary: '文件已从归档恢复，请确认是否归位',
    sessionId: runtime.sessionId,
    related: { path: entry.machineHandoff, entryId: entry.entryId },
    maxActive: Number(runtime.config['openItems.maxActive']),
  }).catch(() => {})

  await runtime.writer.write({
    op: 'tools.restore',
    target: entry.machineHandoff,
    result: 'ok',
    sessionId: runtime.sessionId,
  })

  return envelope(runtime, {
    entryId: entry.entryId,
    originalPath,
    restoredPath: entry.machineHandoff,
    versionNumber: isFromVersions ? Number(String(originalPath).match(/\.(\d+)$/)?.[1] ?? null) : null,
  })
}

/* ------------------------------------------------------------------ */
/* archive_handoff                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把一个交接实例整份软删：机器版/用户版移进 `archive/trash/<时间戳>/from-<档>/`，
 * 回收记录记一条 `source=bucket_soft_delete`（restore 工具能找回），再从索引摘掉条目。
 *
 * @param {object} runtime
 * @param {object} input
 * @param {string} input.instance 实例物理名
 * @param {string} [input.reason] 归档原因，写进回收记录
 */
export async function archiveHandoff(runtime, input) {
  if (runtime.degradedLevel !== 'normal') {
    return envelope(runtime, { ok: false, errorCode: 'E_DEGRADED_READONLY', message: '当前为降级只读，未执行归档' })
  }

  const instance = String(input?.instance ?? '').trim()
  if (!instance) throw pluginError('E_VALIDATION_BLOCKING', { field: 'instance', reason: '需要实例名' })
  const reason = typeof input?.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'archive_handoff 工具调用'

  const { index } = await loadIndex(runtime.ctx.indexFile)
  const entry = index.entries.find(
    (item) => item.kind === 'instance' && item.instance === instance && item.status !== 'lost',
  )
  if (!entry) {
    return envelope(runtime, { ok: false, errorCode: 'E_NOT_FOUND', message: `索引里没有这个实例：${instance}` })
  }

  const bucket = BUCKET_KEYS.includes(entry.bucket) ? entry.bucket : 'handoff'
  const stamp = timestampForDir(new Date())
  const trashRoot = path.join(runtime.ctx.trashDir, stamp, `from-${bucket}`)
  const relPaths = [entry.machineHandoff, entry.userHandoff].filter(
    (item) => typeof item === 'string' && item.length > 0,
  )

  /** 目标已存在就加 -2/-3，绝不覆盖 trash 里的旧文件。 */
  const taken = async (file) => {
    try {
      await fsp.stat(file)
      return true
    } catch {
      return false
    }
  }

  /** @type {{originalPath: string, physicalPath: string}[]} */
  const archived = []
  try {
    for (const relPath of relPaths) {
      const segments = toPosix(relPath).split('/')
      const sourceAbs = path.resolve(runtime.ctx.root, ...segments)
      let targetAbs = path.join(trashRoot, ...segments.slice(1))
      for (let n = 2; await taken(targetAbs); n += 1) {
        const parsed = path.parse(targetAbs)
        targetAbs = path.join(parsed.dir, `${parsed.name}-${n}${parsed.ext}`)
      }
      await fsp.mkdir(path.dirname(targetAbs), { recursive: true })
      await fsp.rename(sourceAbs, targetAbs)
      const physicalPath = toPosix(path.relative(runtime.ctx.root, targetAbs))
      await appendRecoveryRecord({
        file: runtime.ctx.recoveryLogFile,
        event: 'trash',
        originalPath: relPath,
        physicalPath,
        source: 'bucket_soft_delete',
        size: 0,
        hash: null,
        reason,
        sessionId: runtime.sessionId,
        result: 'committed',
      })
      archived.push({ originalPath: relPath, physicalPath })
    }
  } catch (error) {
    return envelope(runtime, { ok: false, errorCode: 'E_IO', message: `归档移动失败：${error?.code ?? '未知错误'}` })
  }

  // 文件挪走了再摘索引条目；索引写失败要如实回报，别让条目指向空路径。
  index.entries = index.entries.filter((item) => item !== entry)
  try {
    await saveIndex(runtime.ctx.indexFile, index)
  } catch (error) {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_IO',
      message: `文件已进 archive/trash，但索引更新失败：${error?.code ?? '未知错误'}`,
    })
  }

  await runtime.writer.write({
    op: 'tools.archive_handoff',
    target: instance,
    result: 'ok',
    note: reason,
    sessionId: runtime.sessionId,
  })

  return envelope(runtime, {
    instance,
    entryId: entry.entryId,
    bucket,
    trashedAt: stamp,
    archived,
  })
}

/* ------------------------------------------------------------------ */
/* begin_task / end_task                                              */
/* ------------------------------------------------------------------ */

/**
 * 任务登记。bucket 必须显式给（§4.7 禁止「没线索就放 created」）。
 *
 * @param {object} runtime
 * @param {object} input
 */
export async function beginTask(runtime, input) {
  if (runtime.degradedLevel !== 'normal') {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_DEGRADED_READONLY',
      message: '当前为降级只读，未执行任务登记',
    })
  }

  const result = await beginTaskCore({
    ctx: runtime.ctx,
    writer: runtime.writer,
    config: runtime.config,
    runtimeState: runtime.runtimeState,
    index: runtime.index,
    sessionId: runtime.sessionId,
    sessionIdSource: runtime.sessionIdSource,
    input: input ?? {},
  })

  if (result && !result.errorCode) {
    runtime.currentTask = { ...result, ok: true }
    // 进行中的任务也要落盘：进程被硬杀时，补记要靠它说明「当时在做什么」。
    try {
      runtime.runtimeState.currentTask = {
        instance: result.instance,
        bucket: result.bucket,
        typeSlug: result.typeSlug,
        typeDisplayName: result.typeDisplayName,
        taskId: result.taskId,
        purpose: result.purpose,
        startedAt: result.startedAt,
      }
      await writeRuntimeState(runtime.ctx.runtimeStateFile, runtime.runtimeState)
    } catch {
      // 落盘失败不阻断任务登记
    }
    // 0.5.0 重启广播：有人要重启就提醒一声——新开的活很可能被切断。
    try {
      const text = describeBroadcast(pendingBroadcastSync(runtime.ctx))
      if (text) {
        result.broadcast = text
        result.warnings = [...(result.warnings ?? []), `${text}——这个任务只做收尾，别再开新活`]
      }
    } catch {
      // 广播读坏了不阻断
    }
    // 0.5.5 在场感知：开任务时记一笔，别的时空要重启就知道「有人开着活没收尾」，
    // 会自动等久一点（慢档 75 秒）。写不进去不阻断登记。
    try {
      markTaskOpen(runtime.ctx, {
        sessionId: runtime.sessionId,
        taskId: result.taskId,
        displayName: result.displayName ?? result.instance,
        project: result.project,
      })
    } catch {
      // 在场登记失败不影响任务本身
    }
  }
  return envelope(runtime, result ?? { ok: false, errorCode: 'E_IO' })
}

/**
 * 任务归档：双份交接 + 版本化 + 索引 + 审计。
 *
 * @param {object} runtime
 * @param {object} input
 */
export async function endTask(runtime, input) {
  if (runtime.degradedLevel !== 'normal') {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_DEGRADED_READONLY',
      message: '当前为降级只读，未执行归档',
    })
  }

  if (!runtime.currentTask) {
    return envelope(runtime, {
      ok: false,
      errorCode: 'E_NO_TASK',
      message: '当前没有进行中的任务（DSH 重启后任务上下文可能已丢失）：先 begin_task 再 end_task',
    })
  }

  const result = await endTaskCore({
    ctx: runtime.ctx,
    writer: runtime.writer,
    config: runtime.config,
    runtimeState: runtime.runtimeState,
    index: runtime.index,
    taskContext: runtime.currentTask,
    input: input ?? {},
    degradedLevel: runtime.degradedLevel,
  })

  if (result && !result.errorCode) {
    // 任务已归档：磁盘上不再挂「进行中」，内存里也不留，否则再调一次 end_task 会把同一个任务重复归档。
    runtime.currentTask = null
    try {
      runtime.runtimeState.currentTask = null
      await writeRuntimeState(runtime.ctx.runtimeStateFile, runtime.runtimeState)
    } catch {
      // 清盘失败不阻断归档
    }
  }
  return envelope(runtime, result ?? { ok: false, errorCode: 'E_IO' })
}

/**
 * 从来源路径猜实例名。
 * 版本备份形如 archive/versions/<实例>/<文件>.<n>，实例名在第 3 段；
 * 档内文件则是最后一段的文件名去掉交接后缀。
 *
 * @param {string} originalPath
 */
function instanceNameFromPath(originalPath) {
  const segments = toPosix(originalPath).split('/')
  if (segments[0] === 'archive' && segments[1] === 'versions' && segments.length >= 4) {
    return segments[2]
  }
  const base = segments[segments.length - 1] ?? ''
  return base.replace(/\.(machine|user)\.md(\.[0-9]+)?$/i, '').replace(/\.[0-9]+$/i, '')
}

/**
 * 从来源路径猜类型短名。只有 handoff/<typeSlug>/… 能直接读出来。
 * @param {string} originalPath
 */
function typeSlugFromPath(originalPath) {
  const segments = toPosix(originalPath).split('/')
  if (segments[0] === 'handoff' && segments.length >= 3) return segments[1]
  return 'restored'
}

/**
 * 找到来源对应的原索引条目（用来沿用 typeSlug / displayName / originalEntryId）。
 * @param {object} index
 * @param {string} originalPath
 */
function findOriginalEntry(index, originalPath) {
  const instance = instanceNameFromPath(originalPath)
  if (!instance) return null
  return index.entries.find((item) => item.kind === 'instance' && item.instance === instance) ?? null
}

/* ------------------------------------------------------------------ */
/* 跨会话联通：项目白板                                                */
/* ------------------------------------------------------------------ */

/**
 * 建或合并一个项目白板。存在就合并，不重复建。
 * @param {object} runtime
 * @param {object} input
 */
export async function projectUpsert(runtime, input) {
  const id = projectIdOf(input?.id)
  const sessionId = runtime.sessionId ?? '未知会话'
  const instance = runtime.currentTask?.instance ?? null

  let todo = null
  if (Array.isArray(input?.todo)) todo = input.todo.map((item) => String(item))
  else if (typeof input?.todo === 'string' && input.todo.trim()) {
    todo = input.todo.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  }

  const hasBaton =
    (typeof input?.to === 'string' && input.to.trim()) ||
    (typeof input?.action === 'string' && input.action.trim())

  // 0.3.27：白板也算数据，覆盖前留一版（放在 archive/versions/_data/ 下）
  {
    const rootDir = runtime.ctx.root || path.resolve(runtime.ctx.projectsDir, '..', '..')
    const versionsDir = runtime.ctx.versionsDir || path.join(rootDir, 'archive', 'versions')
    for (const rel of [`handoff/projects/${id}.md`, `handoff/projects/done/${id}.md`]) {
      await backupDataFile({
        sourcePath: path.join(rootDir, rel),
        versionsDir,
        key: rel.replace(/[\\/]/g, '__'),
      }).catch(() => {})
    }
  }
  const result = await upsertProject({
    projectsDir: runtime.ctx.projectsDir,
    id,
    title: input?.title,
    goal: input?.goal,
    status: input?.status,
    priority: input?.priority,
    baton: hasBaton ? { to: input?.to ?? 'any', action: input?.action ?? '' } : undefined,
    todo: todo ?? undefined,
    issue: typeof input?.issue === 'string' ? input.issue : undefined,
    resolveIssue: typeof input?.resolve_issue === 'string' ? input.resolve_issue : undefined,
    participant:
      typeof input?.participant === 'string' && input.participant.trim()
        ? input.participant.trim()
        : `${sessionId}${instance ? ` · ${instance}` : ''}`,
    role: input?.role,
    decision:
      typeof input?.decision === 'string' && input.decision.trim()
        ? { text: input.decision.trim(), reason: input?.decisionReason }
        : undefined,
  })

  const relativePath = result.archived
    ? `handoff/projects/done/${id}.md`
    : `handoff/projects/${id}.md`

  await runtime.writer.write({
    op: 'tools.project_upsert',
    target: relativePath,
    result: result.created ? 'created' : 'merged',
    sessionId,
  })

  // 项目常在变：优先级、当前一棒、归档；总目录跟着刷一版，别等人重启
  await updateHandoffReadme(runtime.ctx, runtime.index).catch(() => {})
  await updateProjectOverview(runtime.ctx, runtime.index).catch(() => {})

  return envelope(runtime, {
    id: result.model.id,
    title: result.model.title,
    status: result.model.status,
    priority: result.model.priority,
    archived: result.archived,
    baton: result.model.baton,
    created: result.created,
    path: relativePath,
    todoCount: result.model.todo.length,
  })
}

/**
 * 读一个项目白板。不存在返回 exists:false，不报错。
 * @param {object} runtime
 * @param {{id?: string}} input
 */
export async function projectRead(runtime, input) {
  const id = projectIdOf(input?.id)
  const { model, raw, exists, archived } = await readProject(runtime.ctx.projectsDir, id)
  return envelope(runtime, {
    id: model.id,
    exists,
    archived,
    priority: model.priority,
    structured: model,
    raw: raw.slice(0, runtime.config['tools.inspectMaxKB'] * 1024),
    truncated: raw.length > runtime.config['tools.inspectMaxKB'] * 1024,
  })
}

/**
 * 列出全部项目。
 * @param {object} runtime
 */
export async function projectList(runtime) {
  const items = await listProjects(runtime.ctx.projectsDir)
  return envelope(runtime, { items, total: items.length })
}

/* ------------------------------------------------------------------ */
/* 跨会话联通：请求信箱                                                */
/* ------------------------------------------------------------------ */

/**
 * 给某个会话（或所有人）留一条请求。
 * @param {object} runtime
 * @param {{to?: string, request?: string, project?: string}} input
 */
export async function inboxSend(runtime, input) {
  const sessionId = runtime.sessionId ?? '未知会话'
  const instance = runtime.currentTask?.instance ?? null
  const project = typeof input?.project === 'string' && input.project.trim() ? input.project.trim() : null
  if (project) projectIdOf(project)

  const item = await appendRequest({
    file: runtime.ctx.inboxFile,
    locksDir: runtime.ctx.locksDir,
    from: { sessionId, instance },
    to: typeof input?.to === 'string' && input.to.trim() ? input.to.trim() : BROADCAST,
    project,
    request: input?.request,
  })

  await runtime.writer.write({
    op: 'tools.inbox_send',
    target: `handoff/inbox.jsonl#${item.id}`,
    result: 'ok',
    sessionId,
  })

  return envelope(runtime, { item })
}

/**
 * 看信箱。`mine:true` 表示只看发给本会话（含广播）的。
 * @param {object} runtime
 * @param {{mine?: boolean, project?: string, status?: string, limit?: number}} input
 */
export async function inboxList(runtime, input) {
  const { items, malformed } = await readInbox(runtime.ctx.inboxFile)
  const limit = clampLimit(input?.limit, runtime.config['tools.listHandoffsDefaultLimit'], runtime.config['tools.listHandoffsMaxLimit'])
  const filtered = filterInbox(items, {
    mine: input?.mine ? runtime.sessionId ?? null : null,
    project: input?.project,
    // 不传就看还没处理的：关掉的请求不该继续占着信箱。
    status: input?.status ?? 'open',
  })
  return envelope(runtime, {
    items: filtered.slice(0, limit),
    total: filtered.length,
    limit,
    malformedLines: malformed,
    sessionId: runtime.sessionId ?? null,
  })
}

/**
 * 相关性路由（0.5.20）：按「这次要做什么」只给相关的文档与请求。
 *
 * 你 2026-11-06 22:13：通知堆在一起既费时间又拉低准确度——
 * 上传就只定位隐私手册，做插件就只定位《插件的自我管理》。这个工具就是那个「定位」。
 *
 * @param {object} runtime
 * @param {{task: string, project?: string, limit?: number}} input
 */
export async function focusContext(runtime, input) {
  const task = String(input?.task ?? '').trim()
  if (!task) return failure(runtime, pluginError('E_VALIDATION_BLOCKING', { field: 'task' }))
  const { items } = await readInbox(runtime.ctx.inboxFile)
  const open = filterInbox(items, { status: 'open' })
  const limit = clampLimit(input?.limit, 5, 20)
  const result = await routeFocus({
    root: runtime.ctx.root,
    task,
    project: input?.project ? String(input.project) : null,
    sessionId: runtime.sessionId ?? null,
    requests: open,
    limit,
  })
  await runtime.writer
    .write({ op: 'tools.focus_context', target: 'handoff/inbox.jsonl', result: 'ok', sessionId: runtime.sessionId })
    .catch(() => {})
  return envelope(runtime, result)
}

/**
 * 关掉一条请求。
 * @param {object} runtime
 * @param {{id?: string, resultRef?: string}} input
 */
export async function inboxClose(runtime, input) {
  const id = String(input?.id ?? '').trim()
  if (!id) throw pluginError('E_VALIDATION_BLOCKING', { field: 'id', reason: 'id 不能为空' })

  const { alreadyClosed } = await appendClose({
    file: runtime.ctx.inboxFile,
    locksDir: runtime.ctx.locksDir,
    id,
    resultRef: input?.resultRef,
  })

  await runtime.writer.write({
    op: 'tools.inbox_close',
    target: `handoff/inbox.jsonl#${id}`,
    result: alreadyClosed ? 'alreadyClosed' : 'ok',
    sessionId: runtime.sessionId,
  })

  return envelope(runtime, { id, alreadyClosed })
}



/**
 * 数据文件回滚（0.3.27）：把九档里的一个数据文件恢复到某个版本。
 * 备份来自 backupDataFile（archive/versions/_data/<key>/<stamp>.bak）。
 * 回滚前先把当前内容也备份一份，所以回滚本身也能再滚回去；
 * 回滚会留通知：logs/rollback.log + handoff/任务交接本/最近回滚.md。
 *
 * @param {object} runtime
 * @param {{ path: string, version?: string }} input
 */
export async function rollbackData(runtime, input) {
  const relPath = String(input?.path ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  const parts = relPath.split('/').filter(Boolean)
  const allowed = BUCKET_KEYS.includes(parts[0])
  if (!relPath || parts.length < 2 || !allowed || relPath.includes('..')) {
    return failure(runtime, pluginError('E_VALIDATION_BLOCKING', { field: 'path' }))
  }

  const rootDir = runtime.ctx.root || path.resolve(runtime.ctx.projectsDir, '..', '..')
  const target = path.join(rootDir, relPath)
  const versionsDir = runtime.ctx.versionsDir || path.join(rootDir, 'archive', 'versions')
  const key = relPath.replace(/[\\/]/g, '__')
  const versions = await listDataVersions({ versionsDir, key })
  if (versions.length === 0) {
    return failure(runtime, pluginError('E_NOT_FOUND', { target: relPath }))
  }

  const wanted = input?.version ? String(input.version) : versions[versions.length - 1].stamp
  const hit = versions.find((item) => item.stamp === wanted)
  if (!hit) {
    return failure(runtime, pluginError('E_NOT_FOUND', { target: `${relPath}@${wanted}` }))
  }

  const before = await backupDataFile({ sourcePath: target, versionsDir, key }).catch(() => null)
  await fsp.copyFile(hit.path, target)

  const at = new Date().toISOString()
  const notice = `- ${at} 回滚 ${relPath} 到 ${wanted}${before?.stamp ? `（回滚前已备份 ${before.stamp}）` : ''}`
  try {
    await fsp.appendFile(`${rootDir}/logs/rollback.log`, `${JSON.stringify({ at, path: relPath, version: wanted, beforeStamp: before?.stamp ?? null, sessionId: runtime.sessionId ?? null })}\n`, 'utf8')
    const noticePath = `${rootDir}/handoff/任务交接本/最近回滚.md`
    let old = ''
    try { old = await fsp.readFile(noticePath, 'utf8') } catch { old = '# 最近回滚\n\n' }
    await writeFileAtomic(noticePath, `${old.trimEnd()}\n${notice}\n`)
  } catch {
    // 通知写不进去不影响回滚本身，但审计里仍会留痕
  }

  await runtime.writer.write({
    op: 'tools.rollback_data',
    target: relPath,
    result: 'restored',
    sessionId: runtime.sessionId ?? null,
    note: `→ ${wanted}`,
  })

  return envelope(runtime, {
    ok: true,
    path: relPath,
    version: wanted,
    beforeStamp: before?.stamp ?? null,
    backups: versions.map((item) => item.stamp),
  })
}

// 器官系统 v0（0.4.0）：工具层只转发，实现在 lib/organs.js
export { organList, organCall } from './organs.js';
