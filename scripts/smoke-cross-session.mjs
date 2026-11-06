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

  await check('注册了 21 个工具（9 旧 + 8 新 + 2 器官 + 重启广播 + focus_context）', () => {
    assert.equal(registered.size, 21)
    for (const name of ['project_upsert', 'project_read', 'project_list', 'inbox_send', 'inbox_list', 'inbox_close', 'restart_dsh']) {
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
    assert.match(text, /给你的请求：/)
    // 开场每轮都带（不赌宿主时序，新会话才不会白跑）
    assert.match(text, /开场（每轮都带/)
    assert.match(text, /③ 读 handoff\/README\.md/, '开场第三步要读总目录（0.5.3 起是 ③，不再是 ⓪）')
    assert.match(text, /挂账/, '开场没先把挂账顶到第一眼')
    assert.match(text, /handoff\/能力目录\.md/, '开场没提醒先看能力目录')
    assert.match(text, /handoff\/项目总览\.md/, '开场没提醒接活前先看项目总览')
    assert.match(text, /handoff\/索引\/交接索引\.md/, '开场没提醒查旧交接先看交接索引')
    assert.match(text, /当前交接/, '开场没写「认领项目 → 读它那一份当前交接」')
    assert.match(text, /我是来接哪个项目的/, '开场没写「对不出来就问人」')
    assert.match(text, /self\/日档\//, '开场没提醒收尾写日档')
    assert.match(text, /不要逐个打开/)
    // 根目录不许写死：开场和现状都要按运行时配置写出来
    assert.match(text, /交接根目录：/)
    assert.ok(text.includes(root), '开场没写当前交接根目录')
    assert.match(text, /别在别处翻旧交接/)
    // 0.4.6：重启只有一条对的路——先回话，再用包装脚本排 30 秒；直接跑 restart-dsh.ps1 会杀掉自己
    assert.match(text, /restart-dsh-later\.ps1/, '现状里没写延时重启包装脚本')
    assert.match(text, /手册[\\/]重启\.md/, '现状里没指到重启规范页')
    assert.match(text, /不要直接跑 restart-dsh\.ps1/, '现状没警告不要直接杀自己')
    // 0.5.0：三层信息 —— 规矩 → 现在 → 目录；重启先广播
    assert.match(text, /三层/, '开场没写三层信息')
    assert.match(text, /手册总览\.md/, '开场没把手册版排在第一位')
    assert.match(text, /动态白板\.md/, '开场没让看动态白板')
    assert.match(text, /restart_dsh/, '现状里没写重启广播工具')
    // 三层顺序：手册 → 现在 → 目录（只看「三层信息」那一行，别被开场第 ⓪ 步的 README 干扰）
    const layerLine = text.split('\n').find((line) => line.includes('三层信息')) ?? ''
    assert.match(layerLine, /手册总览\.md/, '三层行里没有手册总览')
    assert.match(layerLine, /动态白板\.md/, '三层行里没有动态白板')
    assert.match(layerLine, /README\.md/, '三层行里没有总目录')
    assert.ok(layerLine.indexOf('手册总览.md') < layerLine.indexOf('动态白板.md'), '手册版要排在动态白板前面')
    assert.ok(layerLine.indexOf('动态白板.md') < layerLine.indexOf('README.md'), '动态白板要排在总目录前面')
    // 0.5.3：读序写死——权重 规矩 100 ＞ 现在 90 ＞ 目录 80，且①必须排在②③前面、不许再让 README 抢第一步
    assert.match(text, /读序不许倒/, '开场没写「读序不许倒」')
    assert.match(text, /100/, '开场没写板块权重')
    assert.match(text, /第一件事只有一件/, '开场没把「第一件事只有一件（读规矩）」写清楚')
    const normsIdx = text.indexOf(`① 读 **handoff/手册总览.md**`)
    const dynIdx = text.indexOf(`② 读 **handoff/动态白板.md**`)
    assert.ok(normsIdx > 0 && dynIdx > normsIdx, '开场里 ① 手册总览必须排在 ② 动态白板之前')
    assert.ok(!/⓪ 先看 handoff\/README\.md/.test(text), '0.5.3 起不许再让 README 抢第一步（⓪ 已删）')
    const textAfter = contexts[0].text()
    assert.match(textAfter, /开场（每轮都带/, '开场不该只出现一次')
  })

  await check('新会话照样拿到开场（每轮都带，不靠 session/created 时序）', async () => {
    const created = handlers.get('session/created')
    assert.ok(created, '没有注册 session/created')
    await created({ id: 'sess-second-probe' })
    const text = contexts[0].text()
    assert.match(text, /开场（每轮都带/, '新会话没拿到开场五步')
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

