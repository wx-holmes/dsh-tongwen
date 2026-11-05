/**
 * 会话生命周期 —— 规格 §4.2 启动、§4.6 会话结束、§4.8 判定矩阵、§7.5 report 触发、§8.8 补记。
 *
 * 这一层只做“什么时候做什么”，具体怎么读写都在各 lib 模块里。
 * 三个判断贯穿全文件：
 *   - 上次是否正常结束，权威只看 runtime-state + snapshot.sessionEnd（journal 末条不作数）；
 *   - 零变更会话不落 journal，但**必须**写 sessionEnd；
 *   - 任何一处失败都要留下“它失败了”的证据，不能装作成功。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUCKET_LIST, bucketByPhysical } from './buckets.js'
import { ensureIndex, saveIndex, loadIndex, upsertInstanceEntry } from './index-store.js'
import { readOpenItems, summarizeOpenItems, appendOpenItem, closeOpenItem } from './open-items.js'
import { scanBucketPresence } from './paths.js'
import { writeFileAtomic } from './atomic.js'
import { jsonText } from './json-text.js'
import {
  readRuntimeState,
  writeRuntimeState,
  emptyRuntimeState,
  normalizeRuntimeState,
} from './runtime-state.js'
import {
  readSnapshot,
  writeSnapshot,
  emptySnapshot,
  normalizeSnapshot,
  isFirstRun,
  establishBaseline,
  applySessionEnd,
} from './snapshot.js'
import { scanSelf, diffSelf } from './self-scan.js'
import { sha256 } from './hash.js'
import { buildJournal, writeJournal } from './journal.js'
import { updateHandoffReadme, updateProjectOverview } from './catalog.js'
import { runHousekeeping } from './housekeeping.js'
import { ingestOrganEvents } from './organs.js'
import {
  shouldTriggerReport,
  writeReportFile,
  buildReport,
  parseJournalBody,
} from './report.js'

/**
 * 补记/基线统计哪个目录（0.3.7）：`self` 只记日记区，`handoff` 记整个交接区。
 * 路径以该目录为根，快照里用 `scope` 字段记住是哪种，切换时自动重建基线。
 *
 * @param {{root: string}} ctx
 * @param {Record<string, any>} config
 * @returns {{scope: 'self'|'handoff', dir: string}}
 */
export function scanTarget(ctx, config) {
  const scope = config?.['selfScan.scope'] === 'handoff' ? 'handoff' : 'self'
  return { scope, dir: ctx.root ? path.join(ctx.root, scope) : '' }
}

/** handoff/self/README.md 的定位说明（§8.7：只写这一处，不预设 self/ 子目录）。 */export const SELF_README_HEADER = `# 给用户的报告

这个文件夹是插件写给**你**看的，不是给 dsh 看的。

- \`journals/\`：每次会话结束留一篇变更笔记，记这次会话里统计范围（\`selfScan.scope\`，默认 \`handoff/\`）下面哪些文件新增、修改、消失了。
- \`reports/\`：若干篇笔记攒够之后，归并成一份阶段性报告。

内容按固定模板生成，只陈述看到的现象，不做判断。

\`self/\` 文件夹本身留给你用，插件不规定它长什么样，也不会改动里面的东西。
`

/**
 * 上次会话是否正常结束 —— 规格 §4.8 判定矩阵。
 *
 * 纯函数：只吃两个权威来源，返回判定与建议动作，不读写文件。
 *
 * @param {object} params
 * @param {import('./runtime-state.js').RuntimeState|null} params.runtimeState
 * @param {import('./snapshot.js').Snapshot|null} params.snapshot
 * @returns {{verdict: 'first'|'normal'|'abnormal'|'unknown', action: 'none'|'backfill'|'fixStatus', warn: boolean, note: string}}
 */
export function judgePreviousSession({ runtimeState, snapshot }) {
  const hasRS = Boolean(runtimeState)
  const hasSS = Boolean(snapshot)
  const sessionEnd = snapshot?.sessionEnd ?? null
  const hasSessionEnd = Boolean(sessionEnd && sessionEnd.sessionId)

  if (!hasRS && !hasSS) {
    return { verdict: 'first', action: 'none', warn: false, note: '首次运行，没有上一次会话的记录' }
  }

  if (hasSS && !hasRS) {
    return hasSessionEnd
      ? { verdict: 'normal', action: 'none', warn: true, note: '运行时状态文件缺失，快照显示上次正常结束' }
      : { verdict: 'unknown', action: 'none', warn: false, note: '运行时状态文件缺失，快照也没有结束记录' }
  }

  if (!hasSS && hasRS) {
    return runtimeState.status === 'active'
      ? { verdict: 'abnormal', action: 'backfill', warn: true, note: '快照缺失，而上一次会话状态仍为 active' }
      : { verdict: 'unknown', action: 'none', warn: true, note: '快照缺失，上一次会话状态为 ended' }
  }

  // 两个都在
  if (runtimeState.status === 'active') {
    if (hasSessionEnd && sessionEnd.sessionId === runtimeState.sessionId) {
      return { verdict: 'normal', action: 'fixStatus', warn: false, note: '快照已记录结束，运行时状态未更新，已修正' }
    }
    return {
      verdict: 'abnormal',
      action: 'backfill',
      warn: true,
      note: hasSessionEnd
        ? '上次会话 ID 与快照记录的结束 ID 不一致'
        : '上次会话状态为 active 且快照没有结束记录',
    }
  }

  if (hasSessionEnd && sessionEnd.sessionId === runtimeState.sessionId) {
    return { verdict: 'normal', action: 'none', warn: false, note: '上一次会话正常结束' }
  }
  // 建立基线的那一轮按 §8.6 不写 sessionEnd；状态已是 ended 且基线已建立 → 视为正常结束。
  if (snapshot?.baselineEstablished && !hasSessionEnd) {
    return {
      verdict: 'normal',
      action: 'none',
      warn: false,
      note: '基线轮次结束时按规格不写 sessionEnd，运行时状态已是 ended',
    }
  }
  return { verdict: 'unknown', action: 'none', warn: false, note: '状态为 ended，快照无对应结束记录' }
}

/**
 * 读 current.json 做版本预检（§4.2 步骤 1 / §11.3 预检）。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @returns {Promise<{status: 'ok'|'firstInstall'|'missing'|'incompatible', version?: string, structureVersion?: string, note: string}>}
 */
export async function checkVersion(ctx) {
  let raw = null
  try {
    raw = await fsp.readFile(ctx.currentFile, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { status: 'missing', note: `无法读取版本指针（${error?.code ?? '未知错误'}）` }
    }

    // current.json 不存在：区分「首次」与「损坏」
    const others = await Promise.all([
      exists(ctx.indexFile),
      exists(ctx.runtimeStateFile),
    ])
    if (!others[0] && !others[1]) {
      return { status: 'firstInstall', note: '本次是第一次启动，启动过程中会写入版本指针与状态文件' }
    }
    return {
      status: 'missing',
      note: '版本指针缺失，但已存在索引或运行时状态；不按首次安装处理',
    }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'incompatible', note: '版本指针无法解析' }
  }

  const structureVersion = parsed?.structureVersion
  if (structureVersion !== '9档-v1') {
    return {
      status: 'incompatible',
      structureVersion,
      note: `结构版本 ${structureVersion ?? '(缺失)'} 与当前插件要求的 9档-v1 不一致，且没有可用的迁移脚本`,
    }
  }

  return {
    status: 'ok',
    version: parsed?.version,
    structureVersion,
    note: `版本 ${parsed?.version ?? '(未标注)'}`,
  }
}

/**
 * 首次安装时补写版本指针（§11.5）。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {string} pluginVersion
 */
export async function writeCurrentPointer(ctx, pluginVersion) {
  const payload = {
    version: pluginVersion,
    structureVersion: '9档-v1',
    handoffSchemaVersion: '1.0',
    installedAt: new Date().toISOString(),
    notes: '插件首次初始化时写入',
  }
  await writeFileAtomic(ctx.currentFile, `${jsonText(payload)}\n`)
  return payload
}

/**
 * 版本指针同步（§11.3）：current.json 已经在、但版本号落后时，启动流程把它刷到当前版本。
 *
 * 只同步版本号，不动结构版本 —— 结构版本不一致是 incompatible，不是「顺手改一下」。
 * installedAt 保留首次安装时间，另记 upgradedAt。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {string} pluginVersion
 * @param {string|undefined} previousVersion
 */
export async function syncCurrentPointer(ctx, pluginVersion, previousVersion) {
  let existing = {}
  try {
    const parsed = JSON.parse(await fsp.readFile(ctx.currentFile, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
  } catch {
    existing = {}
  }
  const payload = {
    ...existing,
    version: pluginVersion,
    structureVersion: '9档-v1',
    handoffSchemaVersion: existing.handoffSchemaVersion ?? '1.0',
    installedAt: existing.installedAt ?? new Date().toISOString(),
    upgradedAt: new Date().toISOString(),
    notes: `自 ${previousVersion ?? '(未标注)'} 升级时由启动流程同步`,
  }
  await writeFileAtomic(ctx.currentFile, `${jsonText(payload)}\n`)
  return payload
}

/**
 * 完整启动流程（§4.2）。
 *
 * 不抛：所有异常折成 warnings 交给调用方决定注入里怎么写。
 *
 * @param {object} params
 * @param {import('./context.js').PluginContext} params.ctx
 * @param {import('./audit.js').AuditWriter} params.writer
 * @param {Record<string, any>} params.config
 * @param {string} params.pluginVersion
 * @param {string} params.sessionId
 * @param {'host'|'generated'} [params.sessionIdSource]
 * @returns {Promise<object>}
 */
export async function runStartup({ ctx, writer, config, pluginVersion, sessionId, sessionIdSource = 'host' }) {
  /** @type {string[]} */ const warnings = []
  /** @type {string[]} */ const notes = []

  // ── 1. 版本预检 ──
  const version = await checkVersion(ctx)
  if (version.status === 'incompatible') {
    return {
      ok: false,
      fatal: true,
      version,
      warnings: [version.note],
      notes,
      sessionId,
      context: ctx,
    }
  }
  if (version.status === 'firstInstall') {
    notes.push('首次初始化')
    try {
      await writeCurrentPointer(ctx, pluginVersion)
      await writer.write({ op: 'init.completed', target: 'config/plugins/tongwen-tonggui/current.json', result: 'ok' })
    } catch (error) {
      warnings.push(`版本指针写入失败：${error?.code ?? error?.message ?? '未知错误'}`)
    }
  } else if (version.status === 'missing') {
    warnings.push(version.note)
    notes.push('版本指针缺失，已按已有状态继续运行')
  } else if (version.status === 'ok' && version.version !== pluginVersion) {
    // 升级后的第一次启动：指针还写着旧版本号。同步一次，别让它永远停在安装那天的号上。
    try {
      await syncCurrentPointer(ctx, pluginVersion, version.version)
      notes.push(`版本指针同步：${version.version ?? '(未标注)'} → ${pluginVersion}`)
      try {
        await writer.write({
          op: 'version.pointerSynced',
          target: 'config/plugins/tongwen-tonggui/current.json',
          result: 'ok',
          note: `版本指针 ${version.version ?? '(未标注)'} → ${pluginVersion}`,
        })
      } catch {
        // 审计失败不阻断启动
      }
    } catch (error) {
      warnings.push(`版本指针同步失败：${error?.code ?? error?.message ?? '未知错误'}`)
    }
  }

  // ── 2. 扫九档；缺失的按 §10.4 / §11.5 重建空档（只 mkdir，不碰索引与备份）──
  const presence = await scanBucketPresence(ctx.root)
  const recreatedBuckets = []
  for (const key of presence.missing) {
    const bucket = bucketByPhysical(key)
    if (!bucket) continue
    try {
      await fsp.mkdir(path.join(ctx.root, bucket.physical), { recursive: true })
      recreatedBuckets.push(key)
    } catch (error) {
      warnings.push(`顶层档重建失败：${bucket.physical}（${error?.code ?? '未知错误'}）`)
    }
  }
  for (const key of presence.notWritable ?? []) {
    const bucket = bucketByPhysical(key)
    warnings.push(`顶层档不可写：${bucket?.physical ?? key}（该档本次禁写）`)
  }

  // ── 3. 索引自愈 ──
  let index
  try {
    const result = await ensureIndex(ctx)
    index = result.index
    if (result.action === 'rebuilt') {
      warnings.push('索引损坏，已保留旧文件并按真实目录重建')
      try {
        await appendOpenItem({
          file: ctx.openItemsFile,
          event: 'open',
          category: 'index_inconsistent',
          stableKey: result.corruptArchive ?? 'rebuilt',
          summary: '索引文件损坏，已重建；重建结果可能与原索引不一致',
          sessionId,
          related: { path: 'handoff/index.machine.json' },
          maxActive: Number(config['openItems.maxActive']),
        })
      } catch {
        // 索引已重建，open-items 写不进去不阻断启动
      }
    } else if (result.action === 'created') {
      notes.push('首次建立索引')
    }
  } catch (error) {
    return {
      ok: false,
      fatal: true,
      version,
      warnings: [...warnings, `索引不可用：${error?.code ?? error?.message ?? '未知错误'}`],
      notes,
      sessionId,
      context: ctx,
    }
  }

  // 顶层档重建后按 §10.4 乙处理：索引里指向该档的条目标 lost，不自动清理。
  if (recreatedBuckets.length > 0) {
    const affected = new Set(recreatedBuckets)
    let lostCount = 0
    for (const entry of index.entries) {
      if (affected.has(entry.bucket) && entry.status !== 'lost') {
        entry.status = 'lost'
        entry.notes = [entry.notes, '顶层档被删后按 §10.4 重建，条目标 lost']
          .filter(Boolean)
          .join('；')
        lostCount += 1
      }
    }
    const names = recreatedBuckets.map((key) => bucketByPhysical(key)?.physical ?? key).join('、')
    warnings.push(
      lostCount > 0
        ? `顶层档缺失已重建：${names}（索引 ${lostCount} 条目标 lost）`
        : `顶层档缺失已重建：${names}`,
    )
    try {
      await writer.write({
        op: 'init.bucketRecreated',
        target: names,
        result: 'ok',
        detail: { buckets: recreatedBuckets, lostEntries: lostCount },
      })
    } catch {
      // 审计失败不阻断启动
    }
  }

  // ── 4. 上次会话是否正常结束 ──
  const previousRS = (await readRuntimeState(ctx.runtimeStateFile)).state
  const { snapshot: previousSnapshot } = await readSnapshot(ctx.snapshotFile)
  const judgement = judgePreviousSession({ runtimeState: previousRS, snapshot: previousSnapshot })

  if (judgement.warn) warnings.push(judgement.note)

  // ── 5. 按判定修正状态 / 补记 ──
  let backfill = null
  if (judgement.action === 'fixStatus' && previousRS) {
    const fixed = normalizeRuntimeState({ ...previousRS, status: 'ended', endedAt: previousRS.endedAt ?? new Date().toISOString() })
    try {
      await writeRuntimeState(ctx.runtimeStateFile, fixed)
      await writer.write({ op: 'sessionEnd.recovered', target: 'runtime-state', result: 'ok', note: judgement.note })
    } catch {
      warnings.push('修正上次会话状态失败')
    }
  } else if (judgement.action === 'backfill') {
    backfill = await performBackfill({
      ctx,
      writer,
      config,
      sessionId,
      previousRuntimeState: previousRS,
      snapshot: previousSnapshot,
    })
    warnings.push(...backfill.warnings)
  }

  // ── 6. 建立本次会话的运行时状态 ──
  // 同一会话（session id 相同）异常重启时，把上一个运行态的 currentTask 带过来：
  // 任务登记是 agent 侧的事实，DSH 重启不该把它清掉，否则 end_task 会找不到任务。
  const carriedTask =
    previousRS && previousRS.sessionId === sessionId && previousRS.status === 'active' && previousRS.currentTask
      ? previousRS.currentTask
      : null
  const runtimeState = normalizeRuntimeState({
    ...emptyRuntimeState(),
    sessionId,
    sessionIdSource,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    status: 'active',
    currentTask: carriedTask,
  })
  try {
    await writeRuntimeState(ctx.runtimeStateFile, runtimeState)
  } catch (error) {
    warnings.push(`运行时状态写入失败（${error?.code ?? '未知错误'}），本次会话状态可能无法落盘`)
  }

  // ── 6.5 记录本次实际从哪个目录加载（验收时不用再靠 junction 和时间线旁证）──
  try {
    const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    await writer.write({ op: 'startup.source', target: pluginRoot, result: 'ok', note: `session ${sessionId}` })
  } catch {
    // 审计失败不阻断启动
  }

  // ── 7. 重算未闭环项统计 ──
  let openItems = { active: new Map(), total: 0, byCategory: {} }
  try {
    const loaded = await readOpenItems(ctx.openItemsFile)
    openItems = { ...summarizeOpenItems(loaded.active), active: loaded.active, malformed: loaded.malformed }
  } catch (error) {
    warnings.push(`未闭环项读取失败：${error?.code ?? '未知错误'}`)
  }

  // ── 8. 确保 handoff/self/README.md 存在（定位说明只写这一处）──
  try {
    await ensureSelfReadme(ctx)
  } catch {
    // README 缺失不影响主流程
  }

  index.selfState = {
    ...index.selfState,
    openItemsCount: openItems.total ?? 0,
    openItemsByCategory: openItems.byCategory ?? {},
    lastOpenItemsScanAt: new Date().toISOString(),
    lastSessionId: sessionId,
  }

  // 补记过就说明上一轮没正常收尾：把结论写进索引，别只在 journal 里留一行。
  if (backfill?.written) {
    index.selfState.lastSessionEndAt = new Date().toISOString()
    index.selfState.lastSessionEndStatus = 'abnormal'
    index.selfState.lastJournalAt = index.selfState.lastSessionEndAt
    index.selfState.lastJournalRef = backfill.journalRef ?? index.selfState.lastJournalRef
    index.selfState.pendingJournalCount = (index.selfState.pendingJournalCount ?? 0) + 1
    if (backfill.snapshotOk) {
      index.selfState.baselineEstablishedAt =
        index.selfState.baselineEstablishedAt ?? index.selfState.lastSessionEndAt
    }
  }
  try {
    await saveIndex(ctx.indexFile, index)
  } catch {
    // 索引失败不阻断启动
  }

  // 启动时刷新总目录：新会话第一眼看到的是「文件放哪 + 当前一棒 + 交接清单」。
  try {
    await updateHandoffReadme(ctx, index)
  } catch {
    // 总目录刷新失败不影响启动
  }
  // 第二张对齐图：项目多少个、各自到哪一步、最近加了什么。
  try {
    await updateProjectOverview(ctx, index)
    try {
      await runHousekeeping(ctx, config)
    } catch {
      /* 过期文件报告失败不影响启动 */
    }
  } catch {
    // 项目总览刷新失败不影响启动
  }
  // 器官事件入账（0.4.0 v0）：读各器官 events.jsonl 的新行，写进账本流水（type=organ）。
  try {
    if (config?.['organs.enabled'] !== false) await ingestOrganEvents(ctx, config)
  } catch {
    /* 器官事件是增强，失败不阻断启动 */
  }

  return {
    ok: true,
    fatal: false,
    version,
    judgement,
    backfill,
    index,
    runtimeState,
    openItems,
    presence,
    recreatedBuckets,
    warnings,
    notes,
  }
}

/**
 * 补记一篇异常结束的会话（§8.8）。
 *
 * @param {object} params
 * @param {import('./context.js').PluginContext} params.ctx
 * @param {import('./audit.js').AuditWriter} params.writer
 * @param {Record<string, any>} params.config
 * @param {string} params.sessionId 本次启动的会话 ID（补记用它作为记录者）
 * @param {import('./runtime-state.js').RuntimeState|null} params.previousRuntimeState
 * @param {import('./snapshot.js').Snapshot|null} params.snapshot
 */
export async function performBackfill({ ctx, writer, config, sessionId, previousRuntimeState, snapshot }) {
  /** @type {string[]} */ const warnings = []
  const lostSessionId = previousRuntimeState?.sessionId ?? null

  if (!lostSessionId) {
    return { written: false, warnings: ['上次会话缺少会话 ID，无法补记'] }
  }

  // 同一会话可能反复崩溃重启，每次崩溃都是一个独立的窗口，都该有自己的一篇补记。
  // 去重键必须是 (会话, 窗口起点)，不能只按会话 ID —— 只按会话 ID 的话，
  // 一个会话 ID 一辈子只会有一篇补记（2026-11-01 实测到的真实故障）。
  const windowStart = previousRuntimeState?.startedAt ?? null
  if (await journalHasWindow(ctx.journalsDir, lostSessionId, windowStart)) {
    try {
      await writer.write({ op: 'sessionEnd.duplicateDetected', target: `session ${lostSessionId}`, result: 'warn', note: '同一窗口已补记过' })
    } catch {
      // 审计失败不阻断
    }
    return { written: false, duplicate: true, warnings: [] }
  }

  const target = scanTarget(ctx, config)
  const previousScope = snapshot?.scope === 'handoff' ? 'handoff' : 'self'
  // 统计范围切换后旧基线不能拿来比，按「快照丢失」重建一次。
  const scopeChanged = Boolean(snapshot) && previousScope !== target.scope
  const snapshotLost = !snapshot || scopeChanged
  let scan
  try {
    scan = await scanSelf(target.dir, {
      config,
      previous: snapshot?.files ?? null,
    })
  } catch (error) {
    return { written: false, warnings: [`补记扫描失败：${error?.code ?? '未知错误'}`] }
  }

  const diff = snapshotLost
    ? { added: [], modified: [], removed: [], unchangedUnknown: [], caseChanged: false }
    : diffSelf(snapshot?.files ?? [], scan.files)

  // 心跳可能从未刷新（lastHeartbeatAt 停在 startedAt），只取它会把窗口塌成同一
  // 时刻、统计恒为 0/0/0。用快照的最后扫描时间兜底；仍不晚于开始时间则视为无记录。
  const candidates = [
    previousRuntimeState?.lastHeartbeatAt,
    previousRuntimeState?.endedAt,
    snapshot?.lastCompleteScanAt,
    snapshot?.lastScanAt,
  ].filter((value) => typeof value === 'string' && value !== '')
  const latest = candidates.sort().at(-1) ?? null
  const windowEnd = windowStart && latest && latest <= windowStart ? null : latest

  const content = buildJournal({
    at: new Date(),
    sessionId: lostSessionId,
    sessionIdSource: previousRuntimeState?.sessionIdSource ?? 'host',
    windowStart,
    windowEnd,
    diff,
    scan,
    scope: target.scope,
    backfill: true,
    // 崩溃时正在跑的任务不能跟着进程一起消失：把它写进补记，下一棒才知道接的是什么。
    openTask: previousRuntimeState?.currentTask ?? null,
    extraNote: scopeChanged
      ? `统计范围从 ${previousScope}/ 切到 ${target.scope}/，本次重建基线，不比对差异`
      : (snapshotLost ? '快照丢失，无法比对新增/修改/消失' : undefined),
  })

  let written
  try {
    written = await writeJournal({ journalsDir: ctx.journalsDir, at: new Date(), content })
  } catch (error) {
    return { written: false, warnings: [`补记写入失败：${error?.code ?? '未知错误'}`] }
  }

  try {
    await writer.write({
      op: 'sessionEnd.backfill',
      target: written.relPath,
      result: 'warn',
      note: `上次会话 ${lostSessionId} 未正常结束`,
    })
  } catch {
    // 忽略
  }

  // 补记之后把基线补上。否则「快照丢失」永远成立，下一轮启动仍然判异常，
  // journal 里会一直只有一行「快照丢失」——看着像在记录，其实什么都没记。
  // §8.8：补记成功且扫描完整时才更新基线；partial 不覆盖完整基线。
  let snapshotOk = false
  if (!scan.partial) {
    try {
      const base = normalizeSnapshot(snapshot ?? emptySnapshot())
      const rebased = establishBaseline(base, scan, new Date())
      rebased.scope = target.scope
      await writeSnapshot(ctx.snapshotFile, rebased)
      snapshotOk = true
      try {
        await writer.write({
          op: snapshotLost ? 'snapshot.lostRebaseline' : 'snapshot.backfillBaseline',
          target: 'self-snapshot.json',
          result: 'ok',
          note: snapshotLost ? '快照丢失，用本次扫描重建基线' : '补记时同步基线',
        })
      } catch {
        // 审计失败不阻断
      }
    } catch (error) {
      warnings.push(`补记后写快照失败：${error?.code ?? '未知错误'}`)
    }
  } else {
    warnings.push(`${target.scope}/ 扫描不完整（partial），本次不更新基线`)
  }

  return {
    written: true,
    journalRef: written.relPath,
    sessionId: lostSessionId,
    snapshotLost,
    snapshotOk,
    warnings,
  }
}

/**
 * 会话结束（§4.6）。
 *
 * 写入顺序固定：journal → snapshot → runtime-state。前两步的失败策略不同：
 *   journal 失败 → 阻断收尾（保持 active，下次按异常补记）；
 *   snapshot 失败 → 保留 pending，runtime-state 仍写 ended。
 *
 * @param {object} params
 * @param {import('./context.js').PluginContext} params.ctx
 * @param {import('./audit.js').AuditWriter} params.writer
 * @param {Record<string, any>} params.config
 * @param {import('./runtime-state.js').RuntimeState} params.runtimeState
 * @param {object} params.index
 * @returns {Promise<object>}
 */
export async function runSessionEnd({ ctx, writer, config, runtimeState, index }) {
  /** @type {string[]} */ const warnings = []

  // ── 1. 扫描统计范围（self/ 或 handoff/）──
  const target = scanTarget(ctx, config)
  const { snapshot: previousSnapshot, corrupt } = await readSnapshot(ctx.snapshotFile)
  const firstRun = isFirstRun(previousSnapshot, corrupt)
  // 范围切换：旧基线是另一个目录的，不能拿来比，按「重建基线」处理。
  const previousScope = previousSnapshot?.scope === 'handoff' ? 'handoff' : 'self'
  const scopeChanged = Boolean(previousSnapshot) && previousScope !== target.scope

  let scan
  try {
    scan = await scanSelf(target.dir, {
      config,
      previous: previousSnapshot?.files ?? null,
    })
  } catch (error) {
    return {
      ok: false,
      blocked: true,
      warnings: [`${target.scope}/ 扫描失败：${error?.code ?? '未知错误'}`],
    }
  }

  const endedAt = new Date()

  // ── 2. 首次基线 / 范围切换：不产生「新增」、不写 journal、不写 sessionEnd ──
  // 但 runtime-state 仍按 §4.6 步骤 4 写 ended —— 会话确实结束了，只是还没有可比对的历史。
  if (firstRun || scopeChanged) {
    const baseline = establishBaseline(normalizeSnapshot(previousSnapshot ?? emptySnapshot()), scan, endedAt)
    baseline.scope = target.scope
    let snapshotOk = true
    try {
      await writeSnapshot(ctx.snapshotFile, baseline)
      await writer.write({
        op: scopeChanged ? 'snapshot.scopeRebaseline' : 'snapshot.baselineEstablished',
        target: 'self-snapshot.json',
        result: 'ok',
        ...(scopeChanged ? { note: `统计范围 ${previousScope}/ → ${target.scope}/` } : {}),
      })
    } catch (error) {
      snapshotOk = false
      warnings.push(`基线快照写入失败：${error?.code ?? '未知错误'}`)
    }
    try {
      await writeRuntimeState(ctx.runtimeStateFile, {
        ...runtimeState,
        status: 'ended',
        endedAt: endedAt.toISOString(),
        lastHeartbeatAt: endedAt.toISOString(),
      })
    } catch (error) {
      warnings.push(`运行时状态写入失败：${error?.code ?? '未知错误'}`)
    }
    if (index) {
      index.selfState = {
        ...index.selfState,
        baselineEstablishedAt: endedAt.toISOString(),
        lastSessionId: runtimeState.sessionId,
        lastSessionEndAt: endedAt.toISOString(),
        lastSessionEndStatus: 'normal',
        lastSessionZeroChange: true,
      }
      try {
        await saveIndex(ctx.indexFile, index)
      } catch {
        // 索引失败不阻断
      }
    }
    return {
      ok: true,
      firstRun: !scopeChanged,
      scopeRebaselined: scopeChanged,
      scope: target.scope,
      zeroChange: true,
      journalWritten: false,
      snapshotOk,
      warnings,
      scan,
    }
  }

  const diff = diffSelf(previousSnapshot?.files ?? [], scan.files)
  const changed = diff.added.length + diff.modified.length + diff.removed.length
  const zeroChange = changed === 0

  // ── 3. 有变更才写 journal（零变更不落文件）──
  let journalRef = null
  if (!zeroChange) {
    const windowStart = previousSnapshot?.sessionEnd?.endedAt
      ?? previousSnapshot?.lastScanAt
      ?? previousSnapshot?.baselineEstablishedAt
      ?? null
    const content = buildJournal({
      at: endedAt,
      sessionId: runtimeState.sessionId,
      sessionIdSource: runtimeState.sessionIdSource,
      windowStart,
      windowEnd: endedAt.toISOString(),
      diff,
      scan,
      scope: target.scope,
    })
    try {
      const written = await writeJournal({ journalsDir: ctx.journalsDir, at: endedAt, content })
      journalRef = written.relPath
      await writer.write({ op: 'journal.write', target: journalRef, result: 'ok' })

      // 索引里留一条 journal 条目：report 的 coveredJournalRefs 就是从这里取的。
      try {
        upsertInstanceEntry(index, {
          kind: 'journal',
          bucket: 'handoff',
          typeSlug: 'self',
          instance: written.name.replace(/\.md$/, ''),
          machineHandoff: journalRef,
          displayName: written.name,
          lastUpdated: endedAt.toISOString(),
          contentHash: sha256(content),
          sessionId: runtimeState.sessionId,
          status: 'done',
          idempotency: runtimeState.sessionIdSource === 'generated' ? 'weak' : 'strong',
          notes: '会话结束变更笔记',
        })
      } catch {
        // 索引条目失败不阻断收尾
      }
    } catch (error) {
      // journal 失败 → 阻断收尾，状态保持 active，下次按异常处理
      return {
        ok: false,
        blocked: true,
        warnings: [`变更笔记写入失败：${error?.code ?? '未知错误'}`],
        diff,
      }
    }
  } else {
    await writer.write({ op: 'journal.zeroChange', target: null, result: 'ok' })
  }

  // ── 4. 写快照（无论有无变更都写 sessionEnd）──
  const nextSnapshot = applySessionEnd(
    normalizeSnapshot(previousSnapshot ?? emptySnapshot()),
    {
      scan,
      sessionId: runtimeState.sessionId,
      endedAt: endedAt.toISOString(),
      zeroChange,
      journalWritten: Boolean(journalRef),
      journalRef,
    },
  )
  nextSnapshot.scope = target.scope
  let snapshotOk = true
  try {
    await writeSnapshot(ctx.snapshotFile, nextSnapshot)
  } catch (error) {
    snapshotOk = false
    warnings.push(`快照写入失败（${error?.code ?? '未知错误'}），已保留 pending 供下次补提交`)
    try {
      await appendOpenItem({
        file: ctx.openItemsFile,
        event: 'open',
        category: 'snapshot_pending',
        stableKey: 'self-snapshot',
        summary: '会话结束快照未能写入，下次启动会尝试补提交',
        sessionId: runtimeState.sessionId,
        related: { path: 'config/plugins/tongwen-tonggui/self-snapshot.json' },
        maxActive: Number(config['openItems.maxActive']),
      })
    } catch {
      // 忽略
    }
  }

  // ── 5. 运行时状态写 ended ──
  const endedState = normalizeRuntimeState({
    ...runtimeState,
    status: 'ended',
    endedAt: endedAt.toISOString(),
    lastHeartbeatAt: endedAt.toISOString(),
  })
  try {
    await writeRuntimeState(ctx.runtimeStateFile, endedState)
  } catch {
    warnings.push('运行时状态写入失败；快照里的 sessionEnd 仍可作为结束凭证')
  }

  // ── 6. 索引 selfState ──
  const selfState = index.selfState ?? {}
  const nextSelfState = {
    ...selfState,
    lastJournalAt: journalRef ? endedAt.toISOString() : selfState.lastJournalAt ?? null,
    lastJournalRef: journalRef ?? selfState.lastJournalRef ?? null,
    // 零变更不计入 pendingJournalCount（§7.5）
    pendingJournalCount: (selfState.pendingJournalCount ?? 0) + (journalRef ? 1 : 0),
    lastSessionId: runtimeState.sessionId,
    lastSessionEndAt: endedAt.toISOString(),
    lastSessionEndStatus: 'normal',
    lastSessionZeroChange: zeroChange,
    baselineEstablishedAt: nextSnapshot.baselineEstablishedAt ?? selfState.baselineEstablishedAt ?? null,
  }
  if (nextSelfState.pendingJournalCount > 0) {
    nextSelfState.lastSessionEndStatus = 'normal'
  }

  // ── 7. report 触发检查 ──
  const reportResult = await maybeGenerateReport({
    ctx,
    writer,
    config,
    runtimeState: endedState,
    selfState: nextSelfState,
    index,
    now: endedAt,
  })
  if (reportResult.selfState) Object.assign(nextSelfState, reportResult.selfState)

  index.selfState = nextSelfState
  try {
    await saveIndex(ctx.indexFile, index)
  } catch {
    warnings.push('索引写入失败（不影响本次收尾）')
  }

  return {
    ok: true,
    blocked: false,
    journalWritten: Boolean(journalRef),
    journalRef,
    zeroChange,
    snapshotOk,
    diff,
    report: reportResult,
    warnings,
  }
}

/**
 * report 双触发与写入顺序（§7.5）。
 *
 * @param {object} params
 * @param {import('./context.js').PluginContext} params.ctx
 * @param {import('./audit.js').AuditWriter} params.writer
 * @param {Record<string, any>} params.config
 * @param {import('./runtime-state.js').RuntimeState} params.runtimeState
 * @param {object} params.selfState
 * @param {object} params.index
 * @param {Date} params.now
 */
export async function maybeGenerateReport({ ctx, writer, config, runtimeState, selfState, index, now }) {
  // 上次失败批次还没消化：先判断能不能只补齐
  const pending = runtimeState.pendingReportBatch
  const selfStatePatch = {}

  const trigger = shouldTriggerReport({ selfState, config, now })
  const needReport = trigger.trigger || Boolean(pending)

  if (!needReport) {
    return { triggered: false, selfState: patchDueBy(selfState, trigger.dueBy) }
  }

  const covered = pending?.reportWritten && pending.journalRefs?.length
    ? pending.journalRefs
    : await collectPendingJournalRefs(ctx.indexFile, selfState)

  if (covered.length === 0 && !pending) {
    return { triggered: false, selfState: {} }
  }

  // 只补状态，不重复生成文件
  if (pending?.reportWritten) {
    selfStatePatch.pendingJournalCount = 0
    selfStatePatch.lastReportAt = now.toISOString()
    const nextRS = { ...runtimeState }
    delete nextRS.pendingReportBatch
    try {
      await writeRuntimeState(ctx.runtimeStateFile, nextRS)
    } catch {
      // 失败时保留 pending，下次再来
    }
    return { triggered: true, recovered: true, selfState: selfStatePatch }
  }

  // 生成报告正文
  let content
  try {
    content = await composeReport({ ctx, config, selfState, covered, now })
  } catch (error) {
    // 步骤 2 失败：pendingJournalCount 不变
    const batch = {
      journalRefs: covered,
      failedAt: now.toISOString(),
      reason: error?.code ?? 'report_compose_failed',
      attemptCount: (pending?.attemptCount ?? 0) + 1,
    }
    const nextRS = { ...runtimeState, pendingReportBatch: batch }
    try {
      await writeRuntimeState(ctx.runtimeStateFile, nextRS)
    } catch {
      // 忽略
    }
    try {
      await appendOpenItem({
        file: ctx.openItemsFile,
        event: 'open',
        category: 'report_write_failed',
        stableKey: `report:${covered.join(',')}`,
        summary: '阶段性报告生成失败，已记录待重试批次',
        sessionId: runtimeState.sessionId,
        related: { path: 'handoff/self/reports' },
        maxActive: Number(config['openItems.maxActive']),
      })
    } catch {
      // 忽略
    }
    return { triggered: true, failed: true, selfState: {} }
  }

  let written
  try {
    await fsp.mkdir(ctx.reportsDir, { recursive: true })
    written = await writeReportFile({ reportsDir: ctx.reportsDir, at: now, content })
    await writer.write({ op: 'report.write', target: written.relPath, result: 'ok' })
  } catch (error) {
    const batch = {
      journalRefs: covered,
      failedAt: now.toISOString(),
      reason: error?.code ?? 'report_write_failed',
      attemptCount: (pending?.attemptCount ?? 0) + 1,
    }
    try {
      await writeRuntimeState(ctx.runtimeStateFile, { ...runtimeState, pendingReportBatch: batch })
    } catch {
      // 忽略
    }
    return { triggered: true, failed: true, selfState: {} }
  }

  // 报告已写：即使后面状态没更新，也要让下次知道“文件已经有了”
  selfStatePatch.pendingJournalCount = 0
  selfStatePatch.lastReportAt = now.toISOString()
  const nextRS = { ...runtimeState }
  delete nextRS.pendingReportBatch
  try {
    await writeRuntimeState(ctx.runtimeStateFile, nextRS)
  } catch {
    try {
      await writeRuntimeState(ctx.runtimeStateFile, {
        ...runtimeState,
        pendingReportBatch: {
          journalRefs: covered,
          failedAt: now.toISOString(),
          reason: 'runtime_state_update_failed',
          attemptCount: 1,
          reportWritten: true,
        },
      })
    } catch {
      // 忽略
    }
  }

  await closeReportOpenItems(ctx, writer, runtimeState)
  return { triggered: true, reportRef: written.relPath, selfState: selfStatePatch }
}

/** @param {object} selfState @param {string|null} dueBy */
function patchDueBy(selfState, dueBy) {
  const patch = {}
  if (dueBy && dueBy !== selfState.nextReportDueBy) patch.nextReportDueBy = dueBy
  return patch
}

/**
 * 列出上次 report 之后新增的 journal（来源索引）。
 * @param {string} indexFile
 * @param {object} selfState
 */
async function collectPendingJournalRefs(indexFile, selfState) {
  const { index } = await loadIndex(indexFile)
  const lastReportAt = selfState.lastReportAt ? new Date(selfState.lastReportAt).getTime() : 0

  return index.entries
    .filter((entry) => entry.kind === 'journal')
    .filter((entry) => {
      const at = Date.parse(entry.lastUpdated ?? '')
      return Number.isFinite(at) ? at > lastReportAt : true
    })
    .map((entry) => entry.machineHandoff ?? '')
    .filter(Boolean)
}

/**
 * 读被覆盖的 journal 原文并拼出报告。
 */
async function composeReport({ ctx, selfState, covered, now }) {
  const journalDiffs = []
  for (const ref of covered) {
    const rel = String(ref).replace(/^handoff\/self\/journals\//, '')
    const abs = path.join(ctx.journalsDir, rel)
    let text = ''
    try {
      text = await fsp.readFile(abs, 'utf8')
    } catch {
      continue
    }
    journalDiffs.push(parseJournalBody(text))
  }

  const { snapshot } = await readSnapshot(ctx.snapshotFile)
  const files = snapshot?.files ?? []
  const totalBytes = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0)

  const periodStart = selfState.lastReportAt
    ?? selfState.baselineEstablishedAt
    ?? covered[0] ?? now.toISOString()
  const periodEnd = now.toISOString()

  return buildReport({
    periodStart,
    periodEnd,
    coveredJournalRefs: covered,
    journalDiffs,
    intensity: {
      fileCount: files.length,
      totalBytes,
      previousFileCount: null,
      previousTotalBytes: null,
    },
  })
}

/** report 成功后关掉对应的未闭环项。 */
async function closeReportOpenItems(ctx, writer, runtimeState) {
  try {
    const loaded = await readOpenItems(ctx.openItemsFile)
    for (const [stableKey, item] of loaded.active) {
      if (item.category !== 'report_write_failed') continue
      await closeOpenItem({
        file: ctx.openItemsFile,
        category: 'report_write_failed',
        stableKey,
        closeReason: 'resolved',
        sessionId: runtimeState.sessionId,
        summary: '阶段性报告已生成',
        related: item.related ?? {},
      })
    }
  } catch {
    // 关闭失败不影响报告本身
  }
}

/**
 * 确保 handoff/self/README.md 存在。只在缺失时写，不覆盖用户改动。
 * @param {import('./context.js').PluginContext} ctx
 */
export async function ensureSelfReadme(ctx) {
  const file = path.join(ctx.handoffSelfDir, 'README.md')
  if (await exists(file)) return false
  await fsp.mkdir(ctx.handoffSelfDir, { recursive: true })
  await writeFileAtomic(file, SELF_README_HEADER)
  return true
}

/**
 * journal 目录里是否已有某次会话的记录（§8.8 去重）。
 * @param {string} journalsDir
 * @param {string} sessionId
 */
export async function journalHasSession(journalsDir, sessionId) {
  let names = []
  try {
    names = await fsp.readdir(journalsDir)
  } catch {
    return false
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    try {
      const text = await fsp.readFile(path.join(journalsDir, name), 'utf8')
      if (text.includes(`会话：${sessionId}`)) return true
    } catch {
      // 读不到就跳过
    }
  }
  return false
}

/**
 * journal 目录里是否已有「这次会话 + 这个窗口」的补记（§8.8 去重）。
 *
 * 去重键是 (sessionId, windowStart)：同一个会话崩溃重启多少次，就有多少个独立窗口，
 * 每个窗口都该留一篇补记。只看 sessionId 会把后续的崩溃全部吞掉。
 *
 * @param {string} journalsDir
 * @param {string} sessionId
 * @param {string|null} windowStart
 */
export async function journalHasWindow(journalsDir, sessionId, windowStart) {
  if (!windowStart) return false
  let names = []
  try {
    names = await fsp.readdir(journalsDir)
  } catch {
    return false
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    try {
      const text = await fsp.readFile(path.join(journalsDir, name), 'utf8')
      if (!text.includes(`会话：${sessionId}`)) continue
      const match = text.match(/时间窗口：上次 (.*?) →/)
      if (match && match[1] === windowStart) return true
    } catch {
      // 读不到就跳过
    }
  }
  return false
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
