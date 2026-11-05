/**
 * 端到端冒烟：用假 ctx 起插件，在临时目录里跑一遍完整任务流程。
 *
 * 跑法：node scripts/smoke-tools.mjs
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { ulid } from '../lib/ulid.js'

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

/**
 * @param {Record<string, any>} root
 */
function createFakeCtx() {
  const registered = new Map()
  const contexts = []
  return {
    registered,
    contexts,
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
      on() {
        return () => {}
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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-smoke-'))
  const { ctx, registered, contexts } = createFakeCtx()

  const dispose = apply(ctx, { root })

  await check('注册了 19 个工具', () => {
    assert.equal(registered.size, 19)
    for (const name of ['locate', 'inspect_handoff', 'list_handoffs', 'update_handoff', 'begin_task', 'end_task', 'heartbeat', 'restore', 'archive_handoff', 'rollback_data', 'housekeeping_report', 'project_upsert', 'project_read', 'project_list', 'inbox_send', 'inbox_list', 'inbox_close', 'organ_list', 'organ_call']) {
      assert.ok(registered.has(name), `缺少工具 ${name}`)
    }
  })

  /** @param {string} name @param {object} args */
  const call = async (name, args = {}) => {
    const spec = registered.get(name)
    assert.ok(spec, `没有注册 ${name}`)
    return spec.execute(args)
  }

  await call('heartbeat')
  await check('heartbeat 返回 lastHeartbeatAt', async () => {
    const value = await call('heartbeat')
    assert.equal(value.ok, true)
    assert.ok(value.lastHeartbeatAt)
  })

  let beginResult = null
  await check('begin_task 需要显式 bucket', async () => {
    const bad = await call('begin_task', { typeDisplayName: '测试类型' })
    assert.equal(bad.ok, false)
    assert.equal(bad.errorCode, 'E_VALIDATION_BLOCKING')
  })

  await check('begin_task 成功并返回幂等键', async () => {
    beginResult = await call('begin_task', {
      bucket: 'created',
      typeDisplayName: '冒烟测试',
      instance: 'smoke-one',
      displayName: '冒烟一号',
      purpose: '验证任务登记',
    })
    assert.equal(beginResult.ok, true, beginResult.message)
    assert.ok(beginResult.effectiveTaskKey)
    assert.equal(beginResult.idempotency, 'weak')
  })

  const artifactPath = 'created/smoke-one/hello.txt'
  await fsp.mkdir(path.join(root, 'created', 'smoke-one'), { recursive: true })
  await fsp.writeFile(path.join(root, 'created', 'smoke-one', 'hello.txt'), 'hello tongwen\n', 'utf8')

  let endResult = null
  await check('end_task 写出双份交接', async () => {
    endResult = await call('end_task', {
      status: 'done',
      artifacts: [{ path: artifactPath, type: 'file' }],
      goal: '验证双份交接与产物登记',
      done: ['写了一个 hello.txt'],
      direction: '按规格做冒烟',
      directionReason: '第一轮冒烟',
      facts: [{ text: '工具都注册上了', source: '本脚本' }],
      assumptions: ['这条是假设'],
      readFirst: ['先看产物清单'],
      attempts: 2,
      factsCited: 3,
      factsWrong: 0,
    })
    assert.equal(endResult.ok, true, endResult.message)
    assert.ok(endResult.entryId)

    const machine = path.join(root, 'handoff', '冒烟测试'.toLowerCase(), 'smoke-one.machine.md')
    assert.ok(endResult.artifacts.length >= 1)
  })

  await check('机器版与用户版交接同时存在', async () => {
    const machineFile = path.join(root, endResult.machineHandoff)
    const userFile = path.join(root, endResult.userHandoff)
    const machineText = await fsp.readFile(machineFile, 'utf8')
    const userText = await fsp.readFile(userFile, 'utf8')
    assert.match(machineText, /^## 1\. 身份/m)
    assert.match(machineText, /^## 6\. 建议入口/m)
    assert.match(userText, /^## 5\. 别当真/m)
    assert.ok(!/sha256|SHA-256/.test(userText), '用户版不该出现哈希')
  })

  await check('产物行带存在性与 hashStatus', async () => {
    const machineText = await fsp.readFile(path.join(root, endResult.machineHandoff), 'utf8')
    const line = machineText.split('\n').find((item) => item.includes('created/smoke-one/hello.txt'))
    assert.ok(line, '没找到产物行')
    assert.match(line, /｜\s*file\s*｜/)
    assert.match(line, /｜\s*yes\s*｜/)
    assert.match(line, /｜\s*ok\s*｜/)
  })

  await check('0.4.7 自评落进账本 self-reports.jsonl', async () => {
    const file = path.join(root, 'logs', '账本', 'data', 'self-reports.jsonl')
    const text = await fsp.readFile(file, 'utf8')
    const row = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((item) => item.entryId === endResult.entryId)
    assert.ok(row, '没找到自评行')
    assert.equal(row.attempts, 2)
    assert.equal(row.factsCited, 3)
    assert.equal(row.factsWrong, 0)
    assert.equal(row.passed, true)
    assert.ok(row.taskId, '自评行要有 taskId')
  })

  await check('list_handoffs 能看到这个实例', async () => {
    const value = await call('list_handoffs', {})
    assert.equal(value.ok, true)
    assert.ok(value.items.some((item) => item.instance === 'smoke-one'))
  })

  await check('locate 能按实例名命中', async () => {
    const value = await call('locate', { query: 'smoke' })
    assert.equal(value.ok, true)
    assert.ok(value.candidates.length >= 1)
    assert.equal(value.candidates[0].matchReason, 'instance_partial')
  })

  await check('inspect_handoff 能读结构化内容', async () => {
    const value = await call('inspect_handoff', { instance: 'smoke-one' })
    assert.equal(value.ok, true)
    assert.ok(value.structured.identity)
    assert.equal(value.isLatest, true)
  })

  await check('update_handoff 只改允许的节并留版本', async () => {
    const before = await fsp.readFile(path.join(root, endResult.machineHandoff), 'utf8')
    const value = await call('update_handoff', {
      instance: 'smoke-one',
      section: '6. 建议入口',
      content: '- 建议先看：改过的入口',
    })
    assert.equal(value.ok, true, value.message)
    const after = await fsp.readFile(path.join(root, endResult.machineHandoff), 'utf8')
    assert.match(after, /改过的入口/)
    assert.notEqual(before, after)
    assert.equal(value.versionNumber, 1)
  })

  await check('update_handoff 拒绝非白名单节', async () => {
    const value = await call('update_handoff', {
      instance: 'smoke-one',
      section: '1. 身份',
      content: '乱改身份',
    })
    assert.equal(value.ok, false)
    assert.equal(value.errorCode, 'E_VALIDATION_BLOCKING')
  })

  await check('inspect_handoff 越界路径被拒', async () => {
    const value = await call('inspect_handoff', { path: '../outside.md' })
    assert.equal(value.ok, false)
    assert.equal(value.errorCode, 'E_VALIDATION_BLOCKING')
  })

  await check('列表参数传 JSON 字符串也能落进交接（2026-11-01 回归）', async () => {
    const begin = await call('begin_task', {
      bucket: 'created',
      typeDisplayName: '冒烟测试',
      instance: 'smoke-json-list',
      purpose: '验证字符串形式的数组被正确解析',
    })
    assert.equal(begin.ok, true, begin.message)
    const ended = await call('end_task', {
      status: 'done',
      goal: '验证 JSON 字符串形式的列表',
      done: '["甲：处理了字符串列表", "乙：读了一遍交接"]',
      blocked: '["丙：还没做"]',
      readFirst: '["handoff/index.machine.json"]',
      avoid: '["别改身份那一节"]',
    })
    assert.equal(ended.ok, true, ended.message)

    const machineText = await fsp.readFile(path.join(root, ended.machineHandoff), 'utf8')
    assert.match(machineText, /甲：处理了字符串列表/)
    assert.match(machineText, /乙：读了一遍交接/)
    assert.match(machineText, /丙：还没做/)
    assert.match(machineText, /handoff\/index\.machine\.json/)
    assert.match(machineText, /别改身份那一节/)

    const userText = await fsp.readFile(path.join(root, ended.userHandoff), 'utf8')
    assert.match(userText, /甲：处理了字符串列表/)
    assert.ok(!/这次只是建立了记录/.test(userText), '用户版不该再说「没有实质产出」')
  })

  await check('同一实例二次归档不炸（版本清理带 baseName，2026-11-01 回归）', async () => {
    const begin = await call('begin_task', {
      bucket: 'created',
      typeDisplayName: '冒烟测试',
      instance: 'smoke-json-list',
      purpose: '同一实例再归档一次',
    })
    assert.equal(begin.ok, true, begin.message)
    const ended = await call('end_task', {
      status: 'done',
      goal: '再次归档同一个实例',
      done: ['第二轮也写了交接'],
      readFirst: ['archive/versions/smoke-json-list'],
    })
    assert.equal(ended.ok, true, ended.message)
    assert.equal(ended.instance, 'smoke-json-list')
    assert.ok(ended.version.machine >= 1, '第二次归档应该留下机器版备份')
    const machineText = await fsp.readFile(path.join(root, ended.machineHandoff), 'utf8')
    assert.match(machineText, /第二轮也写了交接/)
  })

  await check('归档时先重读索引，不覆盖别的会话写入（2026-11-01 回归）', async () => {
    const begin = await call('begin_task', {
      bucket: 'created',
      typeDisplayName: '冒烟测试',
      instance: 'smoke-index-merge',
      purpose: '索引合并回归',
    })
    assert.equal(begin.ok, true, begin.message)

    const indexFile = path.join(root, 'handoff', 'index.machine.json')
    const before = JSON.parse(await fsp.readFile(indexFile, 'utf8'))
    before.entries.push({
      entryId: ulid(),
      kind: 'instance',
      bucket: 'logs',
      typeSlug: 'type-external',
      instance: 'external-session-entry',
      displayName: '别的会话写进来的',
      status: 'done',
      machineHandoff: null,
      userHandoff: null,
      lastUpdated: '2026-11-01T00:00:00.000Z',
    })
    await fsp.writeFile(indexFile, JSON.stringify(before, null, 2))

    const ended = await call('end_task', {
      status: 'done',
      goal: '索引合并回归',
      done: ['归档时不该冲掉外部记录'],
    })
    assert.equal(ended.ok, true, ended.message)
    const after = JSON.parse(await fsp.readFile(indexFile, 'utf8'))
    assert.ok(
      after.entries.some((entry) => entry.instance === 'external-session-entry'),
      '外部写入的索引条目被覆盖了',
    )
    assert.ok(after.entries.some((entry) => entry.instance === 'smoke-index-merge'), '本次归档条目应写入')
  })

  await check('没有进行中的任务时归档返回 E_NO_TASK（2026-11-01 回归）', async () => {
    const result = await call('end_task', { status: 'done', goal: '不该有任务' })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'E_NO_TASK', result.message)
  })

  await check('系统级注入已注册', () => {
    assert.equal(contexts.length, 1)
    const text = contexts[0].text()
    assert.match(text, /书同文车同轨/)
    assert.match(text, /硬规则/)
  })

  await check('索引文件已生成', async () => {
    const text = await fsp.readFile(path.join(root, 'handoff', 'index.machine.json'), 'utf8')
    const index = JSON.parse(text)
    assert.equal(index.structureVersion, '9档-v1')
    assert.ok(Array.isArray(index.entries))
    assert.ok(index.entries.some((entry) => entry.instance === 'smoke-one'))
  })

  await check('审计目录有内容', async () => {
    const files = await fsp.readdir(path.join(root, 'logs', 'audit'))
    assert.ok(files.length > 0)
  })

  await check('交接总目录：README 按权重排「文件/插件/工具/A盘/在办/清单/已归档」并链到索引页，且明确别全读（0.3.15 回归）', async () => {
    const text = await fsp.readFile(path.join(root, 'handoff', 'README.md'), 'utf8')
    assert.match(text, /交接总目录/)
    assert.match(text, /## 一 · 文件（100）/)
    assert.match(text, /## 二 · 插件（90）/)
    assert.match(text, /## 三 · 工具（80）/)
    assert.match(text, /## 四 · A 盘（70）/)
    assert.match(text, /## 五 · 在办（60）· 当前一棒/)
    assert.match(text, /## 六 · 清单（50）/)
    assert.match(text, /## 七 · 已归档（40）/)
    assert.match(text, /handoff\/索引\/文件目录\.md/, '要链到索引页')
    assert.match(text, /handoff\/教训日记\//, '要写清教训放哪')
    assert.match(text, /handoff\/索引\/教训索引\.md/, '要链到教训索引')
    assert.match(text, /handoff\/plugins\/<插件名>/, '要写清插件现状卡放哪')
    assert.match(text, /当前一棒/)
    assert.match(text, /handoff\/索引\/交接索引\.md/, '要链到交接索引')
    assert.match(text, /\| 时间 \| 内容总结 \| 项目 \| 状态 \| 路径 \|/, '清单要按项目列：时间/内容总结/项目/状态/路径')
    // 每个在办项目下面要挂「当前交接」；这个临时根里可能一个项目板都没有，那就只看「暂无项目」提示
    if (!text.includes('（暂无进行中的项目）')) {
      assert.match(text, /当前交接/, '每个在办项目下面要挂「当前交接」')
    }
    assert.match(text, /别把全部交接读完/)
    assert.match(text, /冒烟一号/, '总目录的清单里应列出这份交接的内容总结')

    // 0.4.5 回归：交接索引顶部要有「按项目看」，认领项目不用扫全表。
    const indexText = await fsp.readFile(path.join(root, 'handoff', '索引', '交接索引.md'), 'utf8')
    assert.match(indexText, /按项目看/, '交接索引要有「按项目看」一节')
    assert.match(indexText, /\| 时间 \| 内容总结 \| 项目 \| 交给 \| 状态 \| 路径 \|/, '交接索引总表要带项目和交给')
    assert.match(text, /别把全部交接读完/)
    assert.match(text, /冒烟一号/, '总目录的清单里应列出这份交接的内容总结')

    // 0.4.4 回归：顶部权重行的挂账数必须和小节同源（以前写死 0，标题 0 / 正文 2）。
    const headerCount = text.match(/按权重排：\*\*⚠ 挂账（(\d+)）/)
    const sectionCount = text.match(/## ⚠ 挂账（(\d+)）·/)
    assert.ok(headerCount, '顶部权重行要带挂账数')
    assert.ok(sectionCount, '要有挂账小节')
    assert.equal(headerCount[1], sectionCount[1], '顶部挂账数要和小节一致')
  })

  await check('项目优先级与做完归档：P 级可见、done 自动搬进 projects/done（0.3.13 回归）', async () => {
    const created = await call('project_upsert', {
      id: 'smoke-proj',
      title: '冒烟项目',
      goal: '验证优先级与归档',
      priority: 'P1',
      to: 'any',
      action: '跑一遍',
      todo: ['第一件', '第二件'],
    })
    assert.equal(created.ok, true, created.message)
    assert.equal(created.priority, 'P1')
    assert.equal(created.archived, false)

    const board = await fsp.readFile(path.join(root, 'handoff', 'projects', 'smoke-proj.md'), 'utf8')
    assert.match(board, /priority: P1/, '头行应记下优先级')

    const listed = await call('project_list')
    const item = listed.items.find((entry) => entry.id === 'smoke-proj')
    assert.ok(item, '列表里应有 smoke-proj')
    assert.equal(item.priority, 'P1')
    assert.equal(item.archived, false)

    const readme = await fsp.readFile(path.join(root, 'handoff', 'README.md'), 'utf8')
    assert.match(readme, /\[P1\] 冒烟项目/, '总目录当前一棒应显示优先级')

    const overview = await fsp.readFile(path.join(root, 'handoff', '项目总览.md'), 'utf8')
    assert.match(overview, /项目总览（第二张对齐图）/, '应生成项目总览')
    assert.match(overview, /\[P1\] 冒烟项目/, '项目总览应显示优先级与项目')
    assert.match(overview, /当前一棒：交给 `any`/, '项目总览应写出当前一棒')
    assert.match(overview, /最近一次交接/, '项目总览要有「最近一次交接」作对照（0.4.4）')
    assert.match(overview, /白板更新/, '白板时间要标成「白板更新」，别让人误当最近活动')

    // 做完 → 自动归档
    const done = await call('project_upsert', { id: 'smoke-proj', status: 'done' })
    assert.equal(done.ok, true, done.message)
    assert.equal(done.archived, true, 'done 后应标 archived')
    assert.match(done.path, /projects\/done\/smoke-proj\.md/)

    let missing = false
    try {
      await fsp.stat(path.join(root, 'handoff', 'projects', 'smoke-proj.md'))
    } catch {
      missing = true
    }
    assert.ok(missing, '归档后旧位置应清掉')
    assert.ok(
      (await fsp.stat(path.join(root, 'handoff', 'projects', 'done', 'smoke-proj.md'))).isFile(),
      'done/ 下应有白板',
    )

    const archived = await call('project_read', { id: 'smoke-proj' })
    assert.equal(archived.exists, true)
    assert.equal(archived.archived, true)
    assert.equal(archived.structured.status, 'done')

    const afterReadme = await fsp.readFile(path.join(root, 'handoff', 'README.md'), 'utf8')
    assert.match(afterReadme, /## 七 · 已归档（40）/)
    assert.match(afterReadme, /冒烟项目/)
    assert.ok(
      !afterReadme.includes('- **[P1] 冒烟项目**'),
      '归档后不该再出现在「当前一棒」里',
    )
  })

  await check('archive_handoff 软删双份文件、摘索引、可 restore（2026-11-01 回归）', async () => {
    const missing = async (file) => {
      try {
        await fsp.stat(file)
        return false
      } catch {
        return true
      }
    }
    const machineRel = endResult.machineHandoff
    const userRel = endResult.userHandoff
    const value = await call('archive_handoff', { instance: 'smoke-one', reason: '冒烟归档回归' })
    assert.equal(value.ok, true, value.message)
    assert.equal(value.archived.length, 2)
    assert.ok(await missing(path.join(root, machineRel)), '机器版应已离开原位')
    assert.ok(await missing(path.join(root, userRel)), '用户版应已离开原位')
    for (const item of value.archived) {
      assert.match(item.physicalPath, /^archive\/trash\/.+from-created\//)
      assert.ok(!(await missing(path.join(root, item.physicalPath))), '回收文件应存在')
    }

    const index = JSON.parse(await fsp.readFile(path.join(root, 'handoff', 'index.machine.json'), 'utf8'))
    assert.ok(!index.entries.some((entry) => entry.instance === 'smoke-one'), '索引里应已摘掉 smoke-one')

    const recovery = await fsp.readFile(path.join(root, 'archive', 'trash', 'recovery-log.jsonl'), 'utf8')
    assert.match(recovery, /"source":"bucket_soft_delete"/)
    assert.ok(recovery.includes(machineRel), '回收记录应记下原始路径')

    const restored = await call('restore', { originalPath: machineRel })
    assert.equal(restored.ok, true, restored.message)
    assert.match(restored.restoredPath, /^archive\/restored\//)
    assert.ok(!(await missing(path.join(root, restored.restoredPath))), '恢复出来的文件应存在')
  })

  await check('九档顶层建出来就是空档（§11.5 只 mkdir，不预建二级目录）', async () => {
    const dirs = await fsp.readdir(root)
    for (const key of ['handoff', 'created', 'downloads', 'incoming', 'scratch', 'archive', 'logs', 'config', 'self']) {
      assert.ok(dirs.includes(key), `${key} 应已创建`)
    }
    // created 里本来就有这轮任务写的东西，只查没被用到的档
    for (const key of ['downloads', 'incoming', 'scratch']) {
      assert.deepEqual(await fsp.readdir(path.join(root, key)), [], `${key} 下不该有东西`)
    }
  })

  dispose?.()

  await check('数据回滚：白板改动自动备份，rollback_data 能回到上一版并留通知（0.3.27 回归）', async () => {
  await call('project_upsert', { id: 'smoke-rollback', title: '回滚测试', goal: 'v1', priority: 'P2' })
  await call('project_upsert', { id: 'smoke-rollback', title: '回滚测试', goal: 'v2', decision: '改成 v2' })
  const board = path.join(root, 'handoff', 'projects', 'smoke-rollback.md')
  const before = await fsp.readFile(board, 'utf8')
  assert.match(before, /v2/)

  const list = await call('rollback_data', { path: 'handoff/projects/smoke-rollback.md' })
  assert.equal(list.ok, true)
  assert.ok(list.backups.length >= 1, '至少有一份备份')

  const after = await fsp.readFile(board, 'utf8')
  console.log('[dbg] version=', list.version, 'backups=', list.backups, 'v2inBefore=', before.includes('v2'), 'v1inAfter=', after.includes('v1'))
  assert.notEqual(after, before, '回滚后内容应变化')
  const notice = await fsp.readFile(path.join(root, 'handoff', '任务交接本', '最近回滚.md'), 'utf8')
  assert.match(notice, /smoke-rollback\.md/)
})
await check('清扫报告：列出过期文件但不删（0.3.28 回归）', async () => {
  const scratchFile = path.join(root, 'scratch', 'old.tmp')
  await fsp.mkdir(path.dirname(scratchFile), { recursive: true })
  await fsp.writeFile(scratchFile, 'old scratch\n', 'utf8')
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000)
  await fsp.utimes(scratchFile, old, old)

  const result = await call('housekeeping_report', { force: true })
  assert.equal(result.ok, true, result.message)
  assert.ok(result.reportPath, '没有返回报告路径')
  const report = await fsp.readFile(result.reportPath, 'utf8')
  assert.match(report, /过期文件清扫报告/)
  assert.match(report, /old\.tmp/)
  assert.ok(result.totalFiles >= 1)

  // 只报告，不删：文件必须还在
  await fsp.access(scratchFile)
})

  // 器官系统 v0（0.4.0）：扫名片、读事件、门口路由；0.4.3：write/danger 走安全插件 gate
  await check('器官系统：file/read 直读、write/danger 走 gate 拿裁决、事件进账本（0.4.0/0.4.3 回归）', async () => {
    const organsLib = await import('../lib/organs.js')
    const organRoot = path.join(root, 'plug-root')
    const organDir = path.join(organRoot, 'echo')
    await fsp.mkdir(organDir, { recursive: true })
    await fsp.writeFile(path.join(organDir, 'organ.json'), JSON.stringify({
      id: 'echo',
      name: '回声器',
      version: '0.0.1',
      kind: 'inner',
      abilities: [
        { name: 'echo.read', entry: { type: 'file', path: 'note.txt' }, sideEffect: 'read' },
        { name: 'echo.write', entry: { type: 'file', path: 'note.txt' }, sideEffect: 'write' },
        { name: 'echo.rm', entry: { type: 'file', path: 'note.txt' }, sideEffect: 'danger' },
      ],
      events: { path: 'events.jsonl' },
    }), 'utf8')
    await fsp.writeFile(path.join(organDir, 'note.txt'), 'hello organ\n', 'utf8')
    await fsp.appendFile(path.join(organDir, 'events.jsonl'), JSON.stringify({ ts: '2026-11-05T00:00:00.000Z', type: 'task.done', severity: 'info', subject: 'smoke' }) + '\n', 'utf8')

    const ctx = { root }
    const gateDir = path.join(root, 'gate')
    await fsp.mkdir(gateDir, { recursive: true })
    const cfg = { 'organs.roots': organRoot, 'organs.gateDir': gateDir, 'organs.gateTimeoutMs': 400 }
    const listed = await organsLib.organList({ ctx, config: cfg })
    assert.equal(listed.ok, true)
    assert.equal(listed.count, 1)
    assert.equal(listed.organs[0].id, 'echo')

    const read = await organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.read' })
    assert.equal(read.ok, true)
    assert.match(read.content, /hello organ/)

    // write：起一个假安全插件，扫到 request 就回 allow；门口拿到 allow 后应回「执行器未接」而不是假装执行
    const allowPending = organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.write' })
    const stub = (async () => {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const files = await fsp.readdir(gateDir).catch(() => [])
        const req = files.find((f) => f.endsWith('.request.json'))
        if (req) {
          const id = req.slice(0, -'.request.json'.length)
          await fsp.writeFile(path.join(gateDir, `${id}.ack.json`), JSON.stringify({ id, verdict: 'allow', reason: 'smoke stub', by: 'stub' }), 'utf8')
          return
        }
        await new Promise((r) => setTimeout(r, 20))
      }
    })()
    const allowed = await allowPending
    await stub
    assert.equal(allowed.ok, false)
    assert.equal(allowed.errorCode, 'UNSUPPORTED_ENTRY')
    assert.equal(allowed.data.gate.verdict, 'allow')

    // danger 且没人回执：超时按拒绝
    const denied = await organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.rm' })
    assert.equal(denied.ok, false)
    assert.equal(denied.errorCode, 'GATE_DENIED')
    assert.equal(denied.data.gate.timeout, true)

    const missing = await organsLib.organCall({ ctx, config: cfg }, { ability: 'nope.x' })
    assert.equal(missing.errorCode, 'NO_ORGAN')

    const dry = await organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.read', dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.exists, true)

    const dryDanger = await organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.rm', dryRun: true })
    assert.equal(dryDanger.needsGate, true)
    assert.equal(dryDanger.sideEffect, 'danger')

    const ingested = await organsLib.ingestOrganEvents({ root }, cfg)
    assert.equal(ingested, 1)
    const ledger = await fsp.readFile(path.join(root, 'logs', '账本', 'data', 'records.jsonl'), 'utf8')
    assert.match(ledger, /"type":"organ"/)
  })

const failed = checks.filter((item) => !item.ok)
  for (const item of checks) {
    console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.ok ? '' : ` — ${item.error}`}`)
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
  await fsp.rm(root, { recursive: true, force: true })
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})








