/**
 * 原子写 —— 规格 §10.6 冻结协议。
 *
 * 覆盖写一律：写同目录 tmp → fsync 文件 → rename 目标 →（可选）fsync 父目录。
 * 追加写一律：O_APPEND 单行 + fsync。
 * 跨设备 rename 禁止（EXDEV 直接报 E_RENAME_FAILED）。
 *
 * 失败后的 tmp 去留按调用方语义区分：
 *   - 索引 / 交接 / 配置：删除 tmp 并告警
 *   - 快照：保留为 <目标>.pending.json 供下次补提交
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { classifyErrno, pluginError } from './errors.js'

/**
 * @typedef {object} AtomicWriteOptions
 * @property {boolean} [fsyncFile] 默认 true
 * @property {boolean} [fsyncDir] 默认 false（Windows 打不开目录句柄，属可选步骤）
 * @property {'discard'|'keep-pending'} [onFailureTmp] 失败后 tmp 处理方式，默认 discard
 * @property {string} [encoding] 默认 utf8
 */

/**
 * 生成同目录临时文件名：`.<目标名>.tmp.<8hex>`。
 * @param {string} target
 */
function tmpPathFor(target) {
  const dir = path.dirname(target)
  const base = path.basename(target)
  const hex = randomBytes(4).toString('hex')
  return path.join(dir, `.${base}.tmp.${hex}`)
}

/**
 * 覆盖写（原子）。目标已存在会被替换，但旧内容应当已被调用方备份到 archive/versions。
 * @param {string} target 绝对路径
 * @param {string | Uint8Array} content
 * @param {AtomicWriteOptions} [options]
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function writeFileAtomic(target, content, options = {}) {
  const {
    fsyncFile = true,
    fsyncDir = false,
    onFailureTmp = 'discard',
    encoding = 'utf8',
  } = options

  const resolved = path.resolve(target)
  await fsp.mkdir(path.dirname(resolved), { recursive: true })

  const tmp = tmpPathFor(resolved)
  const pendingName = `${resolved.slice(0, -path.extname(resolved).length)}.pending${path.extname(resolved) || '.json'}`
  let handle = null

  try {
    handle = await fsp.open(tmp, 'wx')
    await handle.writeFile(content, encoding)
    if (fsyncFile) await handle.sync()
    await handle.close()
    handle = null

    await fsp.rename(tmp, resolved)

    if (fsyncDir) {
      try {
        const dirHandle = await fsp.open(path.dirname(resolved), 'r')
        await dirHandle.sync()
        await dirHandle.close()
      } catch {
        // 可选步骤失败不影响写入已提交的事实。
      }
    }

    const bytes = typeof content === 'string'
      ? Buffer.byteLength(content, /** @type {BufferEncoding} */ (encoding))
      : content.byteLength
    return { path: resolved, bytes }
  } catch (error) {
    if (handle) {
      try { await handle.close() } catch { /* 关闭失败不覆盖原始错误 */ }
    }

    if (onFailureTmp === 'keep-pending') {
      try {
        await fsp.rename(tmp, pendingName)
      } catch {
        // pending 也留不下来时，至少把 tmp 清掉，避免留下垃圾。
        try { await fsp.unlink(tmp) } catch { /* ignore */ }
      }
    } else {
      try { await fsp.unlink(tmp) } catch { /* tmp 可能根本没建出来 */ }
    }

    const classified = classifyErrno(error, resolved)
    throw pluginError(
      classified.code === 'E_NOT_FOUND' ? 'E_IO' : classified.code,
      { target: resolved, reason: classified.errno },
    )
  }
}

/**
 * 追加一行（O_APPEND，单次 write）。用于 append-only 的 jsonl。
 * 调用方负责加锁（§9.4 追加协议要求锁内完成「读尾校验 + 追加」）。
 * @param {string} file 绝对路径
 * @param {string} line 不带换行；本函数补 \n
 * @param {{fsync?: boolean}} [options]
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function appendLine(file, line, options = {}) {
  const { fsync = true } = options
  const resolved = path.resolve(file)
  await fsp.mkdir(path.dirname(resolved), { recursive: true })

  const payload = `${String(line).replace(/\r?\n/g, '')}\n`
  let handle = null
  try {
    handle = await fsp.open(resolved, 'a')
    await handle.writeFile(payload, 'utf8')
    if (fsync) await handle.sync()
    await handle.close()
    return { path: resolved, bytes: Buffer.byteLength(payload, 'utf8') }
  } catch (error) {
    if (handle) {
      try { await handle.close() } catch { /* ignore */ }
    }
    const classified = classifyErrno(error, resolved)
    throw pluginError(classified.code, { target: resolved, reason: classified.errno })
  }
}

/**
 * 读文件尾部 N 行（用于 append-only 流的「追加前校验 previousDirectionId 存在」）。
 * @param {string} file
 * @param {number} [maxLines]
 * @returns {Promise<string[]>}
 */
export async function readTailLines(file, maxLines = 50) {
  let text = ''
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT') return []
    throw error
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines.slice(-maxLines)
}

/**
 * 逐行解析 JSONL，损坏行跳过并记入 malformed（规格 §9.4：不中断、禁止自动修复）。
 * @param {string} file
 * @returns {Promise<{records: any[], malformed: Array<{line: number, error: string}>}>}
 */
export async function readJsonl(file) {
  let text = ''
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT') return { records: [], malformed: [] }
    throw error
  }
  const records = []
  const malformed = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim()
    if (raw === '') continue
    try {
      records.push(JSON.parse(raw))
    } catch (error) {
      malformed.push({ line: i + 1, error: String(/** @type {any} */ (error)?.message ?? error) })
    }
  }
  return { records, malformed }
}
