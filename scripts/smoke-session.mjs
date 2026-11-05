/**
 * 会话级冒烟：首次基线 → 变更 → 收尾写 journal → 重启判定。
 *
 * 跑法：node scripts/smoke-session.mjs
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createContext } from '../lib/context.js'
import { resolveConfig } from '../lib/config.js'
import { AuditWriter } from '../lib/audit.js'
import { runStartup, runSessionEnd } from '../lib/runtime.js'
import { readSnapshot } from '../lib/snapshot.js'

const checks = []
async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error) })
  }
}

/** @param {string} root */
async function makeRuntime(root, sessionId, settings = { selfScan: { scope: 'self' } }) {
  const ctx = createContext(root)
  const { values } = resolveConfig(settings)
  const writer = new AuditWriter({ root, config: values })
  const startup = await runStartup({
    ctx,
    writer,
    config: values,
    pluginVersion: '0.2.0',
    sessionId,
    sessionIdSource: 'host',
  })
  return { ctx, config: values, writer, startup }
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-session-'))

  let first
  await check('首次启动：建九档顶层、判定为 first、尚未建基线', async () => {
    first = await makeRuntime(root, 'sess-1')
    assert.equal(first.startup.ok, true)
    assert.equal(first.startup.judgement.verdict, 'first')
    // §11.5 首次创建 / §10.4 重建空档：只 mkdir，九档顶层都要在
    for (const key of ['handoff', 'created', 'downloads', 'incoming', 'scratch', 'archive', 'logs', 'config', 'self']) {
      const st = await fsp.stat(path.join(root, key))
      assert.ok(st.isDirectory(), `${key} 应已创建`)
    }
    // 版本指针与审计可能先建好 config/logs，所以只断言「至少重建了 7 个」
    assert.ok(first.startup.recreatedBuckets.length >= 7, `重建数：${first.startup.recreatedBuckets.length}`)
    const { snapshot } = await readSnapshot(first.ctx.snapshotFile)
    assert.ok(!snapshot?.baselineEstablished, '基线要等第一次收尾才建')
  })

  await check('首次收尾：建基线，不写 journal、不写 sessionEnd', async () => {
    const result = await runSessionEnd({
      ctx: first.ctx,
      writer: first.writer,
      config: first.config,
      runtimeState: first.startup.runtimeState,
      index: first.startup.index,
    })
    assert.equal(result.journalWritten, false)
    assert.equal(result.firstRun, true)
    const { snapshot } = await readSnapshot(first.ctx.snapshotFile)
    assert.equal(snapshot.baselineEstablished, true)
    assert.ok(!snapshot.sessionEnd, '首次收尾不该写 sessionEnd')
  })

  await check('self/ 里写文件后收尾 → 生成 journal', async () => {
    await fsp.mkdir(path.join(root, 'self', 'notes'), { recursive: true })
    await fsp.writeFile(path.join(root, 'self', 'notes', 'a.md'), '# 记一笔\n', 'utf8')

    const second = await makeRuntime(root, 'sess-2')
    assert.equal(second.startup.judgement.verdict, 'normal', JSON.stringify(second.startup.judgement))

    const result = await runSessionEnd({
      ctx: second.ctx,
      writer: second.writer,
      config: second.config,
      runtimeState: second.startup.runtimeState,
      index: second.startup.index,
    })
    assert.equal(result.journalWritten, true, JSON.stringify(result.warnings))
    assert.ok(result.journalRef?.startsWith('handoff/self/journals/'))

    const text = await fsp.readFile(path.join(root, result.journalRef), 'utf8')
    assert.match(text, /# \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    assert.match(text, /新增 1/)
    // §7.2 模板要的是「self 下相对路径」，不含 self/ 前缀
    assert.match(text, /新增 notes\/a\.md/)
  })

  await check('收尾后快照有 sessionEnd 且 index 记了 journal', async () => {
    const { snapshot } = await readSnapshot(path.join(root, 'config', 'plugins', 'tongwen-tonggui', 'self-snapshot.json'))
    assert.equal(snapshot.sessionEnd?.sessionId, 'sess-2')
    assert.equal(snapshot.sessionEnd?.zeroChange, false)

    const index = JSON.parse(await fsp.readFile(path.join(root, 'handoff', 'index.machine.json'), 'utf8'))
    assert.ok(index.entries.some((entry) => entry.kind === 'journal'))
  })

  await check('零变更会话：不写 journal，但仍写 sessionEnd', async () => {
    const third = await makeRuntime(root, 'sess-3')
    const result = await runSessionEnd({
      ctx: third.ctx,
      writer: third.writer,
      config: third.config,
      runtimeState: third.startup.runtimeState,
      index: third.startup.index,
    })
    assert.equal(result.journalWritten, false)
    const { snapshot } = await readSnapshot(third.ctx.snapshotFile)
    assert.equal(snapshot.sessionEnd?.sessionId, 'sess-3')
    assert.equal(snapshot.sessionEnd?.zeroChange, true)
  })

  await check('删除 self/ 文件后收尾 → 记「消失」', async () => {
    await fsp.rm(path.join(root, 'self', 'notes', 'a.md'))
    const fourth = await makeRuntime(root, 'sess-4')
    const result = await runSessionEnd({
      ctx: fourth.ctx,
      writer: fourth.writer,
      config: fourth.config,
      runtimeState: fourth.startup.runtimeState,
      index: fourth.startup.index,
    })
    assert.equal(result.journalWritten, true)
    const text = await fsp.readFile(path.join(root, result.journalRef), 'utf8')
    assert.match(text, /消失 1/)
  })

  await check('异常中断（RS 停在 active）→ 下次启动判定异常，补记窗口不塌', async () => {
    const fifth = await makeRuntime(root, 'sess-5')
    // 不调 runSessionEnd，模拟进程被杀；直接再启动。
    // 被杀前若有过一次心跳，补记窗口应取到最后心跳，而不是 startedAt → startedAt。
    const rsRaw = JSON.parse(await fsp.readFile(fifth.ctx.runtimeStateFile, 'utf8'))
    rsRaw.lastHeartbeatAt = new Date(Date.parse(rsRaw.startedAt) + 90_000).toISOString()
    await fsp.writeFile(fifth.ctx.runtimeStateFile, JSON.stringify(rsRaw, null, 2), 'utf8')

    const sixth = await makeRuntime(root, 'sess-6')
    assert.equal(sixth.startup.judgement.verdict, 'abnormal')
    assert.ok(sixth.startup.backfill)

    const journals = await fsp.readdir(path.join(root, 'handoff', 'self', 'journals'))
    const names = []
    for (const name of journals) {
      const text = await fsp.readFile(path.join(root, 'handoff', 'self', 'journals', name), 'utf8')
      if (text.includes('sess-5')) names.push(text)
    }
    assert.equal(names.length, 1, '应有且只有一篇 sess-5 的补记')
    const match = names[0].match(/时间窗口：上次 (\S+) → 本次 (\S+)/)
    assert.ok(match, '补记里要有时间窗口行')
    assert.notEqual(match[1], match[2], '窗口不能塌成同一时刻')
  })

  await check('九档顶层建出来后仍是空档，没有二级目录被预建', async () => {
    const dirs = new Set(await fsp.readdir(root))
    for (const key of ['handoff', 'created', 'downloads', 'incoming', 'scratch', 'archive', 'logs', 'config', 'self']) {
      assert.ok(dirs.has(key), `${key} 应存在`)
    }
    // self/ 是留给用户/其它插件的（这一轮测试自己往里面写过东西），只看其余空档
    for (const key of ['created', 'downloads', 'incoming', 'scratch']) {
      const inner = await fsp.readdir(path.join(root, key))
      assert.deepEqual(inner, [], `${key} 下不该预建任何东西`)
    }
  })

  await check('升级后版本指针同步到当前版本（2026-11-01 回归）', async () => {
    const upgradeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-upgrade-'))
    try {
      const ctx = createContext(upgradeRoot)
      const { values } = resolveConfig({})
      const writer = new AuditWriter({ root: upgradeRoot, config: values })
      const install = await runStartup({
        ctx,
        writer,
        config: values,
        pluginVersion: '0.3.0',
        sessionId: 'sess-up-1',
        sessionIdSource: 'host',
      })
      assert.equal(install.ok, true)
      const auditDir = path.join(upgradeRoot, 'logs', 'audit')
      const auditNames = await fsp.readdir(auditDir)
      let auditText = ''
      for (const name of auditNames) auditText += await fsp.readFile(path.join(auditDir, name), 'utf8')
      assert.match(auditText, /startup\.source/, '启动审计应记录实际加载路径')
      const before = JSON.parse(await fsp.readFile(ctx.currentFile, 'utf8'))
      assert.equal(before.version, '0.3.0')
      const upgrade = await runStartup({
        ctx,
        writer,
        config: values,
        pluginVersion: '0.3.1',
        sessionId: 'sess-up-2',
        sessionIdSource: 'host',
      })
      assert.equal(upgrade.ok, true)
      const after = JSON.parse(await fsp.readFile(ctx.currentFile, 'utf8'))
      assert.equal(after.version, '0.3.1', '版本指针应同步到 0.3.1')
      assert.equal(after.structureVersion, '9档-v1')
      assert.ok(after.installedAt, 'installedAt 应保留')
      assert.ok(after.upgradedAt, '应记录 upgradedAt')
    } finally {
      await fsp.rm(upgradeRoot, { recursive: true, force: true })
    }
  })

  await check('同一会话反复崩溃：每个窗口各补一篇，不被会话 ID 去重吞掉（2026-11-01 回归）', async () => {
    const crashRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-crash-'))
    try {
      const first = await makeRuntime(crashRoot, 'sess-crash')
      assert.equal(first.startup.ok, true)
      await fsp.writeFile(path.join(crashRoot, 'self', 'note.md'), '# note\n')

      const second = await makeRuntime(crashRoot, 'sess-crash')
      assert.equal(second.startup.ok, true)
      assert.ok(second.startup.backfill?.written, '第一次崩溃应有补记')

      // 模拟第二次崩溃：状态回到 active，窗口起点换成一个不同的时间
      const rsPath = second.ctx.runtimeStateFile
      const rs = JSON.parse(await fsp.readFile(rsPath, 'utf8'))
      rs.status = 'active'
      rs.startedAt = '2026-11-01T00:00:00.000Z'
      rs.lastHeartbeatAt = '2026-11-01T00:05:00.000Z'
      rs.endedAt = null
      await fsp.writeFile(rsPath, JSON.stringify(rs, null, 2))

      const third = await makeRuntime(crashRoot, 'sess-crash')
      assert.equal(third.startup.ok, true)
      assert.ok(third.startup.backfill?.written, '第二个窗口也要补一篇')

      const dir = path.join(crashRoot, 'handoff', 'self', 'journals')
      const names = await fsp.readdir(dir)
      let count = 0
      for (const name of names) {
        const text = await fsp.readFile(path.join(dir, name), 'utf8')
        if (text.includes('会话：sess-crash')) count += 1
      }
      assert.equal(count, 2, `应有 2 篇 sess-crash 补记，实际 ${count}`)
    } finally {
      await fsp.rm(crashRoot, { recursive: true, force: true })
    }
  })

  await check('崩溃补记带上未完成任务（2026-11-01 回归）', async () => {
    const taskRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-task-'))
    try {
      const first = await makeRuntime(taskRoot, 'sess-task')
      assert.equal(first.startup.ok, true)
      const rsPath = first.ctx.runtimeStateFile
      const rs = JSON.parse(await fsp.readFile(rsPath, 'utf8'))
      rs.status = 'active'
      rs.startedAt = '2026-11-01T01:00:00.000Z'
      rs.lastHeartbeatAt = '2026-11-01T01:10:00.000Z'
      rs.currentTask = {
        instance: 'accept-x',
        bucket: 'logs',
        typeSlug: 'type-x',
        typeDisplayName: '接手验收',
        taskId: 'accept-x',
        purpose: '验一下补记带任务',
        startedAt: '2026-11-01T01:01:00.000Z',
      }
      await fsp.writeFile(rsPath, JSON.stringify(rs, null, 2))

      const second = await makeRuntime(taskRoot, 'sess-task')
      assert.equal(second.startup.ok, true)
      const dir = path.join(taskRoot, 'handoff', 'self', 'journals')
      const names = await fsp.readdir(dir)
      let found = null
      for (const name of names) {
        const text = await fsp.readFile(path.join(dir, name), 'utf8')
        if (text.includes('未完成任务：accept-x')) found = text
      }
      assert.ok(found, '补记里应写出未完成任务')
      assert.ok(found.includes('接手验收'), '应带类型名')
      assert.ok(found.includes('验一下补记带任务'), '应带目标')
    } finally {
      await fsp.rm(taskRoot, { recursive: true, force: true })
    }
  })

  await check('同一会话异常重启：currentTask 带回新运行态（2026-11-01 回归）', async () => {
    const keepRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-keep-'))
    try {
      const firstRun = await makeRuntime(keepRoot, 'sess-keep')
      assert.equal(firstRun.startup.ok, true)
      const rsPath = firstRun.ctx.runtimeStateFile
      const rs = JSON.parse(await fsp.readFile(rsPath, 'utf8'))
      rs.status = 'active'
      rs.startedAt = '2026-11-01T02:00:00.000Z'
      rs.lastHeartbeatAt = '2026-11-01T02:10:00.000Z'
      rs.currentTask = {
        instance: 'task-keep',
        bucket: 'logs',
        typeSlug: 'type-keep',
        typeDisplayName: '重启续任务',
        taskId: 'task-keep',
        purpose: '重启后还能归档',
        startedAt: '2026-11-01T02:01:00.000Z',
      }
      await fsp.writeFile(rsPath, JSON.stringify(rs, null, 2))

      const secondRun = await makeRuntime(keepRoot, 'sess-keep')
      assert.equal(secondRun.startup.ok, true)
      assert.equal(
        secondRun.startup.runtimeState?.currentTask?.instance,
        'task-keep',
        '同一会话重启后任务上下文应带回',
      )
      const after = JSON.parse(await fsp.readFile(rsPath, 'utf8'))
      assert.equal(after.currentTask?.instance, 'task-keep', '新运行态也应落盘 currentTask')
    } finally {
      await fsp.rm(keepRoot, { recursive: true, force: true })
    }
  })

  await check('统计范围 handoff：改交接区文件也会进补记（0.3.7 回归）', async () => {
    const scopeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-scope-'))
    const handoffCfg = { selfScan: { scope: 'handoff' } }
    try {
      const first = await makeRuntime(scopeRoot, 'sess-scope-1', handoffCfg)
      assert.equal(first.startup.ok, true)
      const base = await runSessionEnd({
        ctx: first.ctx,
        writer: first.writer,
        config: first.config,
        runtimeState: first.startup.runtimeState,
        index: first.startup.index,
      })
      assert.equal(base.firstRun, true)
      assert.equal(base.scope, 'handoff')

      // 动 handoff/ 里的文件（不是 self/）
      await fsp.mkdir(path.join(scopeRoot, 'handoff', 'projects'), { recursive: true })
      await fsp.writeFile(path.join(scopeRoot, 'handoff', 'projects', 'p.md'), '# 项目\n', 'utf8')

      const second = await makeRuntime(scopeRoot, 'sess-scope-2', handoffCfg)
      const result = await runSessionEnd({
        ctx: second.ctx,
        writer: second.writer,
        config: second.config,
        runtimeState: second.startup.runtimeState,
        index: second.startup.index,
      })
      assert.equal(result.journalWritten, true, JSON.stringify(result.warnings))
      const text = await fsp.readFile(path.join(scopeRoot, result.journalRef), 'utf8')
      assert.match(text, /统计范围：handoff\//)
      assert.match(text, /新增 1/)
      assert.match(text, /新增 projects\/p\.md/)

      // 切回 self/：应重建基线而不是硬比出假差异
      const third = await makeRuntime(scopeRoot, 'sess-scope-3', { selfScan: { scope: 'self' } })
      const switched = await runSessionEnd({
        ctx: third.ctx,
        writer: third.writer,
        config: third.config,
        runtimeState: third.startup.runtimeState,
        index: third.startup.index,
      })
      assert.equal(switched.journalWritten, false, '范围切换这一轮不写 journal')
      assert.equal(switched.scopeRebaselined, true)
      assert.equal(switched.scope, 'self')
      const { snapshot } = await readSnapshot(third.ctx.snapshotFile)
      assert.equal(snapshot.scope, 'self')
    } finally {
      await fsp.rm(scopeRoot, { recursive: true, force: true })
    }
  })

  const failed = checks.filter((item) => !item.ok)
  for (const item of checks) {
    console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.ok ? '' : ` — ${item.error}`}`)
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length > 0) {
    console.log(`\n临时目录保留以便排查：${root}`)
    process.exitCode = 1
  } else {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
