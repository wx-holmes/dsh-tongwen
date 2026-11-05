/**
 * 文件锁 —— 规格 §10.6 冻结协议。
 *
 * 锁目录：config/plugins/tongwen-tonggui/locks/
 * 锁文件：lock-<sha256(绝对路径) 前 16 位>.lock
 * 内容：{resource, holder, acquiredAt, purpose}
 *
 * O_CREAT|O_EXCL 建锁；失败轮询 50ms。
 * 超时 → E_LOCK_TIMEOUT，**不自动破锁**。
 * stale 只告警、不破锁（§14.1 明文禁止自动删除 stale 锁）。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pluginError } from './errors.js'

/** 轮询间隔（规格固定 50ms）。 */
const POLL_MS = 50

/**
 * 锁文件名：资源绝对路径的 sha256 前 16 位。
 * @param {string} lockDir
 * @param {string} resource 被保护的资源（通常是绝对路径）
 * @returns {string}
 */
export function lockFileFor(lockDir, resource) {
  const digest = createHash('sha256')
    .update(String(resource).toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 16)
  return path.join(lockDir, `lock-${digest}.lock`)
}

/**
 * @typedef {object} LockOptions
 * @property {number} [acquireTimeoutMs] 默认 10000（§15.1 lockAcquireTimeoutMs）
 * @property {number} [staleMs] 默认 300000（§15.1 lockStaleMs）
 * @property {string} [holder] 持锁者标识
 * @property {string} [purpose] 目的
 */

/**
 * 获取锁。拿不到会抛 E_LOCK_TIMEOUT（不返回 null，避免调用方忘记判空）。
 * 拿到后必须用 try/finally 调 release。
 *
 * @param {string} lockDir 绝对路径
 * @param {string} resource 被保护资源
 * @param {LockOptions} [options]
 * @returns {Promise<{path: string, release: () => Promise<void>, staleWarning: null | {resource: string, acquiredAt: string}}>}
 */
export async function acquireLock(lockDir, resource, options = {}) {
  const {
    acquireTimeoutMs = 10_000,
    staleMs = 300_000,
    holder = 'dsh',
    purpose = '',
  } = options

  await fsp.mkdir(lockDir, { recursive: true })
  const lockPath = lockFileFor(lockDir, resource)
  const payload = JSON.stringify({
    resource,
    holder,
    acquiredAt: new Date().toISOString(),
    purpose,
  })

  const deadline = Date.now() + acquireTimeoutMs
  let staleWarning = null

  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx')
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }

      let released = false
      const release = async () => {
        if (released) return
        released = true
        try { await fsp.unlink(lockPath) } catch { /* 已被清除则视为成功 */ }
      }

      return { path: lockPath, release, staleWarning }
    } catch (error) {
      const code = String(/** @type {any} */ (error)?.code ?? '')

      if (code === 'EACCES' || code === 'EPERM') {
        throw pluginError('E_PERMISSION', { target: lockPath })
      }
      if (code !== 'EEXIST') {
        throw pluginError('E_IO', { target: lockPath, reason: code || 'unknown' })
      }

      // 锁已存在：判断是否 stale（只记录、不破锁），然后继续轮询。
      if (!staleWarning) {
        staleWarning = await detectStale(lockPath, resource, staleMs)
      }

      if (Date.now() >= deadline) {
        throw pluginError('E_LOCK_TIMEOUT', { resource: path.basename(lockPath) })
      }
      await sleep(POLL_MS)
    }
  }
}

/**
 * 判定疑似残留锁。以 acquiredAt 为主，缺失或时钟异常用 mtime 兜底。
 * @param {string} lockPath
 * @param {string} resource
 * @param {number} staleMs
 * @returns {Promise<null | {resource: string, acquiredAt: string}>}
 */
async function detectStale(lockPath, resource, staleMs) {
  try {
    const raw = await fsp.readFile(lockPath, 'utf8')
    const parsed = JSON.parse(raw)
    const acquired = Date.parse(parsed?.acquiredAt ?? '')
    if (Number.isFinite(acquired)) {
      if (Date.now() - acquired > staleMs) {
        return { resource, acquiredAt: String(parsed.acquiredAt) }
      }
      return null
    }
  } catch {
    // 内容读不出/解析失败 → 落到 mtime 兜底。
  }

  try {
    const stat = await fsp.stat(lockPath)
    if (Date.now() - stat.mtimeMs > staleMs) {
      return { resource, acquiredAt: new Date(stat.mtimeMs).toISOString() }
    }
  } catch {
    // 锁在判定期间消失：交给下一轮 EEXIST 重试。
  }
  return null
}

/**
 * 包一段「加锁 → 干活 → 解锁」的便捷封装。
 * 失败时把 staleWarning 透传给调用方，由调用方决定是否写 open-items lock_stale。
 *
 * @template T
 * @param {string} lockDir
 * @param {string} resource
 * @param {LockOptions} options
 * @param {(handle: {staleWarning: null | {resource: string, acquiredAt: string}}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLock(lockDir, resource, options, fn) {
  const handle = await acquireLock(lockDir, resource, options)
  try {
    return await fn({ staleWarning: handle.staleWarning })
  } finally {
    await handle.release()
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
