/**
 * 哈希 —— 规格 §15.6 产物清单语义。
 *
 * 三档精度：
 *   full    ：size ≤ hashMaxFileMB → 全文 SHA-256
 *   sampled ：hashMaxFileMB < size ≤ skipHashMB → size + mtime + 首 64KB + 尾 64KB
 *   meta    ：size > skipHashMB → 只记 size + mtimeMs
 *
 * sampled / meta 的精度损失必须能被告知（§8.3 要求写进文档与 journal 备注），
 * 所以这里把 hashMode 一起返回，调用方不许丢。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'

const SAMPLE_BYTES = 64 * 1024

/**
 * @param {Buffer|string} data
 * @returns {string}
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 流式全文哈希（避免把大文件整个读进内存）。
 * @param {string} absPath
 * @returns {Promise<string>}
 */
export async function sha256File(absPath) {
  const hash = createHash('sha256')
  const handle = await fsp.open(absPath, 'r')
  try {
    const stream = handle.createReadStream()
    for await (const chunk of stream) hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * @typedef {object} HashResult
 * @property {'ok'|'partial'|'failed'|'missing'|'unknown'|'skipped_too_large'} hashStatus
 * @property {string|null} hash
 * @property {'full'|'sampled'|'meta'} [hashMode]
 * @property {number} size
 * @property {number} [mtimeMs]
 * @property {string} [reason]
 */

/**
 * 按 §8.3 的三档口径算一个普通文件的哈希。
 * @param {string} absPath
 * @param {{hashMaxFileMB: number, skipHashMB: number}} limits
 * @returns {Promise<HashResult>}
 */
export async function hashFileSmart(absPath, limits) {
  const hashMaxBytes = Number(limits.hashMaxFileMB) * 1024 * 1024
  const skipBytes = Number(limits.skipHashMB) * 1024 * 1024

  let stat
  try {
    stat = await fsp.lstat(absPath)
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { hashStatus: 'missing', hash: null, size: 0 }
    }
    return { hashStatus: 'unknown', hash: null, size: 0, reason: code || 'lstat 失败' }
  }

  if (stat.isSymbolicLink()) {
    try {
      const target = await fsp.readlink(absPath)
      return {
        hashStatus: 'ok',
        hash: sha256(target),
        hashMode: 'full',
        size: 0,
      }
    } catch (error) {
      return { hashStatus: 'failed', hash: null, size: 0, reason: String(/** @type {any} */ (error)?.code ?? '') }
    }
  }

  if (!stat.isFile()) {
    return { hashStatus: 'ok', hash: null, size: 0, hashMode: 'meta' }
  }

  const size = stat.size
  const mtimeMs = stat.mtimeMs

  if (size <= hashMaxBytes) {
    try {
      return { hashStatus: 'ok', hash: await sha256File(absPath), hashMode: 'full', size, mtimeMs }
    } catch (error) {
      return { hashStatus: 'failed', hash: null, size, mtimeMs, reason: String(/** @type {any} */ (error)?.code ?? '') }
    }
  }

  if (size <= skipBytes) {
    try {
      const handle = await fsp.open(absPath, 'r')
      try {
        const head = Buffer.alloc(SAMPLE_BYTES)
        const headRead = await handle.read(head, 0, SAMPLE_BYTES, 0)
        const tailStart = Math.max(0, size - SAMPLE_BYTES)
        const tail = Buffer.alloc(SAMPLE_BYTES)
        const tailRead = await handle.read(tail, 0, SAMPLE_BYTES, tailStart)
        const combined = createHash('sha256')
          .update(`${size}:${mtimeMs}:`)
          .update(head.subarray(0, headRead.bytesRead))
          .update(tail.subarray(0, tailRead.bytesRead))
          .digest('hex')
        return { hashStatus: 'partial', hash: combined, hashMode: 'sampled', size, mtimeMs }
      } finally {
        await handle.close()
      }
    } catch (error) {
      return { hashStatus: 'failed', hash: null, size, mtimeMs, reason: String(/** @type {any} */ (error)?.code ?? '') }
    }
  }

  return { hashStatus: 'partial', hash: null, hashMode: 'meta', size, mtimeMs }
}

/**
 * 目录 treeHash（§15.6）：只计普通文件与符号链接，不计子目录本身；空子目录不影响。
 *
 * @param {string} absDir
 * @param {{maxFiles: number, maxMB: number}} limits
 * @returns {Promise<{hash: string|null, hashStatus: HashResult['hashStatus'], size: number, fileCount: number, reason?: string}>}
 */
export async function treeHash(absDir, limits) {
  const maxFiles = Number(limits.maxFiles ?? 1_000)
  const maxBytes = Number(limits.maxMB ?? 256) * 1024 * 1024

  /** @type {Array<{rel: string, hash: string|null, size: number}>} */ const entries = []
  let totalBytes = 0
  let stopped = false
  /** @type {string|null} */ let stopReason = null

  /** @param {string} dir @param {string} prefix */
  async function walk(dir, prefix) {
    if (stopped) return
    let items
    try {
      items = await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      stopped = true
      stopReason = String(/** @type {any} */ (error)?.code ?? 'readdir 失败')
      return
    }
    for (const item of items) {
      if (stopped) return
      const abs = path.join(dir, item.name)
      const rel = prefix ? `${prefix}/${item.name}` : item.name

      if (item.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (entries.length >= maxFiles) {
        stopped = true
        stopReason = 'fileCount'
        return
      }

      let size = 0
      let hash = null
      if (item.isSymbolicLink()) {
        try {
          hash = sha256(await fsp.readlink(abs))
        } catch {
          hash = null
        }
      } else if (item.isFile()) {
        try {
          const st = await fsp.lstat(abs)
          size = st.size
          totalBytes += size
          if (totalBytes > maxBytes) {
            stopped = true
            stopReason = 'totalBytes'
            return
          }
          hash = await sha256File(abs)
        } catch {
          hash = null
        }
      } else {
        continue // 非普通文件、非符号链接：不计入 treeHash
      }
      entries.push({ rel, hash, size })
    }
  }

  await walk(absDir, '')

  if (stopped) {
    return {
      hash: null,
      hashStatus: 'skipped_too_large',
      size: totalBytes,
      fileCount: entries.length,
      reason: stopReason ?? 'limit',
    }
  }

  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const aggregate = createHash('sha256')
  for (const entry of entries) {
    aggregate.update(`${entry.rel}\0${entry.hash ?? ''}\0${entry.size}\n`)
  }

  return {
    hash: aggregate.digest('hex'),
    hashStatus: entries.some((e) => e.hash === null) ? 'partial' : 'ok',
    size: totalBytes,
    fileCount: entries.length,
  }
}
