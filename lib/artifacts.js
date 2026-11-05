/**
 * 产物清单语义 —— 规格 §15.6。
 *
 * 一条产物行必须带：路径 / 类型 / 存在性 / 大小 / 哈希 / hashStatus / 备注。
 * 两个最容易写错的地方在这里被钉死：
 *   1. 存在性三态里 **unknown 不得当成 no**（EACCES 不是“不存在”，不许触发缺失告警）；
 *   2. 哈希一个算不出来不阻断整份交接，只把这一条标 failed。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { splitBucketPath, toPosix } from './paths.js'
import { hashFileSmart, treeHash, sha256 } from './hash.js'

/** @typedef {'file'|'dir'|'symlink'|'other'} ArtifactType */
/** @typedef {'yes'|'no'|'unknown'} ExistsState */
/** @typedef {'ok'|'partial'|'failed'|'missing'|'unknown'|'skipped_too_large'} HashStatus */

/**
 * @typedef {object} ArtifactRow
 * @property {string} path       `<bucket>/<相对路径>`
 * @property {ArtifactType} type
 * @property {ExistsState} exists
 * @property {number} size
 * @property {string|null} sha256
 * @property {HashStatus} hashStatus
 * @property {string} note
 */

/**
 * 逐条核验一个产物。
 *
 * 永远不抛：任何异常都折成对应行的 exists/hashStatus，交给调用方决定告警。
 *
 * @param {object} params
 * @param {string} params.root   档根绝对路径
 * @param {string} params.specPath `<bucket>/<相对路径>`
 * @param {Record<string, any>} params.config
 * @returns {Promise<ArtifactRow>}
 */
export async function inspectArtifact({ root, specPath, config }) {
  /** @type {ArtifactRow} */
  const row = {
    path: String(specPath ?? ''),
    type: 'other',
    exists: 'unknown',
    size: 0,
    sha256: null,
    hashStatus: 'unknown',
    note: '',
  }

  let bucket
  let relPath
  try {
    const parsed = splitBucketPath(specPath)
    bucket = parsed.bucket
    relPath = toPosix(parsed.relPath).replace(/^\/+|\/+$/g, '')
    row.path = relPath ? `${bucket}/${relPath}` : bucket
  } catch (error) {
    // 路径本身不合法（绝对路径 / 盘符 / .. / 第一段不是九档）→ outside_root，不阻断整份交接
    row.note = 'outside_root'
    return row
  }

  const absPath = path.resolve(root, bucket, ...relPath.split('/'))

  let stat
  try {
    stat = await fsp.lstat(absPath)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      row.exists = 'no'
      row.hashStatus = 'missing'
      return row
    }
    // EACCES / EPERM / EBUSY 等：存在性无法确定，绝不能当“不存在”
    row.exists = 'unknown'
    row.hashStatus = 'unknown'
    row.note = joinNote(row.note, error?.code ? `errno=${error.code}` : 'lstat 失败')
    return row
  }

  row.exists = 'yes'

  if (stat.isSymbolicLink()) {
    row.type = 'symlink'
    try {
      const target = await fsp.readlink(absPath)
      row.size = 0
      row.sha256 = sha256(target)
      row.hashStatus = 'ok'
      row.note = joinNote(row.note, `linkTarget=${target}`)
    } catch (error) {
      row.hashStatus = 'failed'
      row.note = joinNote(row.note, error?.code ? `errno=${error.code}` : 'readlink 失败')
    }
    return row
  }

  if (stat.isDirectory()) {
    row.type = 'dir'
    try {
      const tree = await treeHash(absPath, {
        maxFiles: Number(config['handoff.artifactTreeMaxFiles']),
        maxMB: Number(config['handoff.artifactTreeMaxMB']),
      })
      row.size = tree.size
      row.sha256 = tree.hash
      row.hashStatus = tree.hashStatus
      if (tree.hashStatus === 'skipped_too_large') {
        row.note = joinNote(row.note, `fileCount=${tree.fileCount}`)
      }
    } catch (error) {
      row.hashStatus = 'failed'
      row.note = joinNote(row.note, error?.code ? `errno=${error.code}` : 'treeHash 失败')
    }
    return row
  }

  if (stat.isFile()) {
    row.type = 'file'
    try {
      const info = await hashFileSmart(absPath, {
        hashMaxFileMB: Number(config['selfScan.hashMaxFileMB']),
        skipHashMB: Number(config['selfScan.skipHashMB']),
      })
      row.size = info.size
      row.sha256 = info.hash
      row.hashStatus = info.hashStatus
      if (info.hashMode && info.hashMode !== 'full') {
        row.note = joinNote(row.note, `hashMode=${info.hashMode}`)
      }
    } catch (error) {
      row.size = Number(stat.size) || 0
      row.hashStatus = 'failed'
      row.note = joinNote(row.note, error?.code ? `errno=${error.code}` : '哈希失败')
    }
    return row
  }

  // FIFO / socket / 设备文件：不打开、不读、不哈希
  row.type = 'other'
  row.size = 0
  row.sha256 = null
  row.hashStatus = 'ok'
  row.note = joinNote(row.note, 'nonRegular')
  return row
}

/**
 * 批量核验。单条失败不影响其它条。
 * @param {object} params
 * @param {string} params.root
 * @param {string[]} params.specPaths
 * @param {Record<string, any>} params.config
 * @returns {Promise<ArtifactRow[]>}
 */
export async function inspectArtifacts({ root, specPaths, config }) {
  const rows = []
  for (const specPath of specPaths) {
    rows.push(await inspectArtifact({ root, specPath, config }))
  }
  return rows
}

/**
 * 哈希失败比例是否已到「整份交接降级」的程度（§15.6 校验时机）。
 *
 * @param {ArtifactRow[]} rows
 * @param {number} failWarnRatio
 * @returns {{degraded: boolean, failed: number, total: number, ratio: number}}
 */
export function summarizeArtifactHealth(rows, failWarnRatio) {
  const total = rows.length
  const failed = rows.filter((row) => row.hashStatus === 'failed').length
  const missing = rows.filter((row) => row.exists === 'no').length
  const unknown = rows.filter((row) => row.exists === 'unknown').length
  const ratio = total === 0 ? 0 : failed / total
  const threshold = Number.isFinite(failWarnRatio) ? failWarnRatio : 0.2
  return {
    degraded: total > 0 && ratio > threshold,
    failed,
    missing,
    unknown,
    total,
    ratio,
  }
}

/**
 * 产物清单为空时的占位说明（§5.2）。
 * @returns {ArtifactRow[]}
 */
export function noArtifacts() {
  return []
}

/** @param {string} a @param {string} b */
function joinNote(a, b) {
  if (!a) return b
  if (!b) return a
  return `${a}；${b}`
}
