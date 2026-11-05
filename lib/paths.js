/**
 * 路径安全 —— 规格 §10.1 层 0 + §10.2 层 1 冻结。
 *
 * 这是全插件唯一允许「拼路径」的地方。任何别处出现 path.join(root, 用户输入)
 * 都算实现错误（§14.1）。
 *
 * 两条铁律：
 *   层 0：九档顶层目录本身永远不可 rmdir / rm -r / rename / move / chmod。
 *   层 1：规范化后必须落在允许的档根内；拒绝 ..、绝对路径、跨盘符、符号链接逃逸。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { BUCKET_KEYS, bucketByPhysical } from './buckets.js'
import { pluginError } from './errors.js'

/** 统一转 POSIX 分隔符，供索引/交接里的路径用。 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

/**
 * 判断一段相对路径是否「看起来绝对」——这些一律拒绝，不尝试修复。
 * @param {string} p
 * @returns {string | null} 命中时返回原因，未命中返回 null
 */
export function absoluteLikeReason(p) {
  const s = String(p ?? '')
  if (s === '') return '路径为空'
  if (s.includes('\0')) return '路径含 NUL 字符'
  if (/^[A-Za-z]:/.test(s)) return '路径含盘符'
  if (s.startsWith('//') || s.startsWith('\\\\')) return '路径是 UNC 形式'
  if (s.startsWith('/') || s.startsWith('\\')) return '路径是绝对路径'
  const segments = s.split(/[\\/]+/)
  if (segments.includes('..')) return '路径含 .. 段'
  if (segments.includes('.')) return '路径含 . 段'
  return null
}

/**
 * 把 `<bucket>/<相对路径>` 拆开（规格 §15.6 产物清单语义）。
 * @param {string} specPath 例如 "created/foo/bar.txt"
 * @returns {{bucket: string, relPath: string}}
 */
export function splitBucketPath(specPath) {
  const raw = String(specPath ?? '')
  const normalized = toPosix(raw)
  const slash = normalized.indexOf('/')
  if (slash <= 0) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'path',
      reason: `路径必须写成 <bucket>/<相对路径>：${raw}`,
    })
  }
  const bucket = normalized.slice(0, slash)
  const relPath = normalized.slice(slash + 1)
  if (!bucketByPhysical(bucket)) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'path',
      reason: `第一段「${bucket}」不是九档之一：${raw}`,
    })
  }
  const bad = absoluteLikeReason(relPath)
  if (bad) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'path', reason: `${bad}：${raw}` })
  }
  return { bucket, relPath }
}

/**
 * 层 1：把 `<bucket>/<relPath>` 解析成绝对路径，并保证不越界。
 *
 * 注意：这一步只做「字符串 + 已存在祖先的 realpath」校验，
 * 不跟随目标本身的符号链接（规格 §8.2：不跟随符号链接出档）。
 *
 * @param {string} root 档根（九档的父目录）
 * @param {string} bucketKey 九档物理名
 * @param {string} relPath 档内相对路径（POSIX 或 Windows 分隔符均可）
 * @returns {Promise<string>} 绝对路径
 */
export async function resolveInBucket(root, bucketKey, relPath) {
  const bucket = bucketByPhysical(bucketKey)
  if (!bucket) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'bucket',
      reason: `「${bucketKey}」不是九档之一`,
    })
  }
  const bad = absoluteLikeReason(relPath)
  if (bad) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'path', reason: `${bad}：${relPath}` })
  }

  const bucketRoot = path.resolve(root, bucket.physical)
  const target = path.resolve(bucketRoot, relPath)
  assertDescendant(bucketRoot, target, relPath)

  // 父目录若已存在，用真实路径再验一次，防止经符号链接跳出档根。
  const realBucketRoot = await realpathNearest(bucketRoot)
  const realTarget = await realpathNearest(target)
  assertDescendant(realBucketRoot, realTarget, relPath)

  return target
}

/**
 * 层 0：拒绝任何针对九档顶层目录本身的删除 / 移动 / 改名 / 改权限。
 * @param {string} root 档根
 * @param {string} absolutePath 操作目标
 * @param {string} [operation] 仅用于提示
 */
export function assertNotBucketRoot(root, absolutePath, operation = '该操作') {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(absolutePath)
  for (const key of BUCKET_KEYS) {
    const bucketRoot = path.join(resolvedRoot, key)
    if (samePath(bucketRoot, resolvedTarget)) {
      throw pluginError('E_VALIDATION_BLOCKING', {
        field: 'path',
        reason: `${operation}不能作用于九档顶层目录本身（${key}）；九档顶层永远不可删除、移动、改名或改权限`,
      })
    }
  }
}

/**
 * 判断两个路径是否同一（Windows 大小写不敏感）。
 * @param {string} a
 * @param {string} b
 */
export function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

/**
 * 目标必须是 base 的后代，且不能是 base 本身。
 * 用 path.relative 判断，不做字符串前缀匹配（规格 §10.2 明文要求）。
 */
function assertDescendant(base, target, originalRelPath) {
  const rel = path.relative(base, target)
  if (rel === '') {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'path',
      reason: `不允许直接操作档根本身：${originalRelPath}`,
    })
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'path',
      reason: `路径越出档根：${originalRelPath}`,
    })
  }
}

/**
 * 对「最近的已存在祖先」做 realpath，再把不存在的尾部拼回去。
 * 目标本身存在时就是它的 realpath；全不存在时用于校验父链。
 * @param {string} absolutePath
 * @returns {Promise<string>}
 */
export async function realpathNearest(absolutePath) {
  const resolved = path.resolve(absolutePath)
  const tail = []
  let cursor = resolved

  for (;;) {
    try {
      const real = await fsp.realpath(cursor)
      return tail.length === 0 ? real : path.join(real, ...tail.reverse())
    } catch (error) {
      const code = String(/** @type {any} */ (error)?.code ?? '')
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        // 权限不足等无法判定真实路径的情况：不静默放行，交给调用方处理。
        if (code === 'EACCES' || code === 'EPERM') return resolved
        throw error
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) return resolved // 到盘根了
      tail.push(path.basename(cursor))
      cursor = parent
    }
  }
}

/**
 * 九档顶层是否齐全（§2.4 顶层缺失 → §10.4 恢复流程）。
 * @param {string} root
 * @returns {Promise<{present: string[], missing: string[], notWritable: string[]}>}
 */
export async function scanBucketPresence(root) {
  /** @type {string[]} */ const present = []
  /** @type {string[]} */ const missing = []
  /** @type {string[]} */ const notWritable = []

  for (const key of BUCKET_KEYS) {
    const dir = path.join(root, key)
    let stat = null
    try {
      stat = await fsp.stat(dir)
    } catch (error) {
      const code = String(/** @type {any} */ (error)?.code ?? '')
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        missing.push(key)
        continue
      }
      notWritable.push(key)
      continue
    }
    if (!stat.isDirectory()) {
      notWritable.push(key)
      continue
    }
    present.push(key)
    try {
      await fsp.access(dir)
    } catch {
      notWritable.push(key)
    }
  }

  return { present, missing, notWritable }
}
