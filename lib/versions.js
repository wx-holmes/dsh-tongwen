/**
 * 版本化 —— 规格 §5.4 / §10.3。
 *
 * handoff 固定名永远是「最新版」；覆盖前把旧版复制到
 * archive/versions/<实例>/<原文件名>.<n>。
 *
 * 两条硬规则：
 *   1. 备份前算旧版 SHA-256，与最新版相同 → 跳过（审计 versions.duplicateSkipped）
 *   2. K 版口径按文件独立计；第 K+1 版起移入 trash，**不真删**
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { sha256File } from './hash.js'

/**
 * 列出某实例已存在的版本号（升序）。
 * @param {string} versionsDir archive/versions/<实例> 的绝对路径
 * @param {string} baseName 原文件名（含扩展名）
 * @returns {Promise<number[]>}
 */
export async function listVersionNumbers(versionsDir, baseName) {
  let names = []
  try {
    names = await fsp.readdir(versionsDir)
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT') return []
    throw error
  }
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped}\\.(\\d+)$`)
  const numbers = []
  for (const name of names) {
    const m = re.exec(name)
    if (m) numbers.push(Number(m[1]))
  }
  return numbers.sort((a, b) => a - b)
}

/**
 * @typedef {object} BackupResult
 * @property {'skipped'|'backed-up'|'no-source'} status
 * @property {number|null} versionNumber
 * @property {string|null} backupPath
 * @property {string|null} sourceHash
 * @property {string|null} previousHash
 */

/**
 * 覆盖前备份：把 `sourcePath` 复制成 `versions/<实例>/<原文件名>.<n>`。
 *
 * @param {object} params
 * @param {string} params.sourcePath 当前 handoff 固定名文件的绝对路径
 * @param {string} params.versionsDir archive/versions/<实例>/ 绝对路径
 * @param {string} params.baseName 原文件名（例如 `demo.machine.md`）
 * @returns {Promise<BackupResult>}
 */
export async function backupBeforeOverwrite({ sourcePath, versionsDir, baseName }) {
  let sourceStat
  try {
    sourceStat = await fsp.stat(sourcePath)
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT') return { status: 'no-source', versionNumber: null, backupPath: null, sourceHash: null, previousHash: null }
    throw error
  }
  if (!sourceStat.isFile()) {
    return { status: 'no-source', versionNumber: null, backupPath: null, sourceHash: null, previousHash: null }
  }

  const sourceHash = await sha256File(sourcePath)
  const existing = await listVersionNumbers(versionsDir, baseName)

  // 与最新版内容相同 → 跳过（不产生重复版本）。
  if (existing.length > 0) {
    const latestPath = path.join(versionsDir, `${baseName}.${existing[existing.length - 1]}`)
    try {
      const latestHash = await sha256File(latestPath)
      if (latestHash === sourceHash) {
        return {
          status: 'skipped',
          versionNumber: existing[existing.length - 1],
          backupPath: latestPath,
          sourceHash,
          previousHash: latestHash,
        }
      }
    } catch {
      // 最新版读不出来就继续备份，不因此丢掉这次备份。
    }
  }

  const nextNumber = (existing[existing.length - 1] ?? 0) + 1
  await fsp.mkdir(versionsDir, { recursive: true })
  const backupPath = path.join(versionsDir, `${baseName}.${nextNumber}`)
  await fsp.copyFile(sourcePath, backupPath)

  return {
    status: 'backed-up',
    versionNumber: nextNumber,
    backupPath,
    sourceHash,
    previousHash: sourceHash,
  }
}

/**
 * K 版清理（§10.3）：保留最近 K 版，第 K+1 版起移入
 * archive/trash/<ts>/from-archive/versions/<实例>/<文件>.<n>。
 *
 * 失败不阻断主流程，返回失败项由调用方审计 versions.cleanupFailed 并下次重试。
 *
 * @param {object} params
 * @param {string} params.versionsDir
 * @param {string} params.baseName
 * @param {number} params.keepK
 * @param {string} params.trashRoot archive/trash 的绝对路径
 * @param {() => string} params.timestamp 生成一次运行内唯一时间戳
 * @param {(entry: {originalPath: string, physicalPath: string, size: number, hash: string|null, reason: string}) => Promise<void>} [params.recordTrash]
 *       写 recovery-log 的回调；写失败时调用方应中止移动
 * @returns {Promise<{moved: string[], failed: Array<{path: string, reason: string}>}>}
 */
export async function cleanupOldVersions({
  versionsDir, baseName, keepK, trashRoot, timestamp, recordTrash,
}) {
  const numbers = await listVersionNumbers(versionsDir, baseName)
  const doomed = numbers.slice(0, Math.max(0, numbers.length - Number(keepK)))
  const moved = []
  /** @type {Array<{path: string, reason: string}>} */ const failed = []

  if (doomed.length === 0) return { moved, failed }

  const instanceName = path.basename(versionsDir)
  const destDir = path.join(trashRoot, timestamp(), 'from-archive', 'versions', instanceName)

  for (const number of doomed) {
    const from = path.join(versionsDir, `${baseName}.${number}`)
    const to = path.join(destDir, `${baseName}.${number}`)
    try {
      const stat = await fsp.stat(from)
      if (recordTrash) {
        // 先写 committed 记录，再移动（§10.3 写入顺序）。
        await recordTrash({
          originalPath: `archive/versions/${instanceName}/${baseName}.${number}`,
          physicalPath: to,
          size: stat.size,
          hash: null,
          reason: 'versions_cleanup',
        })
      }
      await fsp.mkdir(destDir, { recursive: true })
      await fsp.rename(from, to)
      moved.push(from)
    } catch (error) {
      failed.push({ path: from, reason: String(/** @type {any} */ (error)?.code ?? error) })
    }
  }

  return { moved, failed }
}

/**
 * 数据类文件（白板 / 规范 / 索引页 / 当前状态）的版本备份：
 * 覆盖写入前先复制到 `archive/versions/_data/<key>/<stamp>.bak`。
 *
 * @param {object} params
 * @param {string} params.sourcePath 被覆盖的文件绝对路径
 * @param {string} params.versionsDir `archive/versions` 绝对路径
 * @param {string} params.key 稳定键（通常用九档相对路径，斜杠转 `__`）
 * @param {number} [params.keepK] 保留份数，默认 10
 * @returns {Promise<{status:'backed-up'|'skipped'|'no-source', stamp:string|null, backupPath:string|null}>}
 */
export async function backupDataFile({ sourcePath, versionsDir, key, keepK = 10 }) {
  let buf
  try {
    buf = await fsp.readFile(sourcePath)
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT') return { status: 'no-source', stamp: null, backupPath: null }
    throw error
  }
  const dir = path.join(versionsDir, '_data', key)
  await fsp.mkdir(dir, { recursive: true })
  // 时间戳带毫秒：同一秒内也可能发生「备份 → 立刻回滚」两次写入，秒级会互相覆盖
  let stamp = new Date().toISOString().replace(/[-:.]/g, '')
  let backupPath = path.join(dir, `${stamp}.bak`)
  for (let i = 2; i < 100; i += 1) {
    try {
      await fsp.access(backupPath)
      stamp = new Date().toISOString().replace(/[-:.]/g, '') + `-${i}`
      backupPath = path.join(dir, `${stamp}.bak`)
    } catch {
      break
    }
  }
  await fsp.writeFile(backupPath, buf)
  // 只留最近 keepK 份
  try {
    const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.bak')).sort()
    for (const old of names.slice(0, Math.max(0, names.length - keepK))) {
      await fsp.rm(path.join(dir, old), { force: true })
    }
  } catch {
    // 清理失败不影响备份本身
  }
  return { status: 'backed-up', stamp, backupPath }
}

/**
 * 列出某个 key 的数据备份，按时间升序。
 * @param {{ versionsDir: string, key: string }} params
 */
export async function listDataVersions({ versionsDir, key }) {
  const dir = path.join(versionsDir, '_data', key)
  try {
    const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.bak')).sort()
    return names.map((name) => ({ stamp: name.replace(/\.bak$/, ''), path: path.join(dir, name) }))
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT') return []
    throw error
  }
}

