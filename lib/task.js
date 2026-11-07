/**
 * 任务边界 —— 规格 §4.3 任务前、§4.5 任务后、§4.8 标识符、§5 交接文件。
 *
 * 宿主没有 task 概念，所以任务边界只由 dsh 显式调用 begin_task/end_task 建立（§4.8 允许）。
 * 插件**不从**自然语言、文件名或目录变化里推断任务边界。
 *
 * 这里有两个必须守死的点：
 *   1. 没 begin 就 end → 拒绝归档（不能凭空造一个任务的产物）；
 *   2. types[] 首次分配要原子写索引，且这是索引写入**唯一**允许阻断流程的地方。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { inspectArtifacts, summarizeArtifactHealth } from './artifacts.js'
import { BUCKET_KEYS, assertKnownBucket } from './buckets.js'
import { pluginError } from './errors.js'
import {
  MACHINE_SECTIONS,
  UPDATABLE_SECTIONS,
  renderMachine,
  renderUser,
  parseMachine,
  validateModel,
  handoffFileNames,
} from './handoff.js'
import { sha256 } from './hash.js'
import { findTypeByDisplayName, loadIndex, persistIndexStrict, saveIndex } from './index-store.js'
import { slugify, typeSlugFor } from './naming.js'
import { assertNotBucketRoot } from './paths.js'
import { ulid, generatedTaskId, isValidTaskId } from './ulid.js'
import { writeFileAtomic } from './atomic.js'
import { backupBeforeOverwrite, cleanupOldVersions } from './versions.js'
import { appendRecoveryRecord } from './recovery-log.js'
import { appendDirection } from './directions.js'
import { writeRuntimeState } from './runtime-state.js'
import { projectIdOf, upsertProject } from './projects.js'
import { appendRequest } from './inbox.js'
import { clearTaskOpen } from './presence.js'
import { updateHandoffReadme, updateProjectOverview } from './catalog.js'

/**
 * 计算幂等键（§4.8）。
 *
 * @param {object} params
 * @param {string} params.taskId
 * @param {'global'|'session'|'unknown'} params.taskIdScope
 * @param {string} params.sessionId
 * @param {string} params.sessionIdSource
 * @returns {{effectiveTaskKey: string|null, idempotency: 'strong'|'weak'|'unavailable'}}
 */
export function computeEffectiveTaskKey({ taskId, taskIdScope, sessionId, sessionIdSource }) {
  if (!taskId) return { effectiveTaskKey: null, idempotency: 'unavailable' }

  if (taskIdScope === 'global') {
    return { effectiveTaskKey: `g:${taskId}`, idempotency: 'strong' }
  }
  if (taskIdScope === 'session') {
    return { effectiveTaskKey: `s:${sha256(`${sessionId}\u0000${taskId}`)}`, idempotency: 'strong' }
  }
  // unknown 作用域本来就弱；generated 会话 ID 不得跨会话幂等（§4.8）
  return {
    effectiveTaskKey: `u:${sessionId}:${taskId}`,
    idempotency: sessionIdSource === 'generated' ? 'weak' : 'weak',
  }
}

/**
 * begin_task：定任务、定档、定类型、定实例名。
 *
 * @param {object} params
 * @param {import('./context.js').PluginContext} params.ctx
 * @param {import('./audit.js').AuditWriter} params.writer
 * @param {Record<string, any>} params.config
 * @param {import('./runtime-state.js').RuntimeState} params.runtimeState
 * @param {object} params.index
 * @param {string} params.sessionId
 * @param {'host'|'generated'} params.sessionIdSource
 * @param {object} params.input
 * @returns {Promise<object>}
 */
export async function beginTask({ ctx, writer, config, runtimeState, index, sessionId, sessionIdSource, input }) {
  const allowGenerated = config['task.allowGeneratedTaskId'] !== false
  const defaultScope = String(config['task.defaultTaskIdScope'] ?? 'unknown')

  let taskId = typeof input.taskId === 'string' ? input.taskId.trim() : ''
  let taskIdSource = 'host'
  if (taskId) {
    if (!isValidTaskId(taskId)) {
      throw pluginError('E_VALIDATION_BLOCKING', { field: 'taskId', reason: '格式不合法（允许 A-Za-z0-9._:-，1–128 字符）' })
    }
  } else {
    if (!allowGenerated) {
      throw pluginError('E_VALIDATION_BLOCKING', {
        field: 'taskId',
        reason: '任务 ID 缺失，且配置不允许自动生成',
      })
    }
    const seq = (runtimeState.autoTaskSeq ?? 0) + 1
    taskId = generatedTaskId(sessionId, seq)
    taskIdSource = 'generated'
    runtimeState.autoTaskSeq = seq
    // 序号要落盘，否则每次重启都从 1 开始，同一会话里会重号。
    try {
      await writeRuntimeState(ctx.runtimeStateFile, runtimeState)
    } catch {
      // 落盘失败最多让下次重号，不阻断本次任务（规格：runtime-state 写失败不阻断）
    }
  }

  const taskIdScope = ['global', 'session', 'unknown'].includes(input.taskIdScope)
    ? input.taskIdScope
    : (['global', 'session', 'unknown'].includes(defaultScope) ? defaultScope : 'unknown')

  const { effectiveTaskKey, idempotency } = computeEffectiveTaskKey({
    taskId,
    taskIdScope,
    sessionId,
    sessionIdSource,
  })

  // ── 定档 ──
  let bucket = typeof input.bucket === 'string' ? input.bucket.trim().toLowerCase() : ''
  if (bucket) {
    const verdict = assertKnownBucket(bucket)
    if (!verdict.ok) {
      throw pluginError('E_VALIDATION_BLOCKING', { field: 'bucket', reason: verdict.reason })
    }
  } else {
    // §4.7 最后一条：没有线索就停下问，禁止默认塞进 created
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'bucket',
      reason: `未指定档归属；请在 ${BUCKET_KEYS.join(' / ')} 中选一个`,
    })
  }

  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  const typeDisplayName = typeof input.typeDisplayName === 'string' && input.typeDisplayName.trim()
    ? input.typeDisplayName.trim()
    : (displayName || '未命名任务')

  // ── 定类型（types[] 首次分配必须原子写索引，唯一阻断例外）──
  const { typeSlug, created: typeCreated } = await ensureType({
    ctx,
    index,
    typeDisplayName,
    originTaskId: taskId,
  })

  // ── 定实例名 ──
  const instance = await ensureInstanceName({
    index,
    typeSlug,
    requested: typeof input.instance === 'string' ? input.instance : displayName,
    displayName,
  })

  // ── 关联项目白板（可选，跨会话联通）──
  // 只校验格式，不在这里建文件：白板由 project_upsert 建，任务不该有副作用之外的写。
  let project = null
  if (typeof input.project === 'string' && input.project.trim()) {
    project = projectIdOf(input.project.trim())
  }

  const record = {
    taskId,
    taskIdSource,
    taskIdScope,
    effectiveTaskKey,
    idempotency,
    bucket,
    typeSlug,
    typeDisplayName,
    instance,
    displayName: displayName || instance,
    purpose: typeof input.purpose === 'string' ? input.purpose.trim() : '',
    project,
    startedAt: new Date().toISOString(),
    sessionId,
  }

  await writer.write({
    op: 'tools.begin_task',
    target: `handoff/${instance}`,
    result: idempotency === 'weak' ? 'warn' : 'ok',
    sessionId,
    taskId,
    taskIdScope,
    taskIdSource,
    effectiveTaskKey,
    idempotency,
    note: typeCreated ? '新建类型短名' : null,
  })

  return {
    ...record,
    typeCreated,
    notes: idempotency === 'weak' ? '幂等性弱：任务 ID 为自动生成，结束时请补录真实 ID' : null,
  }
}

/**
 * 确保 types[] 里有这个类型。首次分配走 persistIndexStrict（失败必须阻断）。
 *
 * @param {object} params
 * @param {import('./context.js').PluginContext} params.ctx
 * @param {object} params.index
 * @param {string} params.typeDisplayName
 * @param {string} params.originTaskId
 */
export async function ensureType({ ctx, index, typeDisplayName, originTaskId }) {
  const existing = findTypeByDisplayName(index, typeDisplayName)
  if (existing) return { typeSlug: existing.typeSlug, created: false }

  const usedSlugs = index.types.map((t) => t.typeSlug)
  const generated = typeSlugFor(typeDisplayName, index.types, usedSlugs)

  index.types.push({
    typeDisplayName,
    typeSlug: generated.typeSlug,
    status: 'unregistered',
    createdAt: new Date().toISOString(),
    originTaskId: originTaskId ?? null,
    notes: '首次分配，状态未注册，待用户确认是否补录',
  })

  // 规格 §3.4：写失败 → 不继续建目录，告警重试
  await persistIndexStrict(ctx, index)

  return { typeSlug: generated.typeSlug, created: true }
}

/**
 * 实例名：同类型同显示名复用已有实例，否则生成新物理名。
 *
 * @param {object} params
 * @param {object} params.index
 * @param {string} params.typeSlug
 * @param {string} params.requested
 * @param {string} params.displayName
 */
export async function ensureInstanceName({ index, typeSlug, requested, displayName }) {
  const existingEntry = index.entries.find(
    (entry) =>
      entry.kind === 'instance' &&
      entry.typeSlug === typeSlug &&
      entry.status !== 'lost' &&
      (entry.displayName === displayName || entry.instance === requested),
  )
  if (existingEntry) return existingEntry.instance

  const used = index.entries
    .filter((entry) => entry.typeSlug === typeSlug && entry.instance)
    .map((entry) => entry.instance)

  let base = slugify(requested || displayName || 'untitled')
  if (!base) base = 'untitled'
  if (!used.includes(base)) return base

  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!used.includes(candidate)) return candidate
  }
  throw pluginError('E_LIMIT_EXCEEDED', { limit: '同名实例编号', target: base })
}

/**
 * 0.5.18：`next` 以前只认 `[{ to, request }]`，调用方给字符串（或把数组序列化成 JSON 字符串）
 * 时会被静默丢掉——2026-11-06 的账就是「next 字段没渲染，两份交接都丢了」。
 * 现在四种写法都收：①对象数组 ②字符串数组 ③单个对象/字符串 ④JSON 字符串。
 * 收不下的条目要报警告，不能再静默。
 *
 * @param {unknown} raw
 * @returns {{ items: string[], warnings: string[] }}
 */
function normalizeNext(raw) {
  const warnings = []
  let list = raw
  if (typeof list === 'string') {
    const text = list.trim()
    if (!text) return { items: [], warnings }
    try {
      list = JSON.parse(text)
    } catch {
      // 一行一段的纯文本也认：按换行/分号拆
      const parts = text.split(/\r?\n|；|;/).map((s) => s.trim()).filter(Boolean)
      if (parts.length > 0) warnings.push(`next 收到的是字符串，已按换行/分号拆成 ${parts.length} 条`)
      list = parts
    }
  }
  if (list && !Array.isArray(list) && typeof list === 'object') list = [list]
  if (!Array.isArray(list)) {
    if (raw !== undefined && raw !== null) warnings.push('next 既不是数组也不是字符串，已忽略')
    return { items: [], warnings }
  }
  const items = []
  for (const item of list) {
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) items.push(text)
      continue
    }
    const request = typeof item?.request === 'string' ? item.request.trim()
      : typeof item?.task === 'string' ? item.task.trim()
        : typeof item?.text === 'string' ? item.text.trim()
          : ''
    if (!request) {
      warnings.push('next 里有一条既没有 request 也没有文字，已跳过')
      continue
    }
    const toRef = typeof item?.to === 'string' && item.to.trim() ? item.to.trim() : 'any'
    items.push(`${request}（交给 ${toRef}）`)
  }
  return { items, warnings }
}

/**
 * end_task：核验产物 → 版本化 → 写双份交接 → 索引 → README → 审计 → 方向记录。
 *
 * @param {object} params
 * @param {import('./context.js').PluginContext} params.ctx
 * @param {import('./audit.js').AuditWriter} params.writer
 * @param {Record<string, any>} params.config
 * @param {import('./runtime-state.js').RuntimeState} params.runtimeState
 * @param {object} params.index
 * @param {object} params.taskContext  begin_task 的结果
 * @param {object} params.input
 * @param {'normal'|'L1'|'L2'} params.degradedLevel
 * @returns {Promise<object>}
 */
export async function endTask({ ctx, writer, config, runtimeState, index, taskContext, input, degradedLevel }) {
  if (degradedLevel !== 'normal') {
    // L1/L2 禁业务写；L1 允许留一条 task_unclosed
    return {
      ok: false,
      errorCode: 'E_DEGRADED_READONLY',
      degradedLevel,
      message: '当前为降级只读，归档未执行',
    }
  }

  const status = ['done', 'partial', 'aborted'].includes(input.status) ? input.status : 'done'
  const artifactsInput = Array.isArray(input.artifacts) ? input.artifacts : []

  // ── 1. 产物清单 ──
  const specPaths = artifactsInput
    .map((item) => (typeof item === 'string' ? item : item?.path))
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())

  const rows = await inspectArtifacts({ root: ctx.root, specPaths, config })
  const health = summarizeArtifactHealth(rows, config['handoff.artifactHashFailWarnRatio'])
  if (health.missing > 0) {
    await writer.write({
      op: 'handoff.artifactMissing',
      target: `handoff/${MACHINE_DIR}/${dayKeyOf(new Date())}/${taskContext.instance}.machine.md`,
      result: 'warn',
      note: `${health.missing} 项产物不存在`,
      sessionId: runtimeState.sessionId,
    })
  }

  // ── 2. 定双份交接的位置 ──
  // 主人 2026-10-31 裁决：handoff 根下分 machine / user 两个文件夹，
  // 每个文件夹里再按日期(YYYY-MM-DD)分目录，避免根目录堆满文件。
  // 这是对规格 §5.1 的偏离，只影响位置；双份同源、固定名、版本化都不变。
  const nowDate = new Date()
  const dayKey = dayKeyOf(nowDate)
  const machineDirAbs = path.join(ctx.root, 'handoff', MACHINE_DIR, dayKey)
  const userDirAbs = path.join(ctx.root, 'handoff', USER_DIR, dayKey)
  assertNotBucketRoot(ctx.root, machineDirAbs, '创建机器版目录')
  assertNotBucketRoot(ctx.root, userDirAbs, '创建用户版目录')
  await fsp.mkdir(machineDirAbs, { recursive: true })
  await fsp.mkdir(userDirAbs, { recursive: true })

  const names = handoffFileNames(taskContext.instance, {
    displayName: taskContext.displayName,
    at: nowDate,
  })
  const machineAbs = path.join(machineDirAbs, names.machine)
  const userAbs = path.join(userDirAbs, names.user)

  // ── 3. 组装模型 ──
  const now = nowDate.toISOString()
  // 跨天更新时当天还没有文件，往前捞最近一份，否则 createdAt 会丢
  const previous = (await readExistingMachine(machineAbs)) ?? (await readLatestMachine(ctx, taskContext.instance))
  // 0.4.5：交接必须写清「属于哪个项目、交给谁」——项目通常来自 begin_task 的 project，
  // 交给谁不填就写 any（接棒时空），这样新时空能按项目找到自己的那一份。
  const projectRef = pickText(input.project) ?? taskContext.project ?? null
  const toRef = pickText(input.to) ?? null
  const identity = {
    typeDisplayName: taskContext.typeDisplayName,
    typeSlug: taskContext.typeSlug,
    instance: taskContext.instance,
    displayName: taskContext.displayName,
    project: projectRef,
    to: toRef,
    createdAt: previous?.structured?.identity?.createdAt ?? now,
    updatedAt: now,
    taskId: taskContext.taskId,
    effectiveTaskKey: taskContext.effectiveTaskKey,
    taskIdScope: taskContext.taskIdScope,
    sessionId: runtimeState.sessionId,
    source: 'dsh',
    status: health.degraded ? 'degraded' : 'normal',
  }

  // 0.5.18：next 先规整再进模型，避免「给了但被静默丢掉」
  const nextNormalized = normalizeNext(input.next)

  const model = {
    identity,
    artifacts: rows,
    progress: {
      goal: pickText(input.goal) ?? previous?.structured?.progress?.goal ?? taskContext.purpose ?? '未填写',
      done: pickList(input.done) ?? previous?.structured?.progress?.done ?? [],
      blocked: pickList(input.blocked) ?? previous?.structured?.progress?.blocked ?? [],
      lastStop: pickText(input.lastStop) ?? null,
    },
    direction: {
      direction: pickText(input.direction) ?? previous?.structured?.direction?.direction ?? '未填写',
      directionId: null,
      previousDirectionId: null,
      relation: 'origin',
      reason: pickText(input.directionReason) ?? '未填写',
      userVerdict: null,           // dsh 不得代填
      verdictRef: null,
    },
    facts: {
      confirmed: pickConfirmed(input.facts) ?? previous?.structured?.facts?.confirmed?.map((text) => ({ text, source: '' })) ?? [],
      assumptions: pickList(input.assumptions) ?? previous?.structured?.facts?.assumptions ?? [],
    },
    suggestions: {
      readFirst: pickList(input.readFirst) ?? [],
      avoid: pickList(input.avoid) ?? [],
      // 0.5.4：`next` 原来只发到信箱/白板，交接正文里看不到（新时空读完交接不知道下一步该谁干）。
      // 0.5.18：改由 normalizeNext() 规整——字符串/JSON 字符串/对象数组都收，丢了会报警告，不再静默。
      next: nextNormalized.items,
    },
  }

  validateModel(model)

  // ── 4. 方向记录（先落 directions.jsonl，交接第 4 节只写引用）──
  let directionRecord = null
  /** @type {string[]} */ const warnings = []
  // 0.5.18：next 规整过程中丢掉的东西要说出来，不能静默
  if (nextNormalized.warnings.length > 0) warnings.push(...nextNormalized.warnings)
  try {
    const directionResult = await appendDirection({
      file: ctx.directionsFile,
      sessionId: runtimeState.sessionId,
      taskId: taskContext.taskId,
      effectiveTaskKey: taskContext.effectiveTaskKey,
      bucket: taskContext.bucket,
      typeSlug: taskContext.typeSlug,
      instance: taskContext.instance,
      direction: model.direction.direction,
      relationToPrevious: 'origin',
      reason: model.direction.reason,
      decidedBy: 'dsh_inferred',
      userVerdict: 'not_applicable',
      verdictQuote: null,
      limits: {
        maxLineKB: Number(config['direction.maxLineKB']),
        quoteMaxChars: Number(config['direction.quoteMaxChars']),
      },
      note: 'end_task 归档时自动记录',
    })
    directionRecord = directionResult.record
    warnings.push(...(directionResult.warnings ?? []))
    model.direction.directionId = directionRecord.directionId
    model.direction.previousDirectionId = directionRecord.previousDirectionId ?? null
    model.direction.relation = directionRecord.relationToPrevious
  } catch (error) {
    warnings.push(`方向记录写入失败：${error?.code ?? '未知错误'}`)
    await writer.write({
      op: 'direction.appendFailed',
      target: 'handoff/directions.jsonl',
      result: 'fail',
      error: { code: error?.code ?? 'E_IO', message: String(error?.message ?? '') },
      sessionId: runtimeState.sessionId,
    })
  }

  const machineText = renderMachine(model)
  const userText = renderUser(model)

  // ── 5. 备份旧版（哈希去重）──
  const machineBackup = await backupBeforeOverwrite({
    sourcePath: machineAbs,
    versionsDir: path.join(ctx.versionsDir, taskContext.instance),
    baseName: names.machine,
  })
  if (machineBackup.status === 'skipped') {
    await writer.write({ op: 'versions.duplicateSkipped', target: names.machine, result: 'ok' })
  }
  const userBackup = await backupBeforeOverwrite({
    sourcePath: userAbs,
    versionsDir: path.join(ctx.versionsDir, taskContext.instance),
    baseName: names.user,
  })
  if (userBackup.status === 'skipped') {
    await writer.write({ op: 'versions.duplicateSkipped', target: names.user, result: 'ok' })
  }

  // ── 6. 原子写双份 ──
  try {
    await writeFileAtomic(machineAbs, `${machineText}\n`)
  } catch (error) {
    throw pluginError('E_RENAME_FAILED', {
      target: `handoff/${MACHINE_DIR}/${dayKey}/${names.machine}`,
      reason: error?.code ?? '写入失败',
    })
  }
  try {
    await writeFileAtomic(userAbs, `${userText}\n`)
  } catch (error) {
    // user 版写失败不撤 machine 版（两份同源，下次重写会补齐）
    warnings.push(`用户版交接写入失败：${error?.code ?? '未知错误'}`)
  }

  // ── 7. K 版清理（按文件独立计数；失败不阻断：交接已经写好，下次归档还能再清）──
  const cleanupStamp = timestampForDir(new Date())
  for (const baseName of [names.machine, names.user]) {
    try {
      const cleanup = await cleanupOldVersions({
        versionsDir: path.join(ctx.versionsDir, taskContext.instance),
        baseName,
        keepK: Number(config['archive.keepVersionsK']),
        trashRoot: ctx.trashDir,
        timestamp: () => cleanupStamp,
        recordTrash: async (entry) => {
          await appendRecoveryRecord({
            file: ctx.recoveryLogFile,
            event: 'trash',
            originalPath: entry.originalPath,
            physicalPath: entry.physicalPath,
            source: 'versions_cleanup',
            size: entry.size,
            hash: entry.hash ?? null,
            reason: entry.reason,
            sessionId: runtimeState.sessionId,
            taskId: taskContext.taskId,
            result: 'committed',
          })
        },
      })
      if (cleanup.failed.length > 0) {
        warnings.push(`版本清理失败：${baseName} 有 ${cleanup.failed.length} 项没移走`)
        await writer.write({ op: 'versions.cleanupFailed', target: `${taskContext.instance}/${baseName}`, result: 'fail' })
      }
    } catch (error) {
      warnings.push(`版本清理失败：${error?.code ?? '未知错误'}`)
      await writer.write({ op: 'versions.cleanupFailed', target: `${taskContext.instance}/${baseName}`, result: 'fail' })
    }
  }

  // ── 8. 索引 ──
  // 写之前先在盘上重读一次：索引可能在本次会话运行期间被别的会话/工具改过，
  // 直接用启动时载入的内存快照会把那些改动冲掉（2026-11-01 记下的第②个短板）。
  try {
    const reloaded = await loadIndex(ctx.indexFile)
    const fresh = reloaded?.index
    if (fresh && Array.isArray(fresh.entries) && Array.isArray(fresh.types)) {
      index.entries = fresh.entries
      index.types = fresh.types
      if (fresh.selfState) index.selfState = fresh.selfState
      if (fresh.schemaVersion) index.schemaVersion = fresh.schemaVersion
    }
  } catch {
    // 读不到就沿用内存里的索引，归档不能因此失败
  }
  const contentHash = sha256(machineText)
  const relativeMachine = `handoff/${MACHINE_DIR}/${dayKey}/${names.machine}`
  const relativeUser = `handoff/${USER_DIR}/${dayKey}/${names.user}`
  const { entry } = upsertInstanceForTask(index, {
    bucket: taskContext.bucket,
    typeSlug: taskContext.typeSlug,
    instance: taskContext.instance,
    displayName: taskContext.displayName,
    purpose: taskContext.purpose,
    project: projectRef,
    to: toRef,
    machineHandoff: relativeMachine,
    userHandoff: relativeUser,
    lastUpdated: now,
    contentHash,
    taskId: taskContext.taskId,
    effectiveTaskKey: taskContext.effectiveTaskKey,
    taskIdScope: taskContext.taskIdScope,
    taskIdSource: taskContext.taskIdSource,
    sessionId: runtimeState.sessionId,
    idempotency: taskContext.idempotency,
    direction: directionRecord,
    status: status === 'done' ? 'done' : status === 'aborted' ? 'abandoned' : 'active',
  })
  try {
    await saveIndex(ctx.indexFile, index)
  } catch {
    warnings.push('索引写入失败（不影响本次归档）')
  }

  // ── 8.5 自评落盘（0.4.7）──
  // 账本（A:\tools\ledger）算 A 时要「返工几次 / 引对几条」，这些只有干活的时空自己知道。
  // 插件不直接写 records.jsonl（账本规范：写入统一走 record.mjs），只把自评落到
  // logs/账本/data/self-reports.jsonl，由账本进程下一次采样时配成 strong 样本。
  // 没给自评就不写——不拿默认值冒充事实（weak 自动样本仍然是 1 次过）。
  const selfAttempts = positiveIntOrNull(input.attempts)
  const selfCited = nonNegativeIntOrNull(input.factsCited)
  const selfWrong = nonNegativeIntOrNull(input.factsWrong)
  let selfReported = false
  if (selfAttempts !== null || selfCited !== null || selfWrong !== null) {
    try {
      const ledgerDataDir = path.join(ctx.root, 'logs', '账本', 'data')
      await fsp.mkdir(ledgerDataDir, { recursive: true })
      const selfReport = {
        at: now,
        entryId: entry.entryId,
        instance: taskContext.instance,
        displayName: taskContext.displayName,
        project: projectRef,
        status,
        taskId: taskContext.taskId,
        passed: status === 'done',
        attempts: selfAttempts,
        factsCited: selfCited,
        factsWrong: selfWrong,
        sessionId: runtimeState.sessionId,
      }
      await fsp.appendFile(path.join(ledgerDataDir, 'self-reports.jsonl'), `${JSON.stringify(selfReport)}\n`, 'utf8')
      selfReported = true
    } catch (error) {
      warnings.push(`自评写入失败：${error?.code ?? '未知错误'}`)
    }
  }

  // ── 8.6 verify: 行扫描 + 送护城河裁决（0.4.9）──
  // 规范：handoff/手册/自校验回路.md。分工：书同文把交接里的「可核验断言」翻译成 claims，
  // 护城河 `A:\safeprotocol\bin\verify.mjs` 拿现实去验。0.4.9 起会把裁决也记下来
  // （logs/verify-verdicts.jsonl），deny 时给一条警告——但**不阻断归档**：
  // 规范 §九 要求先只扫一周，格式稳了、误报降下来，再谈「不一致就打回」。
  // 0.5.16（断言契约）：一条 verify 断言要带「谁派的（by）」和「什么时候停」
  // （until / maxRounds / stopOnPass 三选一），收件人默认 = by，可用 to 改写。
  // 写法两种：第一行之后缩进写子字段，或行尾写 by=xxx maxRounds=3（cmd 类型不吃行尾，
  // 命令里本来就可能出现等号）。缺了不拦归档，只在 warnings 里记一句——先记后拦。
  const VERIFY_TYPES = new Set(['file-exists', 'file-hash', 'cmd', 'port', 'json-field', 'http', 'proc'])
  const VERIFY_FIELDS = ['by', 'until', 'maxRounds', 'stopOnPass', 'to']
  const TERMINAL_FIELDS = ['until', 'maxRounds', 'stopOnPass']
  const verifyClaims = []
  const machineLines = machineText.split(/\r?\n/)
  for (let i = 0; i < machineLines.length; i += 1) {
    const line = machineLines[i]
    // 允许列表项前缀（正文里多半长成「- verify: ...」），也允许裸行。
    const m = line.match(/^\s*(?:[-*]\s*)?verify\s*[:：]\s*(.+?)\s*$/)
    if (!m) continue
    let body = m[1]
    const sp = body.indexOf(' ')
    let type = sp === -1 ? body : body.slice(0, sp)
    let target = sp === -1 ? '' : body.slice(sp + 1).trim()
    const fields = {}
    // 行尾字段两种写法都认：`by=tongwen/x` 或 `by: tongwen/x`
    // （交接正文里「已完成」条目会被压成一行，缩进换行在纸上就没了，所以空格分隔的 key: value 也得认）
    // cmd 不动：命令里本来就可能带等号和冒号。
    if (type !== 'cmd') {
      const tokens = target.split(/\s+/).filter(Boolean)
      const keep = []
      for (let t = 0; t < tokens.length; t += 1) {
        const token = tokens[t]
        const eq = token.match(/^(by|until|maxRounds|stopOnPass|to)=(.+)$/)
        if (eq) {
          fields[eq[1]] = eq[2].trim()
          continue
        }
        const colon = token.match(/^(by|until|maxRounds|stopOnPass|to)[:：]$/)
        if (colon && tokens[t + 1] && !/^(by|until|maxRounds|stopOnPass|to)[=:：]/.test(tokens[t + 1])) {
          fields[colon[1]] = tokens[t + 1].trim()
          t += 1
          continue
        }
        keep.push(token)
      }
      target = keep.join(' ')
    }
    // 下一行起、缩进着的子字段
    while (i + 1 < machineLines.length) {
      const sub = machineLines[i + 1].match(/^\s+(by|until|maxRounds|stopOnPass|to)\s*[:：]\s*(.+?)\s*$/)
      if (!sub) break
      fields[sub[1]] = sub[2].trim()
      i += 1
    }
    const by = String(fields.by ?? '').trim()
    const to = String(fields.to ?? '').trim() || by || null
    const terminal = TERMINAL_FIELDS.filter((key) => String(fields[key] ?? '').trim() !== '')
    const maxRoundsRaw = String(fields.maxRounds ?? '').trim()
    const stopOnPassRaw = String(fields.stopOnPass ?? '').trim()
    verifyClaims.push({
      raw: line.trim(),
      type,
      target,
      parsed: VERIFY_TYPES.has(type) && target.length > 0,
      by: by || null,
      to,
      until: String(fields.until ?? '').trim() || null,
      maxRounds: /^\d+$/.test(maxRoundsRaw) ? Number(maxRoundsRaw) : null,
      stopOnPass: /^(1|true|yes|是|开|停)$/i.test(stopOnPassRaw) || null,
      bounded: terminal.length > 0,
      // complete｜missing-by｜missing-terminal｜missing-both
      contract: by && terminal.length > 0 ? 'complete' : by ? 'missing-terminal' : terminal.length > 0 ? 'missing-by' : 'missing-both',
    })
  }
  const unboundedClaims = verifyClaims.filter((claim) => claim.contract !== 'complete')
  if (unboundedClaims.length > 0) {
    const missingBy = unboundedClaims.filter((c) => !c.by).length
    const missingStop = unboundedClaims.filter((c) => !c.bounded).length
    const shape = [missingBy ? `缺 by ${missingBy} 条` : '', missingStop ? `缺终止条件 ${missingStop} 条` : '']
      .filter(Boolean)
      .join('、')
    warnings.push(
      `verify: ${unboundedClaims.length} 条断言没写清「谁派的、什么时候停」（${shape}）——见 handoff/手册/断言契约.md；本轮只记不拦`,
    )
  }
  let verifyVerdict = null
  if (verifyClaims.length > 0) {
    try {
      const scanFile = path.join(ctx.root, 'logs', 'verify-scanned.jsonl')
      await fsp.mkdir(path.dirname(scanFile), { recursive: true })
      for (const claim of verifyClaims) {
        await fsp.appendFile(
          scanFile,
          `${JSON.stringify({
            at: now,
            entryId: entry.entryId,
            machineHandoff: relativeMachine,
            project: projectRef,
            ...claim,
          })}\n`,
          'utf8',
        )
      }
    } catch (error) {
      warnings.push(`verify: 行登记失败：${error?.code ?? '未知错误'}`)
    }

    const parsedClaims = verifyClaims.filter((claim) => claim.parsed)
    const verifyScript = process.env.TONGWEN_VERIFY_SCRIPT || 'A:\\safeprotocol\\bin\\verify.mjs'
    if (parsedClaims.length > 0 && !existsSync(verifyScript)) {
      warnings.push('verify 执行器不在（护城河还没装？）：断言只记录，没有裁决')
    } else if (parsedClaims.length > 0) {
      // 一条断言 → 一个 check；相对路径一律相对交接根目录解释。
      // 断言里没写 by 的，用「这次归档」兜底（谁在派的单），并默认 stopOnPass：
      // 我们一次归档只验一轮，不会循环派单。
      const defaultBy = `tongwen/end_task:${entry.entryId ?? entry.taskId ?? 'unknown'}`
      const checks = parsedClaims.map((claim) => {
        const abs = path.isAbsolute(claim.target) ? claim.target : path.join(ctx.root, claim.target)
        const owner = {
          by: claim.by || defaultBy,
          to: claim.to || claim.by || defaultBy,
          until: claim.until,
          maxRounds: claim.maxRounds,
          stopOnPass: claim.stopOnPass ?? true,
        }
        if (claim.type === 'file-exists') return { claim: claim.raw, ...owner, check: { kind: 'file-exists', path: abs } }
        if (claim.type === 'file-hash') return { claim: claim.raw, ...owner, check: { kind: 'file-hash', path: abs } }
        if (claim.type === 'cmd') return { claim: claim.raw, ...owner, check: { kind: 'cmd', command: claim.target, expectExit: 0 } }
        if (claim.type === 'port') return { claim: claim.raw, ...owner, check: { kind: 'port', port: Number(claim.target) } }
        return { claim: claim.raw, ...owner, check: { kind: claim.type, target: abs } }
      })
      // 断言契约（0.5.17）：护城河侧 verify.mjs（2026-11-06 08:41 起）在**顶层**读 by 与
      // 终止条件（until / maxRounds / stopOnPass），缺一个就整单拒收（exit 1，一条都不跑）。
      // 所以这里显式在顶层给：by 用这次归档兜底，终止条件从断言里透传，没有就默认
      // stopOnPass（我们一次归档只验一轮，不会循环派单）。
      const firstUntil = checks.find((item) => item.until)?.until
      const firstMaxRounds = checks.find((item) => item.maxRounds !== null && item.maxRounds !== undefined)?.maxRounds
      const payload = {
        taskId: entry.taskId ?? entry.entryId,
        by: defaultBy,
        dispatcher: defaultBy,
        ...(firstUntil ? { until: firstUntil } : {}),
        ...(firstMaxRounds !== undefined ? { maxRounds: firstMaxRounds } : {}),
        ...(firstUntil || firstMaxRounds !== undefined ? {} : { stopOnPass: true }),
        // 断言契约（0.5.16）：让护城河侧知道这一轮有几条没写清「谁派的、什么时候停」
        contract: {
          complete: verifyClaims.filter((claim) => claim.contract === 'complete').length,
          unbounded: unboundedClaims.length,
        },
        claims: checks,
      }
      const startedAt = Date.now()
      const run = spawnSync(process.execPath, [verifyScript, '--stdin'], {
        // 断言契约（0.5.16）：护城河的记录里 y 取的是这个环境变量，不给就永远是 unknown。
        env: { ...process.env, VERIFY_BY: defaultBy },
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      })
      const elapsed = Date.now() - startedAt
      let judged = null
      try {
        judged = JSON.parse(String(run.stdout || '').trim())
      } catch {
        judged = null
      }
      if (judged && (judged.verdict === 'allow' || judged.verdict === 'deny')) {
        verifyVerdict = {
          verdict: judged.verdict,
          // 回执带派单方：护城河认下来的是哪个 by（她不认时回 unknown）
          by: judged.by ?? defaultBy,
          total: checks.length,
          failed: (judged.results ?? []).filter((item) => !item.ok).length,
          summary: judged.summary ?? '',
          round: judged.round ?? 1,
          ms: elapsed,
        }
        try {
          const verdictFile = path.join(ctx.root, 'logs', 'verify-verdicts.jsonl')
          await fsp.appendFile(
            verdictFile,
            `${JSON.stringify({ at: now, entryId: entry.entryId, taskId: payload.taskId, ...verifyVerdict })}\n`,
            'utf8',
          )
        } catch (error) {
          warnings.push(`verify 裁决登记失败：${error?.code ?? '未知错误'}`)
        }
        if (verifyVerdict.verdict === 'deny') {
          warnings.push(`verify 不一致（${verifyVerdict.failed}/${verifyVerdict.total} 条）：${verifyVerdict.summary}`)
        }
      } else {
        const why = String(run.stderr || '').trim().slice(0, 160) || '无输出'
        warnings.push(`verify 执行器没给裁决（exit=${run.status ?? '?'}）：${why}`)
      }
    }
  }

  // ── 9. README ──
  try {
    await updateHandoffReadme(ctx, index)
  } catch {
    warnings.push('handoff/README.md 更新失败')
  }

  // ── 9.1 项目总览 ──
  // 0.3.23：每次归档后立刻重算「项目总览」，白板不再等下次启动或下次 project_upsert 才刷新。
  try {
    await updateProjectOverview(ctx, index)
  } catch {
    warnings.push('handoff/项目总览.md 更新失败')
  }

  // ── 9.5 跨会话：给项目白板排下一棒、给会话留请求 ──
  const nextIds = []
  const nextInput = Array.isArray(input.next) ? input.next : []
  if (nextInput.length > 0 || taskContext.project) {
    try {
      let lastBaton = null
      for (const item of nextInput) {
        const request = typeof item?.request === 'string' ? item.request.trim() : ''
        if (!request) continue
        const to = typeof item?.to === 'string' && item.to.trim() ? item.to.trim() : 'any'
        const projectRef = pickText(item?.project) ?? taskContext.project ?? null
        const sent = await appendRequest({
          file: ctx.inboxFile,
          locksDir: ctx.locksDir,
          from: { sessionId: runtimeState.sessionId, instance: taskContext.instance },
          to,
          project: projectRef,
          request,
        })
        nextIds.push(sent.id)
        lastBaton = { to, action: request }
      }
      if (taskContext.project) {
        await upsertProject({
          projectsDir: ctx.projectsDir,
          id: taskContext.project,
          participant: `${runtimeState.sessionId} · ${taskContext.instance}`,
          baton: lastBaton ?? undefined,
          decision: {
            text: `完成「${taskContext.displayName}」（${status}），交接在 ${relativeMachine}`,
            reason: status === 'done' ? null : status,
          },
          status: status === 'aborted' ? 'paused' : undefined,
        })
      }
    } catch (error) {
      // 跨会话记录失败不阻断归档：交接已经写好了，这才是主产物。
      warnings.push(`跨会话记录失败：${String(error?.message ?? error)}`)
    }
  }

  // ── 9.8 在场登记收尾（0.5.5）：这个时空的活干完了，别的时空要重启就不用再等它 ──
  try {
    clearTaskOpen(ctx, runtimeState.sessionId)
  } catch {
    // 划不掉不影响归档
  }

  // ── 10. 审计 ──
  await writer.write({
    op: 'tools.end_task',
    target: relativeMachine,
    result: health.degraded ? 'warn' : (warnings.length > 0 ? 'warn' : 'ok'),
    beforeHash: previous?.hash ?? null,
    afterHash: contentHash,
    sessionId: runtimeState.sessionId,
    taskId: taskContext.taskId,
    taskIdScope: taskContext.taskIdScope,
    taskIdSource: taskContext.taskIdSource,
    effectiveTaskKey: taskContext.effectiveTaskKey,
    idempotency: taskContext.idempotency,
  })

  return {
    ok: true,
    entryId: entry.entryId,
    archived: true,
    status,
    typeSlug: taskContext.typeSlug,
    instance: taskContext.instance,
    machineHandoff: relativeMachine,
    userHandoff: relativeUser,
    artifacts: rows.map((row) => ({
      path: row.path,
      type: row.type,
      exists: row.exists,
      size: row.size,
      sha256: row.sha256,
      hashStatus: row.hashStatus,
      ...(row.note ? { note: row.note } : {}),
    })),
    artifactHealth: health,
    directionId: directionRecord?.directionId ?? null,
    version: {
      machine: machineBackup.status === 'backed-up' ? machineBackup.versionNumber : null,
      user: userBackup.status === 'backed-up' ? userBackup.versionNumber : null,
      // null 不是坏了：第一次写这两份交接时没有旧版可备份，版本号自然还不存在。
      note: machineBackup.status === 'no-source' && userBackup.status === 'no-source'
        ? '首次写入，还没有旧版需要备份；以后覆盖时会自动版本化（archive/versions）'
        : null,
    },
    warnings,
    degradedHandoff: health.degraded,
    ...(selfReported
      ? { ledgerSelfReport: { attempts: selfAttempts, factsCited: selfCited, factsWrong: selfWrong } }
      : {}),
    ...(verifyClaims.length > 0
      ? {
          verifyClaims: verifyClaims.map((claim) => ({
            type: claim.type,
            target: claim.target,
            parsed: claim.parsed,
            by: claim.by,
            to: claim.to,
            until: claim.until,
            maxRounds: claim.maxRounds,
            stopOnPass: claim.stopOnPass,
            bounded: claim.bounded,
            contract: claim.contract,
          })),
        }
      : {}),
    ...(verifyVerdict ? { verifyVerdict } : {}),
    ...(nextIds.length > 0 ? { inboxIds: nextIds } : {}),
  }
}

/**
 * 归档后更新索引条目（复用不新建）。
 *
 * @param {object} index
 * @param {object} params
 */
export function upsertInstanceForTask(index, params) {
  const existing = index.entries.find(
    (entry) =>
      entry.kind === 'instance' &&
      entry.typeSlug === params.typeSlug &&
      entry.instance === params.instance,
  )

  if (existing) {
    existing.bucket = params.bucket
    existing.displayName = params.displayName
    existing.purpose = params.purpose ?? existing.purpose
    existing.project = params.project ?? existing.project ?? null
    existing.to = params.to ?? existing.to ?? null
    existing.machineHandoff = params.machineHandoff
    existing.userHandoff = params.userHandoff
    existing.lastUpdated = params.lastUpdated
    existing.contentHash = params.contentHash
    existing.originTaskId = params.taskId
    existing.effectiveTaskKey = params.effectiveTaskKey
    existing.taskIdScope = params.taskIdScope
    existing.taskIdSource = params.taskIdSource
    existing.sessionId = params.sessionId
    existing.idempotency = params.idempotency
    existing.status = existing.status === 'lost' ? 'active' : (params.status ?? existing.status)
    if (params.direction) {
      existing.latestDirectionId = params.direction.directionId
      existing.directionIds = [...(existing.directionIds ?? []), params.direction.directionId]
      existing.directionBroken = false
    }
    return { entry: existing, created: false }
  }

  const entry = {
    entryId: ulid(),
    kind: 'instance',
    bucket: params.bucket,
    typeSlug: params.typeSlug,
    instance: params.instance,
    displayName: params.displayName,
    purpose: params.purpose ?? null,
    project: params.project ?? null,
    to: params.to ?? null,
    status: params.status ?? 'active',
    machineHandoff: params.machineHandoff,
    userHandoff: params.userHandoff,
    lastUpdated: params.lastUpdated,
    contentHash: params.contentHash,
    originTaskId: params.taskId ?? null,
    effectiveTaskKey: params.effectiveTaskKey ?? null,
    taskIdScope: params.taskIdScope ?? null,
    taskIdSource: params.taskIdSource ?? null,
    sessionId: params.sessionId ?? null,
    idempotency: params.idempotency ?? 'unavailable',
    eventId: null,
    latestDirectionId: params.direction?.directionId ?? null,
    directionIds: params.direction ? [params.direction.directionId] : [],
    directionBroken: false,
    notes: 'end_task 归档时建立',
  }
  index.entries.push(entry)
  return { entry, created: true }
}

/**
 * 读已有的机器版交接（用于保留 createdAt、继承未改动的节）。
 * @param {string} absPath
 */
async function readExistingMachine(absPath) {
  try {
    const text = await fsp.readFile(absPath, 'utf8')
    return { ...parseMachine(text), hash: sha256(text) }
  } catch {
    return null
  }
}

/**
 * 往前翻所有日期目录，取这个实例最近一份机器版交接。
 * 跨天更新时当天文件还不存在，靠它继承 createdAt 与上一版内容。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {string} instance
 */
async function readLatestMachine(ctx, instance) {
  const baseDir = path.join(ctx.root, 'handoff', MACHINE_DIR)
  let days
  try {
    days = (await fsp.readdir(baseDir, { withFileTypes: true }))
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
      .reverse()
  } catch {
    return null
  }
  for (const day of days) {
    const dirAbs = path.join(baseDir, day)
    // 0.3.22 起文件名是「日期-时分-内容总结」，不再含实例名：先按实例名找老文件名，
    // 找不到就取当天最新的 .machine.md（跨天更新时用来续 createdAt，取错也只是时间戳更早）。
    const legacy = await readExistingMachine(path.join(dirAbs, `${instance}.machine.md`))
    if (legacy) return legacy
    let files
    try {
      files = (await fsp.readdir(dirAbs)).filter((name) => name.endsWith('.machine.md'))
    } catch {
      continue
    }
    files.sort().reverse()
    for (const name of files) {
      const found = await readExistingMachine(path.join(dirAbs, name))
      if (found) return found
    }
  }
  return null
}

/**
 * 更新 handoff/README.md（人读目录，§6.4）。
 * 只重写插件自己那一节，不动别的。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {object} index
 */
// 交接总目录（handoff/README.md）的实现在 lib/catalog.js


/**
 * 只允许改这四节（update_handoff 用，§4.9）。
 * @param {string} section
 */
export function assertUpdatableSection(section) {
  if (!UPDATABLE_SECTIONS.includes(section)) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'section',
      reason: `只允许修改：${UPDATABLE_SECTIONS.join(' / ')}`,
    })
  }
  return section
}

/** 目录名用的时间戳（§2.2 trash/<时间戳>）。 */
export function timestampForDir(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

/** 机器版 / 用户版两个交接文件夹（主人 2026-10-31 裁决，见 endTask 注释）。 */
export const MACHINE_DIR = 'machine'
export const USER_DIR = 'user'

/** 交接文件夹里的日期子目录名 `YYYY-MM-DD`（本地时间）。 */
export function dayKeyOf(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** @param {unknown} value */
function pickText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** 正整数（attempts >= 1）；非法返回 null，不拿默认值冒充。 */
function positiveIntOrNull(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n >= 1 ? n : null
}

/** 非负整数（factsCited / factsWrong）；非法返回 null。 */
function nonNegativeIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * 把「数组」或「JSON 编码的数组字符串」统一成数组。
 *
 * 模型侧对没有 type 的 json 参数，有时会把数组序列化成字符串传下来
 * （2026-11-01 实测：end_task 的 done/blocked/readFirst/avoid 全是
 * "[\"…\"]"，而 facts/assumptions 是数组）。两种都认，避免列表被静默吞掉。
 *
 * @param {unknown} value
 * @returns {unknown[] | null}
 */
function asArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text.startsWith('[')) return null
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/** @param {unknown} value */
function pickList(value) {
  const rows = asArray(value)
  if (!rows) return null
  return rows
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

/** @param {unknown} value */
function pickConfirmed(value) {
  const rows = asArray(value)
  if (!rows) return null
  const out = []
  for (const item of rows) {
    if (typeof item === 'string' && item.trim()) out.push({ text: item.trim(), source: '' })
    else if (item && typeof item === 'object' && item.text) {
      out.push({ text: String(item.text).trim(), source: item.source ? String(item.source) : '' })
    }
  }
  return out
}

export { MACHINE_SECTIONS }
