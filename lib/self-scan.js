/**
 * self/ 扫描 —— 规格 §8.2–§8.6。
 *
 * 这个模块最要紧的一句话：**不解析内容，只记三元组**。
 * 它不知道也不该知道 self/ 里放的是什么。
 *
 * 精度口径（§8.3）：
 *   full    ：≤ hashMaxFileMB           → 全文 SHA-256
 *   sampled ：≤ skipHashMB              → size + mtime + 首尾 64KB
 *   meta    ：> skipHashMB              → 只记 size + mtimeMs
 * 后两档含 mtime，所以 touch 也会被判成修改；sampled 可能漏报中间段变化。
 * 这个损失必须写进文档与 journal 备注，不许说成「内容未变」。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { sha256, hashFileSmart } from './hash.js'

/** 权限/读取失败时按 §8.4 重试一次。 */
const RETRY_DELAY_MS = 100

/**
 * @typedef {object} SelfFileEntry
 * @property {string} path      相对 self/ 的 POSIX 路径，NFC
 * @property {'file'|'symlink'|'nonRegular'} type
 * @property {number} size
 * @property {number} mtimeMs
 * @property {string|null} hash
 * @property {'full'|'sampled'|'meta'|'none'} hashMode
 * @property {boolean} [stale]
 * @property {string} [linkTarget]
 * @property {boolean} [externalLink]
 * @property {boolean} [unreadable]
 * @property {string} [errno]
 */

/**
 * @typedef {object} ScanResult
 * @property {SelfFileEntry[]} files
 * @property {boolean} partial
 * @property {'timeout'|'maxDepth'|'maxFiles'|null} partialReason
 * @property {number} scanned
 * @property {string[]} warnings
 */

/**
 * 递归扫描 self/。
 *
 * @param {string} selfDir
 * @param {object} options
 * @param {object} options.config 已 resolve 的配置（用 selfScan.* 子集）
 * @param {Map<string, SelfFileEntry>} [options.previous] 上一次快照（按 lower(path) 索引），用于 unreadable 时保留 stale
 * @param {string} [options.relPrefix] 相对路径前缀（0.3.7：scope 切换时保留来源标识，默认空）
 * @returns {Promise<ScanResult>}
 */
export async function scanSelf(selfDir, { config, previous, relPrefix = '' }) {
  const limits = {
    timeoutMs: Number(config['selfScan.timeoutMs']),
    maxDepth: Number(config['selfScan.maxDepth']),
    maxFiles: Number(config['selfScan.maxFiles']),
    followSymlinks: Boolean(config['selfScan.followSymlinks']),
    hashMaxFileMB: Number(config['selfScan.hashMaxFileMB']),
    skipHashMB: Number(config['selfScan.skipHashMB']),
  }

  /** @type {SelfFileEntry[]} */ const files = []
  /** @type {string[]} */ const warnings = []
  let partial = false
  /** @type {'timeout'|'maxDepth'|'maxFiles'|null} */ let partialReason = null
  const startedAt = Date.now()

  const realSelf = await fsp.realpath(selfDir).catch(() => null)

  /**
   * @param {string} dirAbs
   * @param {string} relPrefix
   * @param {number} depth
   */
  async function walk(dirAbs, relPrefix, depth) {
    if (partial) return

    if (depth > limits.maxDepth) {
      partial = true
      partialReason = 'maxDepth'
      return
    }
    if (Date.now() - startedAt > limits.timeoutMs) {
      partial = true
      partialReason = 'timeout'
      return
    }

    let entries
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true })
    } catch (error) {
      const code = String(/** @type {any} */ (error)?.code ?? '')
      warnings.push(`目录读不出：${relPrefix || '.'}（${code}）`)
      return
    }

    for (const dirent of entries) {
      if (partial) return
      if (Date.now() - startedAt > limits.timeoutMs) {
        partial = true
        partialReason = 'timeout'
        return
      }
      if (files.length >= limits.maxFiles) {
        partial = true
        partialReason = 'maxFiles'
        return
      }

      const abs = path.join(dirAbs, dirent.name)
      const relPath = (relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name).normalize('NFC')

      if (dirent.isDirectory()) {
        if (dirent.isSymbolicLink()) {
          // readdir 的 Dirent 对符号链接不 marked as directory，理论上走不到这里。
          files.push(await describeLink(abs, relPath, realSelf, limits))
          continue
        }
        await walk(abs, relPath, depth + 1)
        continue
      }

      if (dirent.isSymbolicLink()) {
        files.push(await describeLink(abs, relPath, realSelf, limits))
        continue
      }

      if (dirent.isFile()) {
        files.push(await describeFile(abs, relPath, limits, previous))
        continue
      }

      // FIFO / socket / 设备：只记 path+type，不打开不读不哈希（§8.2）。
      files.push({ path: relPath, type: 'nonRegular', size: 0, mtimeMs: 0, hash: null, hashMode: 'none' })
    }
  }

  await walk(selfDir, relPrefix, 0)

  return {
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    partial,
    partialReason,
    scanned: files.length,
    warnings,
  }
}

/**
 * 普通文件三元组。读不出就重试一次，仍失败标 unreadable 并保留上次元数据（stale）。
 * @param {string} abs
 * @param {string} relPath
 * @param {object} limits
 * @param {Map<string, SelfFileEntry>|undefined} previous
 * @returns {Promise<SelfFileEntry>}
 */
async function describeFile(abs, relPath, limits, previous) {
  let stat = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      stat = await fsp.lstat(abs)
      break
    } catch (error) {
      if (attempt === 1) {
        return unreadableEntry(relPath, error, previous)
      }
      await sleep(RETRY_DELAY_MS)
    }
  }
  if (!stat) return unreadableEntry(relPath, new Error('lstat 失败'), previous)

  const result = await hashFileSmart(abs, limits)
  if (result.hashStatus === 'unknown' || result.hashStatus === 'failed') {
    const entry = unreadableEntry(relPath, null, previous)
    entry.size = result.size || stat.size
    entry.mtimeMs = result.mtimeMs ?? stat.mtimeMs
    return entry
  }

  return {
    path: relPath,
    type: 'file',
    size: result.size ?? stat.size,
    mtimeMs: result.mtimeMs ?? stat.mtimeMs,
    hash: result.hash ?? null,
    hashMode: result.hashMode ?? 'meta',
  }
}

/**
 * 符号链接：只记 linkTarget 的哈希，不跟随；目标在 self 外标 externalLink 告警。
 * @param {string} abs
 * @param {string} relPath
 * @param {string|null} realSelf
 * @param {object} limits
 * @returns {Promise<SelfFileEntry>}
 */
async function describeLink(abs, relPath, realSelf, limits) {
  try {
    const target = await fsp.readlink(abs)
    let externalLink = false
    if (realSelf) {
      const resolved = path.resolve(path.dirname(abs), target)
      const relative = path.relative(realSelf, resolved)
      // 只有 followSymlinks 打开时才解析真实目标看是否越界；默认关闭，只看字面目标。
      externalLink = !limits.followSymlinks
        ? relative.startsWith('..') || path.isAbsolute(relative)
        : !relative.startsWith('..') && !path.isAbsolute(relative) ? false : true
    }
    return {
      path: relPath,
      type: 'symlink',
      size: 0,
      mtimeMs: 0,
      hash: sha256(target),
      hashMode: 'full',
      linkTarget: target,
      externalLink,
    }
  } catch (error) {
    return unreadableEntry(relPath, error, undefined, 'symlink')
  }
}

/**
 * @param {string} relPath
 * @param {any} error
 * @param {Map<string, SelfFileEntry>|undefined} previous
 * @param {'file'|'symlink'} [type]
 * @returns {SelfFileEntry}
 */
function unreadableEntry(relPath, error, previous, type = 'file') {
  const code = String(error?.code ?? 'UNKNOWN')
  const key = relPath.toLowerCase()
  const prior = previous?.get(key)
  return {
    path: relPath,
    type,
    size: prior?.size ?? 0,
    mtimeMs: prior?.mtimeMs ?? 0,
    hash: prior?.hash ?? null,
    hashMode: prior?.hashMode ?? 'none',
    unreadable: true,
    errno: code,
    stale: Boolean(prior),
  }
}

/**
 * 比对两份快照（§8.2 / §8.4）。
 *
 * unreadable 一律判 `unchanged-unknown`，**不得**判消失或新增；
 * 只有 size/hash 真有变化才算 modified；大小写不敏感 FS 上仅大小写变化判 modified 并备注 case_changed。
 *
 * @param {SelfFileEntry[]} previous
 * @param {SelfFileEntry[]} current
 * @returns {{
 *   added: SelfFileEntry[],
 *   modified: Array<{entry: SelfFileEntry, reason: string}>,
 *   removed: SelfFileEntry[],
 *   unchangedUnknown: SelfFileEntry[],
 *   caseChanged: SelfFileEntry[],
 * }}
 */
export function diffSelf(previous, current) {
  /** @type {Map<string, SelfFileEntry>} */ const prevByKey = new Map()
  for (const entry of previous ?? []) prevByKey.set(entry.path.toLowerCase(), entry)

  /** @type {SelfFileEntry[]} */ const added = []
  /** @type {Array<{entry: SelfFileEntry, reason: string}>} */ const modified = []
  /** @type {SelfFileEntry[]} */ const unchangedUnknown = []
  /** @type {SelfFileEntry[]} */ const caseChanged = []
  const seenKeys = new Set()

  for (const entry of current ?? []) {
    const key = entry.path.toLowerCase()
    seenKeys.add(key)
    const prior = prevByKey.get(key)

    if (!prior) {
      // 读不出来的新条目不能算「新增」——它可能是读不到而不是刚出现。
      if (entry.unreadable) unchangedUnknown.push(entry)
      else added.push(entry)
      continue
    }

    if (prior.path !== entry.path) {
      caseChanged.push(entry)
      modified.push({ entry, reason: 'case_changed' })
      continue
    }

    if (entry.unreadable || prior.unreadable) {
      unchangedUnknown.push(entry)
      continue
    }

    if (entry.type !== prior.type) {
      modified.push({ entry, reason: 'type_changed' })
      continue
    }

    // hashMode 变化不算修改（§14.1 明确禁止）。
    if (entry.size !== prior.size) {
      modified.push({ entry, reason: 'size_changed' })
      continue
    }
    if (entry.hash !== prior.hash) {
      modified.push({ entry, reason: 'hash_changed' })
    }
  }

  const removed = []
  for (const prior of previous ?? []) {
    if (seenKeys.has(prior.path.toLowerCase())) continue
    if (prior.unreadable) {
      unchangedUnknown.push(prior)
      continue
    }
    removed.push(prior)
  }

  return { added, modified, removed, unchangedUnknown, caseChanged }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
