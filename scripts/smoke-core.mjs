/**
 * 骨架层 smoke —— 不装插件、不碰盘根，只验证 lib/ 的纯逻辑与文件协议。
 *
 * 跑法：node scripts/smoke-core.mjs
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { BUCKET_LIST, BUCKET_KEYS, bucketByPhysical, assertKnownBucket } from '../lib/buckets.js'
import { slugify, typeSlugFor, RESERVED_NAMES, checkFullPathLength } from '../lib/naming.js'
import { splitBucketPath, resolveInBucket, assertNotBucketRoot, absoluteLikeReason } from '../lib/paths.js'
import { resolveConfig, CONFIG_SPEC } from '../lib/config.js'
import { writeFileAtomic, appendLine, readJsonl } from '../lib/atomic.js'
import { acquireLock } from '../lib/locks.js'
import { AuditWriter } from '../lib/audit.js'
import { ulid, isValidTaskId, generatedTaskId, generatedSessionId } from '../lib/ulid.js'

let passed = 0
const failures = []

/** @param {string} name @param {() => void | Promise<void>} fn */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}`)
    console.log(`       ${String(error?.message ?? error).split('\n').slice(0, 3).join('\n       ')}`)
  }
}

function expectThrows(fn, code) {
  try {
    fn()
  } catch (error) {
    assert.equal(error?.code, code, `期望 ${code}，实际 ${error?.code}：${error?.message}`)
    return
  }
  assert.fail(`期望抛出 ${code}，但没有抛出`)
}

async function expectRejects(promise, code) {
  try {
    await promise
  } catch (error) {
    assert.equal(error?.code, code, `期望 ${code}，实际 ${error?.code}：${error?.message}`)
    return
  }
  assert.fail(`期望 reject ${code}，但没有 reject`)
}

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tongwen-smoke-'))
console.log(`临时根：${tmpRoot}\n`)

// ── 九档 ─────────────────────────────────────────────
await test('九档：恰好 9 个，物理名全小写 ASCII', () => {
  assert.equal(BUCKET_LIST.length, 9)
  assert.equal(BUCKET_KEYS.length, 9)
  for (const b of BUCKET_LIST) {
    assert.match(b.physical, /^[a-z]+$/, `物理名不合规：${b.physical}`)
    assert.ok(b.display.length > 0)
  }
  assert.deepEqual(BUCKET_KEYS, [
    'handoff', 'created', 'downloads', 'incoming', 'scratch',
    'archive', 'logs', 'config', 'self',
  ])
})

await test('九档：第 10 档被拒绝，带可读理由', () => {
  assert.equal(assertKnownBucket('created').ok, true)
  const verdict = assertKnownBucket('media')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /九档白名单/)
})

await test('九档：大小写不敏感查找', () => {
  assert.equal(bucketByPhysical('HANDOFF')?.physical, 'handoff')
  assert.equal(bucketByPhysical('nope'), undefined)
})

// ── 命名 ─────────────────────────────────────────────
await test('slug：中文全变分隔符 → 空（交给调用方问用户）', () => {
  assert.equal(slugify('春节促销'), '')
})

await test('slug：大小写 / 特殊字符 / 折叠 / 去首尾', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
  assert.equal(slugify('  A__B//C  '), 'a-b-c')
  assert.equal(slugify('---abc---'), 'abc')
  assert.equal(slugify('a1_b2'), 'a1-b2')
})

await test('slug：保留名追加 -file，且总长不超 48', () => {
  for (const reserved of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9']) {
    const out = slugify(reserved)
    assert.equal(out, `${reserved}-file`, `${reserved} 应变成 ${reserved}-file，实际 ${out}`)
  }
  const long = slugify('x'.repeat(60))
  assert.ok(long.length <= 48, `长度 ${long.length} 超限`)
})

await test('slug：48 位截断边界', () => {
  const out = slugify('a'.repeat(100))
  assert.equal(out.length, 48)
  assert.ok(RESERVED_NAMES.includes('con'))
})

await test('typeSlug：已有 displayName 复用 slug', () => {
  const existing = [{ typeDisplayName: '春节促销', typeSlug: 'chunjie' }]
  const out = typeSlugFor('春节促销', existing)
  assert.equal(out.reused, true)
  assert.equal(out.typeSlug, 'chunjie')
})

await test('typeSlug：中文无 ASCII → type-<hash8> 兜底', () => {
  const out = typeSlugFor('春节促销')
  assert.match(out.typeSlug, /^type-[0-9a-f]{8}$/)
})

await test('typeSlug：纯英文正常转换', () => {
  const out = typeSlugFor('Weekly Report')
  assert.equal(out.typeSlug, 'weekly-report')
})

await test('typeSlug：碰撞追加序号', () => {
  const existing = [
    { typeDisplayName: 'Weekly', typeSlug: 'weekly' },
    { typeDisplayName: 'Weekly Report', typeSlug: 'weekly-report' },
  ]
  const out = typeSlugFor('Weekly-Report', existing)
  assert.notEqual(out.typeSlug, 'weekly-report')
  assert.match(out.typeSlug, /^weekly-report-\d+$/)
})

await test('typeSlug：禁止 type+交接 形式', () => {
  const out = typeSlugFor('交接')
  assert.ok(!out.typeSlug.endsWith('交接'), out.typeSlug)
  assert.match(out.typeSlug, /^type-[0-9a-f]{8}$/)
})

await test('路径总长：超 240 报原因，不静默', () => {
  const ok = checkFullPathLength('C:\\work\\dsh-tongwen\\lib\\a.js')
  assert.equal(ok.ok, true)
  const bad = checkFullPathLength(`C:\\${'x'.repeat(300)}`)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /缩短实例名/)
})

// ── 路径安全 ─────────────────────────────────────────
await test('splitBucketPath：合法解析', () => {
  assert.deepEqual(splitBucketPath('created/foo/bar.txt'), { bucket: 'created', relPath: 'foo/bar.txt' })
  assert.deepEqual(splitBucketPath('handoff\\self\\x.md'), { bucket: 'handoff', relPath: 'self/x.md' })
})

await test('splitBucketPath：拒绝第 10 档 / 缺 bucket / 绝对路径 / ..', () => {
  expectThrows(() => splitBucketPath('media/a.txt'), 'E_VALIDATION_BLOCKING')
  expectThrows(() => splitBucketPath('a.txt'), 'E_VALIDATION_BLOCKING')
  expectThrows(() => splitBucketPath('created/../escape'), 'E_VALIDATION_BLOCKING')
  expectThrows(() => splitBucketPath('created/C:/x'), 'E_VALIDATION_BLOCKING')
  expectThrows(() => splitBucketPath('created//server/share'), 'E_VALIDATION_BLOCKING')
})

await test('absoluteLikeReason 覆盖盘符 / UNC / ..', () => {
  assert.match(absoluteLikeReason('C:/x'), /盘符/)
  assert.match(absoluteLikeReason('//srv/share'), /UNC/)
  assert.match(absoluteLikeReason('../x'), /\.\./)
  assert.equal(absoluteLikeReason('a/b.txt'), null)
})

await test('resolveInBucket：正常路径解析到档内', async () => {
  const abs = await resolveInBucket(tmpRoot, 'created', 'a/b.txt')
  assert.ok(abs.toLowerCase().endsWith(path.join('created', 'a', 'b.txt').toLowerCase()))
})

await test('resolveInBucket：.. 越界被拒', async () => {
  await expectRejects(resolveInBucket(tmpRoot, 'created', '../escape.txt'), 'E_VALIDATION_BLOCKING')
})

await test('resolveInBucket：未知 bucket 被拒', async () => {
  await expectRejects(resolveInBucket(tmpRoot, 'media', 'x.txt'), 'E_VALIDATION_BLOCKING')
})

await test('assertNotBucketRoot：命中九档顶层就拒绝', () => {
  expectThrows(() => assertNotBucketRoot(tmpRoot, path.join(tmpRoot, 'created'), '删除'), 'E_VALIDATION_BLOCKING')
  expectThrows(() => assertNotBucketRoot(tmpRoot, path.join(tmpRoot, 'created', '..', 'self')), 'E_VALIDATION_BLOCKING')
  // 档内路径不受影响。
  assertNotBucketRoot(tmpRoot, path.join(tmpRoot, 'created', 'a.txt'), '删除')
})

// ── 配置 ─────────────────────────────────────────────
await test('配置：空配置 → 全部默认', () => {
  const { values, issues } = resolveConfig(null)
  assert.equal(issues.length, 0)
  assert.equal(values['report.triggerJournalCount'], 20)
  assert.equal(values['selfScan.hashMaxFileMB'], 64)
  assert.equal(values['task.defaultTaskIdScope'], 'unknown')
})

await test('配置：字段覆盖生效', () => {
  const { values } = resolveConfig({ report: { triggerJournalCount: 5 } })
  assert.equal(values['report.triggerJournalCount'], 5)
  assert.equal(values['report.triggerDays'], 7)
})

await test('配置：非法值回退默认并报 invalid', () => {
  const { values, issues } = resolveConfig({ report: { triggerJournalCount: 0 } })
  assert.equal(values['report.triggerJournalCount'], 20)
  assert.ok(issues.some((i) => i.kind === 'invalid' && i.field === 'report.triggerJournalCount'))
})

await test('配置：未知字段只报告不阻断', () => {
  const { issues } = resolveConfig({ report: { nope: 1 }, weird: 2 })
  const unknown = issues.filter((i) => i.kind === 'unknownField').map((i) => i.field)
  assert.deepEqual(unknown.sort(), ['report.nope', 'weird'])
})

await test('配置：跨字段约束违反 → 两字段一起回退', () => {
  const { values, issues } = resolveConfig({
    selfScan: { hashMaxFileMB: 2048, skipHashMB: 1024 },
  })
  assert.equal(values['selfScan.hashMaxFileMB'], 64)
  assert.equal(values['selfScan.skipHashMB'], 1024)
  assert.ok(issues.some((i) => /constraintViolated/.test(i.reason)))
})

await test('配置：配表共 43 个字段名（§15.1 逐行核对 + 0.3.28 housekeeping + 0.4.0 organs + 0.4.3 gate）', () => {
  assert.equal(Object.keys(CONFIG_SPEC).length, 43, `实际 ${Object.keys(CONFIG_SPEC).length}`)
  for (const frozen of [
    'report.triggerJournalCount', 'report.triggerDays',
    'housekeeping.auditDays', 'housekeeping.ledgerDays', 'housekeeping.trashDays',
    'housekeeping.scratchDays', 'housekeeping.reportEveryDays',
      'organs.enabled', 'organs.roots', 'organs.gateDir', 'organs.gateTimeoutMs',
    'archive.keepVersionsK', 'archive.trashRetentionDays',
    'safety.batchFileThreshold', 'safety.batchSizeThresholdMB',
    'selfScan.timeoutMs', 'selfScan.maxFiles', 'selfScan.maxDepth',
    'selfScan.followSymlinks', 'selfScan.hashMaxFileMB', 'selfScan.skipHashMB', 'selfScan.scope',
    'heartbeat.intervalMs', 'task.allowGeneratedTaskId', 'task.defaultTaskIdScope',
    'handoff.artifactTreeMaxFiles', 'handoff.artifactTreeMaxMB', 'handoff.artifactHashFailWarnRatio',
    'direction.maxLineKB', 'direction.quoteMaxChars', 'direction.warnBrokenLink',
    'openItems.maxActive', 'openItems.summaryMaxChars', 'degraded.auditFallbackRetry',
    'audit.lockTimeoutMs', 'audit.maxFileMB', 'audit.retentionDays',
    'lockAcquireTimeoutMs', 'lockStaleMs', 'eventDedup.maxIds',
    'tools.listHandoffsDefaultLimit', 'tools.listHandoffsMaxLimit', 'tools.inspectMaxKB',
  ]) {
    assert.ok(frozen in CONFIG_SPEC, `冻结字段缺失：${frozen}`)
  }
})

// ── 原子写 / 追加 ────────────────────────────────────
await test('writeFileAtomic：写入并可读回，无 tmp 残留', async () => {
  const target = path.join(tmpRoot, 'atomic.txt')
  await writeFileAtomic(target, 'hello 书同文')
  assert.equal(await fsp.readFile(target, 'utf8'), 'hello 书同文')
  const dir = await fsp.readdir(path.dirname(target))
  assert.ok(!dir.some((f) => f.includes('.tmp.')), `残留 tmp：${dir.join(',')}`)
})

await test('appendLine：逐行追加，末尾有换行', async () => {
  const file = path.join(tmpRoot, 'stream.jsonl')
  await appendLine(file, '{"a":1}')
  await appendLine(file, '{"a":2}')
  const text = await fsp.readFile(file, 'utf8')
  assert.equal(text, '{"a":1}\n{"a":2}\n')
})

await test('readJsonl：坏行跳过并记 malformed，不抛', async () => {
  const file = path.join(tmpRoot, 'bad.jsonl')
  await fsp.writeFile(file, '{"ok":1}\nnot json\n{"ok":2}\n', 'utf8')
  const { records, malformed } = await readJsonl(file)
  assert.equal(records.length, 2)
  assert.equal(malformed.length, 1)
  assert.equal(malformed[0].line, 2)
})

// ── 锁 ───────────────────────────────────────────────
await test('锁：获取 → 释放，锁文件消失', async () => {
  const lockDir = path.join(tmpRoot, 'locks')
  const handle = await acquireLock(lockDir, path.join(tmpRoot, 'res-a'))
  assert.ok(await fsp.stat(handle.path))
  await handle.release()
  await assert.rejects(fsp.stat(handle.path))
})

await test('锁：同资源第二次获取超时 → E_LOCK_TIMEOUT', async () => {
  const lockDir = path.join(tmpRoot, 'locks2')
  const resource = path.join(tmpRoot, 'res-b')
  const first = await acquireLock(lockDir, resource)
  try {
    await expectRejects(
      acquireLock(lockDir, resource, { acquireTimeoutMs: 200 }),
      'E_LOCK_TIMEOUT',
    )
  } finally {
    await first.release()
  }
})

await test('锁：stale 只标记不破锁', async () => {
  const lockDir = path.join(tmpRoot, 'locks3')
  const resource = path.join(tmpRoot, 'res-c')
  const first = await acquireLock(lockDir, resource)
  try {
    await fsp.writeFile(
      first.path,
      JSON.stringify({ resource, holder: 'old', acquiredAt: '2000-01-01T00:00:00.000Z', purpose: '' }),
      'utf8',
    )
    try {
      await acquireLock(lockDir, resource, { acquireTimeoutMs: 150, staleMs: 10 })
      assert.fail('应当超时')
    } catch (error) {
      assert.equal(error.code, 'E_LOCK_TIMEOUT')
    }
    // 没有被自动删除——这是 §14.1 的硬要求。
    assert.ok(await fsp.stat(first.path))
  } finally {
    await first.release()
  }
})

// ── 审计 ─────────────────────────────────────────────
await test('审计：写一条，字段齐全且可解析', async () => {
  const config = resolveConfig(null).values
  const writer = new AuditWriter({ root: tmpRoot, config })
  const res = await writer.write({ op: 'tools.locate', target: 'created/a.txt', result: 'ok' })
  assert.equal(res.ok, true)
  assert.equal(writer.degradedLevel, 'normal')

  const dir = path.join(tmpRoot, 'logs', 'audit')
  const files = await fsp.readdir(dir)
  assert.equal(files.length, 1)
  const { records } = await readJsonl(path.join(dir, files[0]))
  assert.equal(records.length, 1)
  const rec = records[0]
  for (const key of ['at', 'eventId', 'op', 'target', 'result', 'sessionId', 'effectiveTaskKey']) {
    assert.ok(key in rec, `缺字段 ${key}`)
  }
  assert.equal(rec.op, 'tools.locate')
  assert.equal(rec.result, 'ok')
})

await test('审计：超长事件被截断且带 truncated', async () => {
  const config = resolveConfig(null).values
  const writer = new AuditWriter({ root: tmpRoot, config })
  const huge = 'x'.repeat(80 * 1024)
  await writer.write({ op: 'big', target: huge, result: 'warn', error: { code: 'E_IO', message: huge } })
  const dir = path.join(tmpRoot, 'logs', 'audit')
  const files = (await fsp.readdir(dir)).sort()
  const last = files[files.length - 1]
  const raw = await fsp.readFile(path.join(dir, last), 'utf8')
  for (const line of raw.split('\n').filter(Boolean)) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 16 * 1024 + 8, `单条 ${Buffer.byteLength(line)} 超 16KB`)
  }
})

// ── ID ───────────────────────────────────────────────
await test('ULID：26 位、唯一', () => {
  const a = ulid()
  const b = ulid()
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.notEqual(a, b)
})

await test('taskId：格式校验', () => {
  assert.equal(isValidTaskId('t-2026-001'), true)
  assert.equal(isValidTaskId('a'.repeat(128)), true)
  assert.equal(isValidTaskId('a'.repeat(129)), false)
  assert.equal(isValidTaskId('has space'), false)
  assert.equal(isValidTaskId('a/b'), false)
})

await test('generatedTaskId / generatedSessionId 形状', () => {
  assert.equal(generatedTaskId('sess-1', 3), 'auto-sess-1-3')
  assert.match(generatedSessionId(), /^gen-\d{8}T\d{6}Z-[0-9a-f]{8}$/)
})

// ── 收尾 ─────────────────────────────────────────────
await fsp.rm(tmpRoot, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const f of failures) {
    console.log(`\n[${f.name}]`)
    console.log(String(f.error?.stack ?? f.error))
  }
  process.exitCode = 1
}
