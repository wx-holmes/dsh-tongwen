/**
 * 端到端冒烟：用假 ctx 起插件，在临时目录里跑一遍完整任务流程。
 *
 * 跑法：node scripts/smoke-tools.mjs
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  // 冒烟里 cancel 广播时不许真去删机器上已排的重启任务。
  process.env.TONGWEN_NO_SCHTASKS = '1'

  // 冒烟不该依赖本机外部校验器：机器上有真的 verify.mjs 就用真的；
  // 没有（比如公开仓库那份副本）就现写一个桩，只验我们这侧「采集 → 送裁决 → 落盘」。
  {
    const realVerify = process.env.TONGWEN_VERIFY_SCRIPT || 'A:\\safeprotocol\\bin\\verify.mjs'
    const exists = await fsp.stat(realVerify).then(() => true, () => false)
    if (!exists) {
      const stubPath = path.join(os.tmpdir(), 'tongwen-fake-verify.mjs')
      const stub = [
        "let raw = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => { raw += chunk })",
        "process.stdin.on('end', () => {",
        '  const payload = JSON.parse(raw || "{}")',
        '  const claims = Array.isArray(payload.claims) ? payload.claims : []',
        "  process.stdout.write(JSON.stringify({",
        "    verdict: 'allow',",
        "    by: payload.by || 'fake-verify',",
        '    total: claims.length,',
        '    round: 1,',
        "    summary: '桩：全部当通过',",
        "    results: claims.map((c) => ({ claim: c.claim, ok: true, actual: 'stub', ms: 0 })),",
        '  }))',
        '})',
      ].join('\n')
      await fsp.writeFile(stubPath, stub + '\n', 'utf8')
      process.env.TONGWEN_VERIFY_SCRIPT = stubPath
    }
  }

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-smoke-'))
  const { ctx, registered, contexts } = createFakeCtx()

  const dispose = apply(ctx, { root })

  await check('注册了 23 个工具', () => {
    assert.equal(registered.size, 23)
    for (const name of ['locate', 'inspect_handoff', 'list_handoffs', 'update_handoff', 'begin_task', 'end_task', 'heartbeat', 'restore', 'archive_handoff', 'rollback_data', 'housekeeping_report', 'project_upsert', 'project_read', 'project_list', 'inbox_send', 'inbox_list', 'inbox_close', 'organ_list', 'organ_call', 'restart_dsh', 'focus_context', 'space_list', 'space_register']) {
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
      next: [{ to: 'any', request: '接手的人去看 hello.txt' }],
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

  await check('0.5.4 next 字段写进两份交接（不再只进信箱/白板）', async () => {
    const machineText = await fsp.readFile(path.join(root, endResult.machineHandoff), 'utf8')
    const userText = await fsp.readFile(path.join(root, endResult.userHandoff), 'utf8')
    assert.match(machineText, /\*\*下一步（交给谁）\*\*/)
    assert.match(machineText, /接手的人去看 hello\.txt（交给 any）/)
    assert.match(userText, /接下来是这些/)
    assert.match(userText, /接手的人去看 hello\.txt（交给 any）/)
    // 用户版第 3 段原来把 blocked 写成「下次可能要做什么」，0.5.4 改回「卡住的地方」
    assert.match(userText, /^卡住的地方：/m)
    assert.ok(!/下次可能要做什么/.test(userText), '别再拿 blocked 冒充下一步')
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

  await check('0.4.9 verify: 行采集 + 送护城河裁决（verify-scanned / verify-verdicts）', async () => {
    const begun = await call('begin_task', {
      bucket: 'logs',
      instance: 'smoke-verify',
      displayName: '冒烟-verify',
      purpose: '验证 verify: 行扫描与裁决',
    })
    assert.equal(begun.ok, true, begun.message)
    const scanned = await call('end_task', {
      status: 'done',
      goal: '验证 verify: 行扫描与裁决',
      done: [
        'verify: file-exists A:\\safeprotocol\\bin\\verify.mjs',
        'verify: port 31181',
        'verify: 未知类型 foo',
      ],
      direction: '采集 + 裁决',
      directionReason: '0.4.9 冒烟',
      attempts: 1,
      factsCited: 2,
      factsWrong: 0,
    })
    assert.equal(scanned.ok, true, scanned.message)
    assert.ok(Array.isArray(scanned.verifyClaims), '返回体应带 verifyClaims')
    assert.equal(scanned.verifyClaims.length, 3)
    const file = path.join(root, 'logs', 'verify-scanned.jsonl')
    const rows = (await fsp.readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => item.entryId === scanned.entryId)
    assert.equal(rows.length, 3, '三条 verify: 行都要登记')
    assert.equal(rows.find((r) => r.type === 'file-exists')?.parsed, true)
    assert.equal(rows.find((r) => r.type === 'port')?.target, '31181')
    assert.equal(rows.find((r) => r.type === '未知类型')?.parsed, false, '不认识的白名单外类型要标 parsed=false')
    // 0.4.9：白名单内的断言要真送护城河，裁决落 logs/verify-verdicts.jsonl
    const verdicts = (await fsp.readFile(path.join(root, 'logs', 'verify-verdicts.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => item.entryId === scanned.entryId)
    assert.equal(verdicts.length, 1, '每次归档只写一条裁决')
    assert.equal(verdicts[0].total, 2, '只把白名单内、解析成功的两条送过去')
    assert.ok(['allow', 'deny'].includes(verdicts[0].verdict), '裁决只能是 allow/deny')
    assert.equal(scanned.verifyVerdict?.verdict, verdicts[0].verdict, '返回体要带同一条裁决')
  })

  await check('0.5.16 断言契约：by + 终止条件能读出来（缩进子字段 / 行尾 key=value），缺了只记不拦', async () => {
    const begun = await call('begin_task', {
      bucket: 'logs',
      instance: 'smoke-verify-contract',
      displayName: '冒烟-断言契约',
      purpose: '验证 verify 断言的 by 与终止条件',
    })
    assert.equal(begun.ok, true, begun.message)
    const scanned = await call('end_task', {
      status: 'done',
      goal: '验证 verify 断言的 by 与终止条件',
      done: [
        'verify: file-exists A:\\safeprotocol\\bin\\verify.mjs\n  by: tongwen/xtw-smoke\n  stopOnPass: 是',
        'verify: port 31181 by=tongwen/xtw-daily maxRounds=3',
        'verify: port 31181',
      ],
      direction: '断言契约',
      directionReason: '0.5.16 冒烟：谁派的、什么时候停',
      attempts: 1,
      factsCited: 2,
      factsWrong: 0,
    })
    assert.equal(scanned.ok, true, scanned.message)
    const claims = scanned.verifyClaims ?? []
    assert.equal(claims.length, 3, '三条断言都要登记')

    // ① 缩进子字段：by + stopOnPass
    assert.equal(claims[0].type, 'file-exists')
    assert.equal(claims[0].by, 'tongwen/xtw-smoke', '缩进子字段的 by 要采出来')
    assert.equal(claims[0].bounded, true, 'stopOnPass 算终止条件')
    assert.equal(claims[0].contract, 'complete')

    // ② 行尾 key=value：by + maxRounds，且不许混进 target
    assert.equal(claims[1].type, 'port')
    assert.equal(claims[1].target, '31181', '行尾 key=value 不能混进 target')
    assert.equal(claims[1].by, 'tongwen/xtw-daily')
    assert.equal(claims[1].maxRounds, 3)
    assert.equal(claims[1].contract, 'complete')

    // ③ 什么都没写：只记不拦
    assert.equal(claims[2].by, null)
    assert.equal(claims[2].contract, 'missing-both')
    const warned = (scanned.warnings ?? []).some((w) => String(w).includes('没写清'))
    assert.equal(warned, true, '缺 by / 终止条件要有一条软警告，但不许拦归档')

    const rows = (await fsp.readFile(path.join(root, 'logs', 'verify-scanned.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => item.entryId === scanned.entryId)
    assert.equal(rows.length, 3)
    assert.equal(rows.find((r) => r.by === 'tongwen/xtw-smoke')?.contract, 'complete')

    // 裁决回执带派单方（护城河侧记录里 by 取 VERIFY_BY，不给就永远是 unknown）
    const verdicts = (await fsp.readFile(path.join(root, 'logs', 'verify-verdicts.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => item.entryId === scanned.entryId)
    assert.equal(verdicts.length, 1, '每次归档只写一条裁决')
    assert.ok(verdicts[0].by, '裁决要带派单方（by）')
    assert.equal(scanned.verifyVerdict?.by, verdicts[0].by, '返回体同一条裁决要带同一个 by')
  })

  await check('0.5.18 next 收字符串 / JSON 字符串也不再静默丢（0.5.4 只认 {request} 对象）', async () => {
    // ① 换行分隔的纯文本：以前整条丢掉，现在拆成多条并报一句警告
    await call('begin_task', {
      bucket: 'logs',
      instance: 'smoke-next-lines',
      displayName: '冒烟-next 换行',
      purpose: '验证 next 的换行字符串写法',
    })
    const split = await call('end_task', {
      status: 'done',
      goal: '验证 next 换行字符串写法',
      done: ['next 用换行字符串传'],
      direction: 'next 归一化',
      directionReason: '0.5.18 冒烟',
      next: '字符串写法第一条\n字符串写法第二条',
      attempts: 1,
      factsCited: 0,
      factsWrong: 0,
    })
    assert.equal(split.ok, true, split.message)
    const machineLines = await fsp.readFile(path.join(root, split.machineHandoff), 'utf8')
    assert.match(machineLines, /字符串写法第一条/, '换行字符串要拆成一条条写进交接')
    assert.match(machineLines, /字符串写法第二条/)
    assert.ok(!/字符串写法第一条\\n字符串写法第二条/.test(machineLines), '不能整串塞成一行')
    assert.ok(
      (split.warnings ?? []).some((w) => String(w).includes('已按换行/分号拆成 2 条')),
      '拆行要留一句警告，不能再静默',
    )

    // ② JSON 字符串：解析成对象数组，to 也要保住
    await call('begin_task', {
      bucket: 'logs',
      instance: 'smoke-next-json',
      displayName: '冒烟-next JSON',
      purpose: '验证 next 的 JSON 字符串写法',
    })
    const parsed = await call('end_task', {
      status: 'done',
      goal: '验证 next JSON 字符串写法',
      done: ['next 用 JSON 字符串传'],
      direction: 'next 归一化',
      directionReason: '0.5.18 冒烟',
      next: '[{"to":"shenjing-xitong","request":"JSON 写法：接一下口径"}]',
      attempts: 1,
      factsCited: 0,
      factsWrong: 0,
    })
    assert.equal(parsed.ok, true, parsed.message)
    const machineJson = await fsp.readFile(path.join(root, parsed.machineHandoff), 'utf8')
    const userJson = await fsp.readFile(path.join(root, parsed.userHandoff), 'utf8')
    assert.match(machineJson, /JSON 写法：接一下口径（交给 shenjing-xitong）/, 'JSON 字符串要解析出 to')
    assert.match(userJson, /接下来是这些/, '用户版第 4 段也要写到')
  })

  await check('0.4.8 同一份交接的新旧两种命名在清单里只算一行', async () => {
    const rel = endResult.machineHandoff
    const dirRel = path.posix.dirname(rel)
    const base = path.posix.basename(rel)
    const summary = base.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(/\.machine\.md$/, '')
    const legacyRel = `${dirRel}/${summary}.machine.md`
    await fsp.copyFile(path.join(root, rel), path.join(root, legacyRel))
    await call('project_upsert', { id: 'smoke-dedupe', title: '去重回归', status: 'active' })
    const text = await fsp.readFile(path.join(root, 'handoff', 'README.md'), 'utf8')
    const rows = text
      .split('\n')
      .filter((line) => line.startsWith('| ') && line.includes(summary))
    assert.equal(rows.length, 1, `同一份交接只能有一行（实际 ${rows.length} 行：${rows.join(' / ')}）`)
    assert.ok(rows[0].includes(base), '应保留新命名那份，而不是旧命名副本')

    // 0.5.3：只有旧命名、没有新命名、也没进索引的那份，不许再标「在办」（以前叫幽灵条目）
    const ghostRel = `${dirRel}/幽灵样子.machine.md`
    await fsp.copyFile(path.join(root, rel), path.join(root, ghostRel))
    await call('project_upsert', { id: 'smoke-dedupe', title: '去重回归', status: 'active' })
    const text2 = await fsp.readFile(path.join(root, 'handoff', 'README.md'), 'utf8')
    const ghostRow = text2.split('\n').find((line) => line.startsWith('| ') && line.includes('幽灵样子'))
    assert.ok(ghostRow, 'README 里应该有幽灵样子那一行')
    assert.ok(ghostRow.includes('历史·旧命名副本'), `旧命名副本要标「历史·旧命名副本」，实际：${ghostRow}`)
    const indexText = await fsp.readFile(path.join(root, 'handoff', '索引', '交接索引.md'), 'utf8')
    assert.match(indexText, /已按内容去重/, '交接索引要写清「去重后份数 / 磁盘份数」两个口径')
    await fsp.unlink(path.join(root, ghostRel)).catch(() => {})
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

  await check('交接总目录：README 权重排「在办/清单/文件/插件/工具/A盘/已归档」并链到索引页，且明确别全读（0.5.2 回归）', async () => {
    const text = await fsp.readFile(path.join(root, 'handoff', 'README.md'), 'utf8')
    assert.match(text, /交接总目录/)
    // 0.5.2：权重改了——新时空第一眼要看到「我现在接哪件事」（在办），其次才是清单和找东西。
    const order = [
      '## 一 · 在办（100）· 当前一棒',
      '## 二 · 清单（90）',
      '## 三 · 文件（80）',
      '## 四 · 插件（70）',
      '## 五 · 工具（60）',
      '## 六 · A 盘（50）',
      '## 七 · 已归档（10）',
    ]
    let cursor = -1
    for (const heading of order) {
      const at = text.indexOf(heading)
      assert.ok(at >= 0, `缺小节：${heading}`)
      assert.ok(at > cursor, `小节顺序不对：${heading} 应该排在后面（权重从高到低）`)
      cursor = at
    }
    // 0.4.8：隐私清洗规范要出现在「三 · 文件」里，否则新时空不知道活目录不能直推。
    assert.match(text, /上传仓库前的隐私清洗/, '文件段里要登记隐私清洗规范')
    assert.match(text, /handoff\/手册\/上传仓库前的隐私清洗\.md/, '要给出规范路径')
    // 顶部权重行也要跟着改，别写着一套、排着另一套。
    assert.match(text, /一·在办 100 → 二·清单 90 → 三·文件 80 → 四·插件 70 → 五·工具 60 → 六·A盘 50 → 七·已归档 10/)
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
    assert.match(afterReadme, /## 七 · 已归档（10）/)
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

  // 器官系统 v0（0.4.0）：扫名片、读事件、门口路由；0.4.3：write/danger 走护城河 gate
  await check('器官系统：file/read 直读、write/danger 走 gate、门批后落到公共的手真做事（0.4.0/0.4.3/0.5.8 回归）', async () => {
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
        { name: 'echo.cli', entry: { type: 'cli', command: process.execPath, args: ['-e', 'console.log("hi-cli")'] }, sideEffect: 'write' },
        { name: 'echo.readcli', entry: { type: 'cli', command: process.execPath, args: ['-e', 'console.log("nope")'] }, sideEffect: 'read' },
        // 0.5.9：tool 类手是「模型手里的工具」，插件按不动，只派单
        { name: 'echo.tool', entry: { type: 'tool', tool: 'mcp__smoke__press' }, sideEffect: 'write' },
      ],
      events: { path: 'events.jsonl' },
    }), 'utf8')
    await fsp.writeFile(path.join(organDir, 'note.txt'), 'hello organ\n', 'utf8')
    // 0.5.12：事件带 id 与 payload.owner（黑洞 0.1.0 的格式）
    await fsp.appendFile(path.join(organDir, 'events.jsonl'), JSON.stringify({ ts: '2026-11-05T00:00:00.000Z', id: 'evt-smoke-1', type: 'task.done', severity: 'info', subject: 'smoke', payload: { owner: 'smoke-profile' } }) + '\n', 'utf8')

    const ctx = { root, sessionId: 'session-smoke' }
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

    // write：起一个假护城河，扫到 request 就回 allow；门批了以后应真写文件（0.5.8：手是共用的）
    const allowNextGate = () =>
      (async () => {
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
    const writePending = organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.write', content: 'written by hand\n' })
    await allowNextGate()
    const written = await writePending
    assert.equal(written.ok, true)
    assert.equal(written.exec.entry.type, 'file')
    assert.match(await fsp.readFile(path.join(organDir, 'note.txt'), 'utf8'), /written by hand/)

    // cli：同一份公共代码跑命令（输出回执里带 stdout）
    const cliPending = organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.cli' })
    await allowNextGate()
    const ran = await cliPending
    assert.equal(ran.ok, true)
    assert.equal(ran.exec.entry.type, 'cli')
    assert.match(ran.exec.stdout, /hi-cli/)

    // 留痕：动手前一行 prepare、做完一行 done（主人定的「留」）
    const execLog = await fsp.readFile(path.join(root, 'logs', 'organs-exec.jsonl'), 'utf8')
    assert.match(execLog, /"phase":"prepare"/)
    assert.match(execLog, /"phase":"done"/)

    // tool 类（0.5.9）：门批了之后不假装执行，只派单——回执写清工具名与参数
    const toolPending = organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.tool', args: { text: 'hey' } })
    await allowNextGate()
    const delegated = await toolPending
    assert.equal(delegated.ok, true)
    assert.equal(delegated.needsActor, true)
    assert.equal(delegated.exec.executed, false)
    assert.equal(delegated.exec.mode, 'delegated')
    assert.equal(delegated.exec.tool, 'mcp__smoke__press')
    assert.deepEqual(delegated.exec.args, { text: 'hey' })
    assert.match(delegated.message, /mcp__smoke__press/)
    assert.match(await fsp.readFile(path.join(root, 'logs', 'organs-exec.jsonl'), 'utf8'), /"phase":"delegated"/)

    // 0.5.11：args 传成 JSON 字符串也认（护城河 06:20 报过 args 回执为 null）
    const toolPending2 = organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.tool', args: '{"text":"as-string"}' })
    await allowNextGate()
    const delegated2 = await toolPending2
    assert.deepEqual(delegated2.exec.args, { text: 'as-string' })

    // 0.5.12：派单回执带 who（谁请求的这一下），痕迹里也留
    assert.equal(delegated.who, 'session-smoke')
    assert.equal(delegated.exec.who, 'session-smoke')
    assert.match(await fsp.readFile(path.join(root, 'logs', 'organs-exec.jsonl'), 'utf8'), /"who":"session-smoke"/)

    // 只读能力不许跑命令（要跑必须声明 write/danger 先过门）
    const readCli = await organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.readcli' })
    assert.equal(readCli.ok, false)
    assert.equal(readCli.errorCode, 'UNSUPPORTED_ENTRY')

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

    // 0.5.25：双向调用防回环——链里已经有它、或跳数到顶，都直接挡
    const looped = await organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.read', chain: ['echo.read'] })
    assert.equal(looped.ok, false)
    assert.equal(looped.errorCode, 'E_CALL_LOOP')
    assert.match(looped.message, /回环/)
    const tooDeep = await organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.read', chain: ['a.b', 'c.d', 'e.f'] })
    assert.equal(tooDeep.errorCode, 'E_CALL_LOOP')
    assert.match(tooDeep.message, /3 跳/)
    // 回执：同一件事只回一次；两次调用都在自己的 events.jsonl 留脚印
    const replied = await organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.read', replyTo: 'evt-smoke-reply-1' })
    assert.equal(replied.ok, true)
    const dupReply = await organsLib.organCall({ ctx, config: cfg }, { ability: 'echo.read', replyTo: 'evt-smoke-reply-1' })
    assert.equal(dupReply.ok, false)
    assert.equal(dupReply.errorCode, 'E_LOOP_DEDUPE')
    const ownEvents = (await fsp.readFile(path.join(root, 'logs', 'organ-events.jsonl'), 'utf8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(ownEvents.some((e) => e.type === 'organ.call'), true)
    assert.equal(ownEvents.some((e) => e.type === 'organ.call.reply' && e.subject === 'evt-smoke-reply-1'), true)
    assert.equal(new Set(ownEvents.map((e) => e.id)).size, ownEvents.length)

    const ingested = await organsLib.ingestOrganEvents({ root }, cfg)
    assert.equal(ingested, 1)
    const ledger = await fsp.readFile(path.join(root, 'logs', '账本', 'data', 'records.jsonl'), 'utf8')
    assert.match(ledger, /"type":"organ"/)
    // 0.5.12：eventId 与 owner（payload.owner 提到顶层）都入账
    assert.match(ledger, /"eventId":"evt-smoke-1"/)
    assert.match(ledger, /"owner":"smoke-profile"/)

    // 0.5.12：同一件事只入账一次——把 offset 拨回 0（模拟回退/重读），id 去重应挡住
    const stateFile = path.join(root, 'logs', 'organs-state.json')
    const st = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
    st.organs.echo.offset = 0
    await fsp.writeFile(stateFile, JSON.stringify(st), 'utf8')
    assert.equal(await organsLib.ingestOrganEvents({ root }, cfg), 0)
  })

  await check('脉搏与手迹：心真去量 mtime、手查 organs-exec.jsonl 分得清做过/派单（0.5.10）', async () => {
    const organsLib = await import('../lib/organs.js')
    const pulseRoot = path.join(root, 'pulse-root')
    const pulseDir = path.join(pulseRoot, 'pulse')
    await fsp.mkdir(pulseDir, { recursive: true })
    await fsp.writeFile(path.join(pulseDir, 'organ.json'), JSON.stringify({
      id: 'pulse',
      name: '脉搏器',
      version: '0.9.0',
      kind: 'inner',
      abilities: [{ name: 'pulse.read', entry: { type: 'file', path: 'note.txt' }, sideEffect: 'read' }],
      events: { path: 'ev.jsonl' },
      health: { path: 'beat.txt', ttlMs: 60 * 1000 },
    }), 'utf8')
    await fsp.writeFile(path.join(pulseDir, 'note.txt'), 'beat\n', 'utf8')
    await fsp.writeFile(path.join(pulseDir, 'ev.jsonl'), '', 'utf8')
    await fsp.writeFile(path.join(pulseDir, 'beat.txt'), 'alive\n', 'utf8')

    const ctx2 = { root }
    const cfg2 = { 'organs.roots': pulseRoot }
    const beat = await organsLib.probeHeart({ health: { path: path.join(pulseDir, 'beat.txt'), ttlMs: 60000 } })
    assert.equal(beat.present, true)
    assert.equal(beat.alive, true)
    assert.equal(beat.missing, false)

    // health 文件没注册 → present:false；文件没了 → missing:true 且 alive:false
    const noHeart = await organsLib.probeHeart({ abilities: [] })
    assert.equal(noHeart.present, false)
    await fsp.unlink(path.join(pulseDir, 'beat.txt'))
    const gone = await organsLib.probeHeart({ health: { path: path.join(pulseDir, 'beat.txt'), ttlMs: 60000 } })
    assert.equal(gone.present, true)
    assert.equal(gone.missing, true)
    assert.equal(gone.alive, false)
    // 恢复一个有脉搏的文件（后两段要用）
    await fsp.writeFile(path.join(pulseDir, 'beat.txt'), 'alive again\n', 'utf8')

    // 手迹：先只有一次真做成（done/ok）→ handUsed，不算 delegated
    const execPath = path.join(root, 'logs', 'organs-exec.jsonl')
    await fsp.mkdir(path.dirname(execPath), { recursive: true })
    await fsp.writeFile(execPath, JSON.stringify({ at: new Date().toISOString(), organ: 'pulse', ability: 'pulse.read', phase: 'done', ok: true }) + '\n', 'utf8')
    const used = await organsLib.organList({ ctx: ctx2, config: cfg2 })
    assert.equal(used.organs[0].heart.alive, true)
    assert.equal(used.organs[0].lastExec.phase, 'done')
    assert.deepEqual(used.integration.handUsed, ['pulse'])
    assert.deepEqual(used.integration.handDelegated, [])
    assert.deepEqual(used.integration.staleHeart, [])

    // 再追加一次派单 → 最近一条变 delegated：手没真按，handUsed 清空
    await fsp.appendFile(execPath, JSON.stringify({ at: new Date().toISOString(), organ: 'pulse', ability: 'pulse.read', phase: 'delegated', ok: true, tool: 'mcp__smoke__press' }) + '\n', 'utf8')
    const delegatedOnly = await organsLib.organList({ ctx: ctx2, config: cfg2 })
    assert.equal(delegatedOnly.organs[0].lastExec.phase, 'delegated')
    assert.equal(delegatedOnly.organs[0].lastExec.tool, 'mcp__smoke__press')
    assert.deepEqual(delegatedOnly.integration.handUsed, [])
    assert.deepEqual(delegatedOnly.integration.handDelegated, ['pulse'])

    // 心跳过 ttl → staleHeart 点名
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fsp.utimes(path.join(pulseDir, 'beat.txt'), old, old)
    const stale = await organsLib.organList({ ctx: ctx2, config: cfg2 })
    assert.equal(stale.organs[0].heart.alive, false)
    assert.deepEqual(stale.integration.staleHeart, ['pulse'])
  })

  await check('三层信息：手册总览 / 动态白板跟总目录一起生成（0.5.0）', async () => {
    const layers = await import('../lib/layers.js')
    const pageCtx = {
      root,
      projectsDir: path.join(root, 'handoff', 'projects'),
      inboxFile: path.join(root, 'handoff', 'inbox.jsonl'),
    }
    // 临时根里先放两条规矩（含插件接入契约），手册总览才会有表、并验证契约钉在最前
    await fsp.mkdir(path.join(root, 'handoff', '手册'), { recursive: true })
    await fsp.writeFile(
      path.join(root, 'handoff', '手册', '示例规矩.md'),
      '# 示例规矩\n\n> 一句话：冒烟用的假规矩\n\n正文一段。\n',
      'utf8',
    )
    await fsp.writeFile(
      path.join(root, 'handoff', '手册', '插件的自我管理.md'),
      '# 插件的自我管理\n\n> 一句话：冒烟用的假契约\n\n正文一段。\n',
      'utf8',
    )
    const norms = await layers.renderNormsPage(pageCtx)
    assert.match(norms, /规矩清单/)
    // 0.5.3：读序写死在手册总览最上面（权重 规矩 100 ＞ 现在 90 ＞ 目录 80），且排在接入契约之前
    assert.match(norms, /先读哪一块（权重写死/, '手册总览顶部没有「先读哪一块」块')
    assert.match(norms, /100/, '手册总览没写板块权重')
    assert.ok(norms.indexOf('先读哪一块') < norms.indexOf('接入契约'), '「先读哪一块」必须排在接入契约之前')
    // 0.5.1：接入契约钉在规矩清单最上面（做插件的时空第一眼就看到）
    assert.match(norms, /接入契约（所有做插件的时空必读/, '手册总览顶部没有接入契约块')
    assert.ok(norms.indexOf('插件的自我管理') < norms.indexOf('示例规矩'), '插件契约没钉在最前')
    // 前面建的项目多半已经 done 归档；这里另起一个在办的，确认动态白板真带上「当前一棒」
    const layered = await call('project_upsert', {
      id: 'smoke-layers',
      title: '分层冒烟',
      goal: '确认动态白板带上在办项目',
      to: 'any',
      action: '读三层信息',
    })
    assert.equal(layered.ok, true, layered.message)
    const problems = await layers.writeLayers(pageCtx)
    assert.deepEqual(problems, [], `写三层失败：${problems.join('；')}`)
    const normsFile = await fsp.readFile(path.join(root, 'handoff', '手册总览.md'), 'utf8')
    assert.match(normsFile, /三层/)
    const dyn = await fsp.readFile(path.join(root, 'handoff', '动态白板.md'), 'utf8')
    assert.match(dyn, /动态白板/)
    assert.match(dyn, /怎么用/)
    // 动态白板要真的带上在办项目的当前一棒
    assert.match(dyn, /smoke-layers/, '动态白板没写刚建的在办项目')
    assert.match(dyn, /读三层信息/, '动态白板没写当前一棒')
    const readme = await fsp.readFile(path.join(root, 'handoff', 'README.md'), 'utf8')
    assert.match(readme, /三层信息/)
    assert.ok(readme.indexOf('手册总览.md') < readme.indexOf('动态白板.md'), 'README 三层导航顺序应当是 手册 → 现在 → 目录')
  })

  await check('合体四点：名片缺头/缺脚会被点名，三点以上才算接上（0.5.1）', async () => {
    const organsLib = await import('../lib/organs.js')
    const full = organsLib.connectPointsOf({
      abilities: [
        { name: 'x.status.read', entry: { type: 'file', path: 'a' }, sideEffect: 'read' },
        { name: 'x.send.write', entry: { type: 'file', path: 'b' }, sideEffect: 'write' },
      ],
      events: { path: 'events.jsonl' },
      health: { path: 'health.json', ttlMs: 60000 },
    })
    assert.equal(full.score, 4)
    assert.deepEqual(full.missing, [])

    const noFoot = organsLib.connectPointsOf({ abilities: [{ name: 'x.read', entry: { type: 'file', path: 'a' } }] })
    assert.deepEqual(noFoot.missing, ['hand', 'foot', 'heart'], '缺点顺序应是 手/脚/心')

    // organ_list 汇总：四点全的算 connected，缺脚的进 missingFoot
    const organRoot = path.join(root, 'organs-probe')
    await fsp.mkdir(path.join(organRoot, 'good'), { recursive: true })
    await fsp.mkdir(path.join(organRoot, 'bad'), { recursive: true })
    await fsp.writeFile(
      path.join(organRoot, 'good', 'organ.json'),
      JSON.stringify({
        id: 'good', name: '好器官',
        abilities: [{ name: 'good.read', entry: { type: 'file', path: 'x' }, sideEffect: 'read' }],
        events: { path: 'events.jsonl' },
        health: { path: 'health.json', ttlMs: 1000 },
      }),
      'utf8',
    )
    await fsp.writeFile(
      path.join(organRoot, 'bad', 'organ.json'),
      JSON.stringify({
        id: 'bad', name: '坏器官',
        abilities: [{ name: 'bad.read', entry: { type: 'file', path: 'x' }, sideEffect: 'read' }],
      }),
      'utf8',
    )
    const listed = await organsLib.organList({ ctx: { root }, config: { 'organs.roots': organRoot } })
    assert.equal(listed.count, 2)
    assert.equal(listed.integration.online, 2)
    assert.deepEqual(listed.integration.missingFoot, ['bad'])
    assert.equal(listed.integration.connected, 1)
    const good = listed.organs.find((row) => row.id === 'good')
    assert.equal(good.connect.score, 3, 'good 应为 头+脚+心 三点')
  })

  await check('重启广播：arm 写广播、开场/begin_task 带提醒、cancel 收掉（0.5.0）', async () => {
    const restart = await import('../lib/restart.js')
    const b = await restart.writeBroadcast({ root }, { by: 'smoke', reason: '单元测试', delaySec: 60 })
    assert.equal(b.status, 'pending')
    assert.ok(b.etaAt > Date.now(), '广播没有未来的 etaAt')

    const pending = restart.pendingBroadcastSync({ root })
    assert.ok(pending && pending.status === 'pending')
    assert.match(restart.describeBroadcast(pending), /重启广播/)

    const status = await call('restart_dsh', { action: 'status' })
    assert.equal(status.ok, true, status.message)
    assert.match(String(status.text), /重启广播/)

    const started = await call('begin_task', { bucket: 'logs', instance: 'smoke-broadcast', purpose: '广播提醒' })
    assert.equal(started.ok, true, started.message)
    assert.ok((started.warnings ?? []).some((w) => String(w).includes('重启广播')), 'begin_task 没带广播提醒')

    const cancelled = await call('restart_dsh', { action: 'cancel', reason: '冒烟收尾' })
    assert.equal(cancelled.ok, true, cancelled.message)
    assert.equal(restart.pendingBroadcastSync({ root }), null)

    // 0.5.22：排新的 / 取消之前要先杀掉还在睡的旧定时器（否则提前档会被旧天花板补刀）。
    // 冒烟里 TONGWEN_NO_SCHTASKS=1，只验「跳过且不杀」，真杀进程在机器上手动验过。
    const timers = restart.killRestartTimers()
    assert.equal(timers.ok, true, timers.output)
    assert.deepEqual(timers.killed, [], '冒烟环境不该杀任何进程')
    assert.match(String(timers.output), /skipped/)

    // 0.5.2 回归（别的时空报的 bug）：重启完成后，旧广播不能还在喊「重启进行中」。
    // 判据是「etaAt 早于本进程出生」——这里注入 loadedAt 模拟新进程。
    const fresh = await restart.writeBroadcast({ root }, { by: 'smoke', reason: '已完成的重启', delaySec: 30 })
    const asNewProcess = fresh.etaAt + 1000 // 假设新进程在 eta 之后才起来
    const afterRestart = restart.readBroadcastSync({ root }, asNewProcess, asNewProcess)
    assert.equal(afterRestart.status, 'completed', '比本进程早的广播应判 completed')
    assert.equal(restart.pendingBroadcastSync({ root }, asNewProcess, asNewProcess), null, '重启完的广播不该再提醒')
    assert.equal(restart.describeBroadcast(afterRestart), '', 'completed 的广播不该再出文案')
    // 同一进程内（eta 还没到）仍是 pending，不能误伤正在倒计时的广播。
    const inThisProcess = restart.readBroadcastSync({ root }, fresh.announcedAt, fresh.announcedAt - 1000)
    assert.equal(inThisProcess.status, 'pending', '本进程排的广播仍是 pending')
    const primed = await call('restart_dsh', { action: 'status' })
    assert.equal(primed.ok, true, primed.message)
    // 再确认开场注入那一行（本进程视角）仍在提醒，然后收尾。
    assert.match(String(primed.text), /重启广播/, '进行中的广播仍要提醒')
    await call('restart_dsh', { action: 'cancel', reason: '冒烟收尾 2' })
  })

  await check('重启分档：按现场自动选 25/45/75 秒（0.5.5 在场感知）', async () => {
    const presence = await import('../lib/presence.js')
    const handshake = await import('../lib/handshake.js')
    const sessions = path.join(root, 'fake-sessions')
    const now = Date.now()
    const makeSpace = async (id, ageMs) => {
      const dir = path.join(sessions, 'default-workspace', id)
      await fsp.mkdir(dir, { recursive: true })
      const file = path.join(dir, 'x.jsonl')
      await fsp.writeFile(file, '{}\n')
      const t = new Date(now - ageMs)
      await fsp.utimes(file, t, t)
    }

    // ① 别的时空都静默 10 分钟 → 快档 25 秒
    await makeSpace('session-old', 10 * 60 * 1000)
    let d = presence.decideRestartDelay({ ctx: { root }, selfSessionId: 'session-me', now, root: sessions })
    assert.equal(d.tier, 'fast')
    assert.equal(d.delaySec, presence.TIER_FAST_SEC)
    assert.match(d.reasons.join(' '), /静默超过 5 分钟/)

    // ② 有别的时空 5 秒前动过 → 常档 45 秒
    await makeSpace('session-warm', 5 * 1000)
    d = presence.decideRestartDelay({ ctx: { root }, selfSessionId: 'session-me', now, root: sessions })
    assert.equal(d.tier, 'normal')
    assert.equal(d.delaySec, presence.TIER_NORMAL_SEC)
    assert.match(d.reasons.join(' '), /session-warm/)

    // ③ 那个时空开着任务没收尾 → 慢档 75 秒
    presence.markTaskOpen({ root }, { sessionId: 'session-warm', taskId: 't-1', displayName: '0.5.5 上线' })
    d = presence.decideRestartDelay({ ctx: { root }, selfSessionId: 'session-me', now, root: sessions })
    assert.equal(d.tier, 'slow')
    assert.equal(d.delaySec, presence.TIER_SLOW_SEC)
    assert.match(d.reasons.join(' '), /开着「0\.5\.5 上线」/)

    // ④ end_task 划掉之后回到常档
    presence.clearTaskOpen({ root }, 'session-warm')
    d = presence.decideRestartDelay({ ctx: { root }, selfSessionId: 'session-me', now, root: sessions })
    assert.equal(d.tier, 'normal', '划掉 open-task 后不该再是慢档')

    // ⑤ 自己不参与判断
    const spans = presence.scanSpaces({ root: sessions, now, selfSessionId: 'session-warm' })
    assert.ok(!spans.some((s) => s.sessionId === 'session-warm'), '自己的会话不该算「别人」')

    // ⑥ restart_dsh 不填 delaySec 时走握手模式（0.5.6）：现场没人动 → 直接提前档 25，
    //    有人在动 → 先排天花板 90，等硬证据（全 ack / 没人挂活且没人在写）由 maybePromote 提前；沉默不算证据（0.5.13）。
    const auto = await call('restart_dsh', { action: 'arm', reason: '冒烟：握手模式' })
    assert.equal(auto.ok, true, auto.message)
    assert.equal(auto.mode, 'auto', `mode 不对：${auto.mode}`)
    assert.ok([handshake.AUTO_EARLY_SEC, handshake.AUTO_CEILING_SEC].includes(auto.delaySec), `delaySec 不对：${auto.delaySec}`)
    assert.match(String(auto.autoText || ''), /握手模式/)
    const spaces = await call('restart_dsh', { action: 'spaces' })
    assert.equal(spaces.ok, true, spaces.message)
    assert.ok(Number.isInteger(spaces.total), 'spaces 没回 total')
    await call('restart_dsh', { action: 'cancel', reason: '冒烟收尾 3' })
  })

  await check('握手式自动重启：只认硬证据（0.5.13：沉默不算证据）', async () => {
    const handshake = await import('../lib/handshake.js')
    const restart = await import('../lib/restart.js')
    const sessions = path.join(root, 'hs-sessions')
    const makeSpace = async (id, ageMs) => {
      const dir = path.join(sessions, 'default-workspace', id)
      await fsp.mkdir(dir, { recursive: true })
      const file = path.join(dir, 'x.jsonl')
      await fsp.writeFile(file, '{}\n')
      const t = new Date(Date.now() - ageMs)
      await fsp.utimes(file, t, t)
    }
    await makeSpace('session-peer', 3 * 1000)
    const ctx = { root }
    const b = await restart.writeBroadcast(ctx, {
      by: 'me',
      reason: '冒烟：握手式',
      delaySec: handshake.AUTO_CEILING_SEC,
      mode: 'auto',
      auto: { ceilingSec: handshake.AUTO_CEILING_SEC, earlySec: handshake.AUTO_EARLY_SEC, minReadySec: handshake.AUTO_MIN_READY_SEC },
    })
    assert.equal(b.mode, 'auto')
    // ① 别的时空 3 秒前还在动 → 不能提前
    let r = handshake.computeReadiness({ ctx, selfSessionId: 'session-me', root: sessions, now: Date.now() })
    assert.equal(r.active, true)
    assert.equal(r.ready, false)
    assert.equal(r.pending.length, 1)
    assert.match(handshake.describeReadiness(r), /公告才|没停手/)
    // ①.5 0.5.13 回归：它 10 分钟没动、但还挂着未完成任务 → 沉默不算证据，不能提前
    const presence = await import('../lib/presence.js')
    await makeSpace('session-peer', 10 * 60 * 1000)
    presence.markTaskOpen(ctx, { sessionId: 'session-peer', taskId: 'smoke-silent', displayName: '装死的活', project: 'smoke' })
    r = handshake.computeReadiness({ ctx, selfSessionId: 'session-me', root: sessions, now: Date.now() + (handshake.AUTO_MIN_READY_SEC + 5) * 1000 })
    assert.equal(r.ready, false, '沉默不算证据：挂着未完成任务时不许提前')
    assert.equal(r.evidence, null)
    assert.ok(r.openTasks.includes('session-peer'), `openTasks 里该有 session-peer：${r.openTasks.join(',')}`)
    assert.match(handshake.describeReadiness(r), /未完成/)
    // ①.6 任务清掉、它也没在写 → 这才是证据（quiet）
    // 同一 ctx.root 下前面用例可能还挂着别人的任务，先全部清干净再验「安静」
    for (const sid of Object.keys(presence.readOpenTasksSync(ctx))) presence.clearTaskOpen(ctx, sid)
    r = handshake.computeReadiness({ ctx, selfSessionId: 'session-me', root: sessions, now: Date.now() + (handshake.AUTO_MIN_READY_SEC + 5) * 1000 })
    assert.equal(r.ready, true, handshake.describeReadiness(r))
    assert.equal(r.evidence, 'quiet')
    // ② 它 ack 了 → 等过 minReadySec（注入 now）→ ready
    await restart.ackBroadcast(ctx, { sessionId: 'session-peer', note: '收尾了' })
    const later = Date.now() + (handshake.AUTO_MIN_READY_SEC + 5) * 1000
    r = handshake.computeReadiness({ ctx, selfSessionId: 'session-me', root: sessions, now: later })
    assert.equal(r.ready, true, handshake.describeReadiness(r))
    // ③ 提前：把天花板换成 25 秒，并把广播 etaAt 改早
    let called = null
    const stub = (opts) => {
      called = opts
      return { ok: true, taskReady: true, output: 'stub' }
    }
    const promoted = await handshake.maybePromote({ ctx, selfSessionId: 'session-me', root: sessions, now: later, schedule: stub })
    assert.equal(promoted.promoted, true, promoted.reason)
    assert.equal(called.delaySec, handshake.AUTO_EARLY_SEC)
    const after = await restart.readBroadcastSync(ctx, later)
    assert.equal(after.delaySec, handshake.AUTO_EARLY_SEC)
    assert.equal(after.promotedDelaySec, handshake.AUTO_EARLY_SEC)
    assert.ok(after.etaAt < b.etaAt, '广播 etaAt 应该改早')
    // ④ 不重复提前
    const again = await handshake.maybePromote({ ctx, selfSessionId: 'session-me', root: sessions, now: later + 3000, schedule: stub })
    assert.equal(again.promoted, false)
    // ⑤ 没有广播时什么都不做
    await call('restart_dsh', { action: 'cancel', reason: '冒烟收尾 4' })
    const idle = handshake.computeReadiness({ ctx, selfSessionId: 'session-me', root: sessions })
    assert.equal(idle.active, false)
  })

  await check('对外入口（CLI）：同一道门口搬到命令行——读直做、坏 JSON 当场拒、未知能力列出已知（0.5.14）', async () => {
    const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const cliPath = path.join(pluginDir, 'bin', 'organ-call.mjs')
    const cliSpace = path.join(root, 'cli-space')
    const cliOrgans = path.join(root, 'cli-organs')
    await fsp.mkdir(path.join(cliOrgans, 'cli-echo'), { recursive: true })
    await fsp.writeFile(
      path.join(cliOrgans, 'cli-echo', 'organ.json'),
      JSON.stringify(
        {
          id: 'cli-echo',
          name: 'CLI 回声',
          version: '0.0.1',
          kind: 'tool',
          abilities: [
            { name: 'cli-echo.read', desc: '读一行字', entry: { type: 'file', path: 'hello.txt' }, sideEffect: 'read' },
          ],
        },
        null,
        2,
      ),
    )
    await fsp.writeFile(path.join(cliOrgans, 'cli-echo', 'hello.txt'), 'from-cli\n')

    const runCli = (args) =>
      new Promise((resolve) => {
        execFile(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
          const text = String(stdout ?? '').trim()
          let json = null
          try {
            json = JSON.parse(text.split('\n').pop())
          } catch {
            json = null
          }
          resolve({ code: error?.code ?? 0, json, text })
        })
      })

    // ① 读：直接做，不过门
    const read = await runCli(['--ability', 'cli-echo.read', '--roots', cliOrgans, '--root', cliSpace, '--who', 'smoke-cli'])
    assert.equal(read.code, 0, read.text)
    assert.equal(read.json?.ok, true)
    assert.equal(read.json?.ability, 'cli-echo.read')
    assert.ok(JSON.stringify(read.json).includes('from-cli'), '要把文件内容读出来')

    // ② --args 不是合法 JSON：当场拒，不落到器官那里
    const bad = await runCli(['--ability', 'cli-echo.read', '--args', '{oops', '--roots', cliOrgans, '--root', cliSpace])
    assert.equal(bad.code, 1)
    assert.equal(bad.json?.errorCode, 'E_ARGUMENT')

    // ③ 未知能力：把已知的列出来，别的时空拼错名字时能自己纠
    const unknown = await runCli(['--ability', 'nope.nothing', '--roots', cliOrgans, '--root', cliSpace])
    assert.equal(unknown.code, 1)
    assert.equal(unknown.json?.errorCode, 'NO_ORGAN')
    const known = unknown.json?.data?.knownAbilities ?? unknown.json?.knownAbilities
    assert.ok(Array.isArray(known), '未知能力要把已知的列出来')
    assert.ok(known.includes('cli-echo.read'), '已知能力里要有这个器官的那条')
  })

  await check('0.5.20 相关性路由：按任务只给该读的页，不一股脑推（上传→隐私手册 / 插件→插件的自我管理 / 无关→兜底）', async () => {
    // ① 上传/发布：只该指向隐私清洗与交接规范
    const publish = await call('focus_context', { task: '把书同文推到公开仓库，先把隐私清干净' })
    assert.equal(publish.ok, true, publish.message)
    assert.deepEqual(publish.topics.map((t) => t.id), ['publish'], '上传任务只该命中 publish')
    const publishDocs = publish.read.map((d) => d.path)
    assert.ok(publishDocs.some((p) => p.includes('上传仓库前的隐私清洗')), '上传要先读隐私手册')
    assert.ok(!publishDocs.some((p) => p.includes('插件的自我管理')), '上传任务不该推插件手册')

    // ② 做插件：只指向合并后的《插件的自我管理》（0.5.21 起三页合一）
    const plugin = await call('focus_context', { task: '给插件加一个工具，走名片和联动契约' })
    assert.equal(plugin.ok, true, plugin.message)
    assert.deepEqual(plugin.topics.map((t) => t.id), ['plugin'])
    const pluginDocs = plugin.read.map((d) => d.path)
    assert.ok(pluginDocs.some((p) => p.includes('插件的自我管理')), '做插件要先读插件的自我管理')
    assert.ok(!pluginDocs.some((p) => p.includes('隐私清洗')), '做插件不该推隐私手册')

    // ③ 不相干的任务：退回手册总览，不硬猜
    const fallback = await call('focus_context', { task: '今天天气怎么样' })
    assert.equal(fallback.topics[0].id, 'general', '认不出来就退回 general')
    assert.ok(fallback.read.map((d) => d.path).includes('handoff/手册总览.md'), '兜底给手册总览')

    // ④ 没有 task：当场拒，不猜
    const missing = await call('focus_context', {})
    assert.equal(missing.ok, false)
    assert.equal(missing.errorCode, 'E_VALIDATION_BLOCKING')
  })

  await check('0.5.24/0.5.27 相关性主题表：九档全覆盖（18 大类）、教训/日档/项目白板动态预读、优先级唯一', async () => {
    const relevance = await import('../lib/relevance.js')

    // ① 表本身没写坏：id/priority 不重复、tier 认识、每类至少一页文档或一条动态目录
    const v = relevance.validateTopics()
    assert.equal(v.ok, true, `主题表自检没过：${v.errors.join('；')}`)
    assert.equal(v.schemaVersion, 2, '表结构版本要带出来，方便老时空看出「表变过」')

    // ② 清点：18 个主题 + 兜底 = 19 大类，按 priority 从高到低
    const table = relevance.topicTable()
    assert.equal(table.length, 19, '18 个主题 + 兜底 = 19 大类')
    assert.deepEqual(
      table.map((t) => t.id),
      [
        'handoff', 'project', 'plugin', 'dsh-api', 'boundary', 'publish', 'lessons', 'self', 'files', 'restart', 'logs',
        'ledger', 'created', 'incoming', 'downloads', 'config', 'scratch', 'archive', 'general',
      ],
    )
    const priorities = table.map((t) => t.priority)
    assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a), '目录表要按 priority 从高到低')
    assert.equal(new Set(priorities).size, priorities.length, 'priority 不重复，同分排不出先后')
    for (const row of table) {
      assert.ok(row.tierLabel, `${row.id} 要有分档说明`)
      assert.ok(row.docs >= 1, `${row.id} 至少一页文档`)
    }

    // ③ 九档全覆盖：九个档名都能在主题表里认出来
    for (const id of ['handoff', 'created', 'downloads', 'incoming', 'scratch', 'archive', 'logs', 'config', 'self']) {
      assert.ok(table.some((t) => t.id === id), `九档缺 ${id}`)
    }

    // ④ 动态文档：教训按任务挑、日档按日期挑，都不是死名单
    assert.equal(table.find((t) => t.id === 'lessons').dynamic, true, '教训日记要按任务动态挑')
    assert.equal(table.find((t) => t.id === 'self').dynamic, true, '日档要按日期动态挑')
    assert.equal(table.find((t) => t.id === 'project').dynamic, true, '项目白板要按任务动态挑')

    // ⑤ 同分时按 priority 定先后：交接（94）比文件存放（74）靠前
    const tie = relevance.detectTopics('交接 文件')
    assert.equal(tie.length, 2, '两个词都该命中')
    assert.equal(tie[0].id, 'handoff', '同分时 priority 高的排前面')

    // ⑥ 认不出来就是空数组（由 routeFocus 退兜底），不硬猜
    assert.deepEqual(relevance.detectTopics('今天天气'), [])

    // ⑦ 教训预读：任务没提「教训」，也要把同类的坑推出来，并指出原文行
    await fsp.mkdir(path.join(root, 'handoff', '教训日记'), { recursive: true })
    const lessonPath = path.join(root, 'handoff', '教训日记', '2026-11-01-插件工具定义事故.md')
    await fsp.writeFile(
      lessonPath,
      '# 2026-11-01 插件工具定义事故\n\n## 发生了什么\n改插件工具定义后 DSH 起不来，面板空着。\n\n## 根因\n工具 schema 少写必填字段。\n\n## 下次怎么做\n改完先 node --check，再单独加载一次，看返回里的 note。\n',
      'utf8',
    )
    const auto = await call('focus_context', { task: '给插件补一个工具定义' })
    assert.equal(auto.ok, true, auto.message)
    assert.ok(auto.topics.some((t) => t.id === 'lessons' && t.auto === true), '没提教训也要自动推同类的坑')
    const lessonDoc = auto.read.find((d) => String(d.path).includes('插件工具定义事故'))
    assert.ok(lessonDoc, '要推到那篇同类的教训')
    assert.ok(Array.isArray(lessonDoc.matched) && lessonDoc.matched.length > 0, '要指出可能踩到的原文行')

    // ⑧ self：关于我自己的事，要推到 self 档与最近日档
    await fsp.mkdir(path.join(root, 'self', '日档'), { recursive: true })
    await fsp.writeFile(path.join(root, 'self', 'README.md'), '# self\n', 'utf8')
    await fsp.writeFile(path.join(root, 'self', '日档', '2026-11-06-冒烟时空.md'), '# 2026-11-06 冒烟时空\n\n## 触点\n…\n', 'utf8')
    const me = await call('focus_context', { task: '写今天的日档，再补一下人格记忆' })
    assert.equal(me.ok, true, me.message)
    assert.ok(me.topics.some((t) => t.id === 'self'), '关于我自己的事要命中 self')
    const selfDocs = me.read.map((d) => d.path)
    assert.ok(selfDocs.includes('self/README.md'), '要推 self 总说明')
    assert.ok(selfDocs.some((p) => String(p).includes('self/日档/')), '要推最近的日档')

    // ⑨ 自检真的会拦：id 与 priority 重复都要报
    const broken = relevance.validateTopics([
      { id: 'dup', label: 'A', tier: 'core', priority: 10, keywords: ['a'], docs: [{ path: 'handoff/a.md', why: 'a' }] },
      { id: 'dup', label: 'B', tier: 'core', priority: 10, keywords: ['b'], docs: [{ path: 'handoff/b.md', why: 'b' }] },
    ])
    assert.equal(broken.ok, false, '写坏的表必须被拦住')
    assert.ok(broken.errors.some((e) => e.includes('id 重复')), '要报 id 重复')
    assert.ok(broken.errors.some((e) => e.includes('priority 重复')), '要报 priority 重复')
  })

  await check('0.5.26 点名项目时自动带项目白板（当前一棒/挂账给行号），不点名就不推 projects', async () => {
    await fsp.mkdir(path.join(root, 'handoff', 'projects'), { recursive: true })
    const filler = '这是一段无关的历史记录，用来把小节顶到很后面。\n'.repeat(120)
    await fsp.writeFile(
      path.join(root, 'handoff', 'projects', 'smoke-project.md'),
      `# 冒烟项目\n\n## 目标\n只做冒烟。\n\n## 历史\n${filler}\n## 当前一棒\n接着做 0.5.27。\n\n## ⚠ 挂账\n一条待清。\n`,
      'utf8',
    )
    const focused = await call('focus_context', { task: '随便看看', project: 'smoke-project' })
    assert.equal(focused.ok, true, focused.message)
    const board = focused.read.find((d) => d.path === 'handoff/projects/smoke-project.md')
    assert.ok(board, '点名项目要把该项目的白板带上')
    assert.ok(board.headings.some((h) => String(h.text).includes('当前一棒')), '当前一棒在很后面也要指到行号')
    assert.ok(board.headings.some((h) => String(h.text).includes('挂账')), '挂账行也要指出来')
    const noProject = await call('focus_context', { task: '随便看看' })
    assert.equal(
      noProject.read.some((d) => String(d.path).startsWith('handoff/projects/')),
      false,
      '没点名项目时不要把 projects 整个推出去',
    )
  })

  await check('0.5.27 项目白板自动预读：任务提到项目名就带该白板，不相关就不带', async () => {
    await fsp.mkdir(path.join(root, 'handoff', 'projects'), { recursive: true })
    await fsp.writeFile(
      path.join(root, 'handoff', 'projects', 'tongwen-plugin.md'),
      '# 书同文 0.5.99\n\n## 当前一棒\n继续弄插件。\n\n## ⚠ 挂账\n无。\n',
      'utf8',
    )
    const autoBoard = await call('focus_context', { task: '书同文插件' })
    const board = autoBoard.read.find((d) => d.path === 'handoff/projects/tongwen-plugin.md')
    assert.ok(board, '任务提到项目名要自动带白板')
    assert.equal(board.auto, true, '自动带的白板要标记 auto')
    assert.ok(board.headings.some((h) => String(h.text).includes('当前一棒')), '自动带的也要指到当前一棒')
    const unrelated = await call('focus_context', { task: '今天天气' })
    assert.equal(
      unrelated.read.some((d) => String(d.path).startsWith('handoff/projects/')),
      false,
      '不相关就不推项目白板',
    )
  })

  await check('0.5.28 账本日报动态预读：任务提到账本/花费就带最近两天日报，不相关不带', async () => {
    await fsp.mkdir(path.join(root, 'logs', '账本'), { recursive: true })
    await fsp.writeFile(path.join(root, 'logs', '账本', '2026-11-06.md'), '# 账本 11-06\n\n| 调用次数 | 1 |\n', 'utf8')
    await fsp.writeFile(path.join(root, 'logs', '账本', '2026-11-07.md'), '# 账本 11-07\n\n| 调用次数 | 2 |\n', 'utf8')
    await fsp.writeFile(path.join(root, 'logs', '账本', 'README.md'), '# 账本目录说明\n', 'utf8')
    const led = await call('focus_context', { task: '看看这个月的账本花费' })
    const paths = led.read.map((d) => d.path)
    assert.ok(paths.includes('logs/账本/2026-11-07.md'), '要带最近一天的账本日报')
    assert.ok(paths.includes('logs/账本/2026-11-06.md'), '要带前一天的账本日报')
    assert.equal(paths.includes('logs/账本/README.md'), false, 'README 不推')
    assert.ok(paths.includes('logs/账本/记录规范.md'), '记录规范照旧要带')
    const off = await call('focus_context', { task: '今天天气' })
    assert.equal(
      off.read.some((d) => String(d.path).startsWith('logs/账本/') && /\d{4}-\d{2}-\d{2}/.test(d.path)),
      false,
      '不相关就不推账本日报',
    )
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








