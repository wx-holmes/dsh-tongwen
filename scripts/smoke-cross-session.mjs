/**
 * 跨会话同步冒烟：项目白板 + 请求信箱 + 开场简报 + 任务串接。
 *
 * 跑法：node scripts/smoke-cross-session.mjs
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

const checks = []
/** @param {string} name @param {() => void | Promise<void>} fn */
async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error) })
  }
}

/** 假 ctx：只要能注册工具、拿到注入条目、屏蔽定时器就够了。 */
function createFakeCtx() {
  const registered = new Map()
  const contexts = []
  const handlers = new Map()
  return {
    registered,
    contexts,
    handlers,
    ctx: {
      tools: {
        register(spec) {
          registered.set(spec.name, spec)
          return () => registered.delete(spec.name)
        },
      },
      systemPrompt: {
        context(entry) {
          contexts.push(entry)
          return () => {}
        },
        section() {
          return () => {}
        },
      },
      on(name, fn) {
        handlers.set(name, fn)
        return () => handlers.delete(name)
      },
      timer: {
        interval() {
          return () => {}
        },
      },
    },
  }
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-peer-'))
  const { ctx, registered, contexts, handlers } = createFakeCtx()
  const dispose = apply(ctx, { root })

  /** @param {string} name @param {object} args */
  const call = async (name, args = {}) => {
    const spec = registered.get(name)
    assert.ok(spec, `没有注册 ${name}`)
    return spec.execute(args)
  }

  await check('注册了 23 个工具（9 旧 + 8 新 + 2 器官 + 重启广播 + focus_context + space_list）', () => {
    assert.equal(registered.size, 23)
    for (const name of ['project_upsert', 'project_read', 'project_list', 'inbox_send', 'inbox_list', 'inbox_close', 'restart_dsh', 'focus_context', 'space_list', 'space_register']) {
      assert.ok(registered.has(name), `缺少工具 ${name}`)
    }
    for (const name of ['locate', 'inspect_handoff', 'list_handoffs', 'update_handoff', 'begin_task', 'end_task', 'heartbeat', 'restore', 'archive_handoff']) {
      assert.ok(registered.has(name), `旧工具丢了 ${name}`)
    }
  })

  await check('project_upsert 建出白板文件', async () => {
    const value = await call('project_upsert', {
      id: 'smoke-project',
      title: '冒烟项目',
      goal: '验证跨会话联通',
      todo: ['第一步', '第二步'],
    })
    assert.equal(value.ok, true, value.message)
    assert.equal(value.id, 'smoke-project')
    assert.equal(value.created, true)
    assert.equal(value.todoCount, 2)

    const raw = await fsp.readFile(path.join(root, 'handoff', 'projects', 'smoke-project.md'), 'utf8')
    assert.match(raw, /## 目标/)
    assert.match(raw, /## 当前一棒/)
    assert.match(raw, /## 决定（只追加）/)
  })

  await check('project_upsert 第二次是合并不是重建', async () => {
    const value = await call('project_upsert', { id: 'smoke-project', title: '冒烟项目（改名）' })
    assert.equal(value.ok, true, value.message)
    assert.equal(value.created, false)
    assert.equal(value.title, '冒烟项目（改名）')
  })

  await check('project_read 读回六节', async () => {
    const value = await call('project_read', { id: 'smoke-project' })
    assert.equal(value.ok, true, value.message)
    assert.equal(value.exists, true)
    assert.equal(value.structured.title, '冒烟项目（改名）')
    assert.deepEqual(value.structured.todo, ['第一步', '第二步'])
  })

  await check('project_list 列出项目', async () => {
    const value = await call('project_list', {})
    assert.equal(value.ok, true, value.message)
    assert.equal(value.total, 1)
    assert.equal(value.items[0].id, 'smoke-project')
  })

  let broadcast = null
  await check('inbox_send 发广播', async () => {
    const value = await call('inbox_send', { to: 'any', request: '盘里有没有重复文件' })
    assert.equal(value.ok, true, value.message)
    assert.ok(value.item.id.startsWith('ib_'))
    broadcast = value.item
  })

  await check('inbox_list mine 能看到广播', async () => {
    const value = await call('inbox_list', { mine: true })
    assert.equal(value.ok, true, value.message)
    assert.ok(value.items.some((item) => item.id === broadcast.id), '广播没出现在自己的信箱里')
  })

  await check('定向请求别人看不到', async () => {
    const value = await call('inbox_send', { to: 'session-someone-else', request: '这条只给另一个会话' })
    assert.equal(value.ok, true, value.message)
    const mine = await call('inbox_list', { mine: true })
    assert.equal(
      mine.items.some((item) => item.id === value.item.id),
      false,
      '定向请求串到别人信箱了',
    )
  })

  await check('inbox_close 关掉广播后自己信箱里没有它', async () => {
    const closed = await call('inbox_close', { id: broadcast.id })
    assert.equal(closed.ok, true, closed.message)
    const mine = await call('inbox_list', { mine: true })
    assert.equal(mine.items.some((item) => item.id === broadcast.id), false)
  })

  await check('重复 close 不炸', async () => {
    const again = await call('inbox_close', { id: broadcast.id })
    assert.equal(again.ok, true, again.message)
    assert.equal(again.alreadyClosed, true)
  })

  await check('begin_task 挂项目，end_task 排下一棒', async () => {
    const begun = await call('begin_task', {
      bucket: 'created',
      typeDisplayName: '冒烟互通',
      instance: 'peer-task',
      displayName: '互通任务',
      purpose: '验证跨会话串接',
      project: 'smoke-project',
    })
    assert.equal(begun.ok, true, begun.message)

    await fsp.mkdir(path.join(root, 'created', 'peer-task'), { recursive: true })
    await fsp.writeFile(path.join(root, 'created', 'peer-task', 'note.md'), '# note\n', 'utf8')

    const ended = await call('end_task', {
      status: 'done',
      artifacts: [{ path: 'created/peer-task/note.md', type: 'file' }],
      goal: '验证跨会话串接',
      next: [{ to: 'any', request: '接手的人看一眼 note.md' }],
    })
    assert.equal(ended.ok, true, ended.message)
    assert.ok(Array.isArray(ended.inboxIds), '没有返回 inboxIds')
    assert.equal(ended.inboxIds.length, 1)

    const board = await call('project_read', { id: 'smoke-project' })
    assert.equal(board.ok, true, board.message)
    assert.equal(board.structured.baton.to, 'any')
    assert.match(board.structured.baton.action, /note\.md/)
    assert.ok(board.structured.decisions.length >= 1, '白板没记下完成这件事')
    assert.ok(
      board.structured.participants.some((line) => line.includes('peer-task')),
      '白板没登记参与的会话',
    )
  })

  await check('项目 id 不合法会被挡住', async () => {
    const value = await call('project_upsert', { id: '中文项目名', title: '中文' })
    assert.equal(value.ok, false)
    assert.ok(['E_VALIDATION_BLOCKING', 'E_NOT_FOUND'].includes(value.errorCode), String(value.errorCode))
  })

  await check('primer 里能看到项目和请求', async () => {
    assert.ok(contexts.length >= 1, '没有注册注入条目')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const text = contexts[0].text()
    assert.equal(typeof text, 'string')
    assert.match(text, /书同文车同轨/)
    assert.match(text, /项目：/)
    // 0.5.45：简报只数「需要你决定的」，通知类不占配额。
    assert.match(text, /需要你决定的：/)
    // 0.5.30 开场减重：只留读序/定位/交接/边界，细节交给 focus_context
    assert.match(text, /每轮都带/)
    // 0.5.49：开场已改成「先读能力卡 + focus_context 按任务取」，不再写死三步读序\n    assert.match(text, /先读.*handoff\/能力卡\.md/, '开场要先读能力卡（0.5.30 减重）')
    assert.match(text, /focus_context\{task:/, '开场要让人先定位（细节不再每轮播报）')
    assert.match(text, /时空边界/, '开场要带边界（0.5.30）')
    assert.match(text, /挂账/, '开场没写挂账')
    assert.match(text, /现状：/, '开场要带「现状」一段（当前一棒/挂账在里头）')
    assert.match(text, /收尾|清帐/, '开场要提收尾（日档细节交给交接规范）')
    // 根目录不许写死：开场按运行时配置写出来
    assert.match(text, /交接根目录：/)
    assert.ok(text.includes(root), '开场没写当前交接根目录')
    // 0.4.6 / 0.5.30：重启只有一条对的路——restart_dsh(action=arm)，细则在手册
    assert.match(text, /restart_dsh/, '现状里没写重启广播工具')
    assert.match(text, /手册[\\/]重启\.md/, '现状里没指到重启规范页')
    // 0.5.0 三层信息：规矩 → 现在 → 目录（0.5.30 起压成一行读序）
    assert.match(text, /handoff\/手册总览\.md/, '开场要指到手册索引（0.5.30 起压成一行）')
    // 0.5.49：开场不再编号，改成「先读能力卡 → 规矩按任务取 → 现在看动态白板 → 目录看 README」
    assert.match(text, /handoff\/动态白板\.md/, '开场没让看动态白板')
    assert.match(text, /handoff\/README\.md/, '开场没让看总目录')
    const capIdx = text.indexOf('handoff/能力卡.md')
    const dynIdx = text.indexOf('handoff/动态白板.md')
    assert.ok(capIdx > 0 && dynIdx > capIdx, '开场里能力卡必须排在动态白板之前')
    assert.ok(!/⓪ 先看 handoff\/README\.md/.test(text), '0.5.3 起不许再让 README 抢第一步（⓪ 已删）')
    const textAfter = contexts[0].text()
    assert.match(textAfter, /每轮都带/, '开场不该只出现一次')
  })

  await check('新会话照样拿到开场（每轮都带，不靠 session/created 时序）', async () => {
    const created = handlers.get('session/created')
    assert.ok(created, '没有注册 session/created')
    await created({ id: 'sess-second-probe' })
    const text = contexts[0].text()
    assert.match(text, /每轮都带/, '新会话没拿到开场（0.5.30 减重版）')
    assert.ok(text.includes(root), '新会话开场没带根目录')
    assert.match(text, /交接根目录：/)
  })

  await check('九档顶层建出来了', async () => {
    for (const bucket of ['handoff', 'created', 'downloads', 'incoming', 'scratch', 'archive', 'logs', 'config', 'self']) {
      const stat = await fsp.stat(path.join(root, bucket))
      assert.ok(stat.isDirectory(), `缺少档位 ${bucket}`)
    }
  })

  await new Promise((resolve) => setTimeout(resolve, 50))
  await dispose()

  const failed = checks.filter((item) => !item.ok)
  for (const item of checks) {
    if (item.ok) console.log(`  ok  ${item.name}`)
    else console.log(`  FAIL ${item.name}\n       ${item.error}`)
  }
  console.log(`\n通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项。`)
  await fsp.rm(root, { recursive: true, force: true })
  if (failed.length > 0) process.exitCode = 1
}

await main()


