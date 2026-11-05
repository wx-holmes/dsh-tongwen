/**
 * 审计 —— 规格 §10.5 冻结。
 *
 * logs/audit/YYYY-MM-DD.jsonl，append-only，JSONL，UTF-8，LF。
 * 单条 ≤ 16KB（超长截断并标 truncated）；按天分文件；单文件超 audit.maxFileMB 滚动 .part-<n>。
 *
 * 写失败链路（§10.5）：
 *   主文件失败 → 内存缓冲重试 1 次 → fallback-YYYY-MM-DD.jsonl → 仍失败 → L1 升 L2 + 注入明示。
 *   审计失败本身不得递归写审计。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { ulid } from './ulid.js'
import { appendLine } from './atomic.js'
import { pluginError } from './errors.js'

/** 单条 JSON 上限 16KB（规格固定数字，不进配置表）。 */
const MAX_EVENT_BYTES = 16 * 1024

/** 内存重试缓冲上限；只用于一次重试，不承担长期队列。 */
const RETRY_BUFFER_LIMIT = 32

/**
 * @typedef {object} AuditEvent
 * @property {string} [eventId]
 * @property {string} [eventSource]
 * @property {string} [sessionId]
 * @property {string} [sessionIdSource]
 * @property {string} [taskId]
 * @property {string} [taskIdScope]
 * @property {string} [taskIdSource]
 * @property {string} [effectiveTaskKey]
 * @property {string} [idempotency]
 * @property {string} op            操作类型，例如 tools.locate / versions.duplicateSkipped
 * @property {string} [target]      目标路径（POSIX 相对形式）
 * @property {string} [beforeHash]
 * @property {string} [afterHash]
 * @property {'ok'|'warn'|'fail'} [result]
 * @property {{code: string, message: string}|null} [error]
 * @property {string} [configFile]
 * @property {string} [configField]
 * @property {boolean} [confirmed]
 */

export class AuditWriter {
  /**
   * @param {{root: string, config: Record<string, any>}} options
   */
  constructor({ root, config }) {
    this.root = root
    this.config = config
    /** @type {'normal'|'L1'|'L2'} */
    this.level = 'normal'
    /** @type {string[]} 降级原因（注入层读取） */
    this.triggers = []
    /** @type {AuditEvent[]} */
    this._retryBuffer = []
    /** @type {{attempted: number, failed: number}} */
    this.stats = { attempted: 0, failed: 0 }
  }

  /** 「今天」的文件名按本地日期（审计面向人类排障）。 */
  _dateStamp(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }

  _auditDir() {
    return path.join(this.root, 'logs', 'audit')
  }

  /**
   * 选目标文件：当天主文件未超限就用它，超限则找下一个 part 号。
   * @returns {Promise<string>}
   */
  async _pickFile() {
    const dir = this._auditDir()
    const stamp = this._dateStamp()
    const maxBytes = Number(this.config?.['audit.maxFileMB'] ?? 100) * 1024 * 1024

    const main = path.join(dir, `${stamp}.jsonl`)
    let size = 0
    try {
      size = (await fsp.stat(main)).size
    } catch {
      return main
    }
    if (size < maxBytes) return main

    for (let n = 1; n < 10_000; n += 1) {
      const part = path.join(dir, `${stamp}.part-${n}.jsonl`)
      try {
        const st = await fsp.stat(part)
        if (st.size < maxBytes) return part
      } catch {
        return part
      }
    }
    return main // 理论上到不了；退化为继续写主文件，不阻断
  }

  /**
   * 写一条审计。永不抛错给业务调用方（审计失败不阻断主流程）。
   * @param {AuditEvent} event
   * @returns {Promise<{ok: boolean, degraded: boolean}>}
   */
  async write(event) {
    this.stats.attempted += 1
    const record = this._normalize(event)

    // 先补上上一轮没写成功的。
    if (this._retryBuffer.length > 0) {
      const pending = this._retryBuffer
      this._retryBuffer = []
      for (const item of pending) {
        if (!(await this._writeTo(this._auditDir(), item, 'main'))) {
          this._retryBuffer.push(item)
        }
      }
    }

    if (await this._writeTo(this._auditDir(), record, 'main')) return { ok: true, degraded: false }

    // 重试 1 次（规格固定 1 次）。
    if (await this._writeTo(this._auditDir(), record, 'main')) return { ok: true, degraded: false }

    this._retryBuffer.push(record)
    if (this._retryBuffer.length > RETRY_BUFFER_LIMIT) this._retryBuffer.shift()

    // fallback 通道。
    if (await this._writeTo(this._auditDir(), record, 'fallback')) {
      this._raise('L1', 'logs/audit 写入失败，已降级到 fallback 文件')
      return { ok: false, degraded: true }
    }

    // fallback 也失败 → L2。
    this._raise('L2', 'logs/audit 与 fallback 均不可写')
    this.stats.failed += 1
    return { ok: false, degraded: true }
  }

  /**
   * @param {string} dir
   * @param {any} record
   * @param {'main'|'fallback'} channel
   * @returns {Promise<boolean>}
   */
  async _writeTo(dir, record, channel) {
    try {
      let file
      if (channel === 'fallback') {
        file = path.join(dir, `fallback-${this._dateStamp()}.jsonl`)
      } else {
        file = await this._pickFile()
      }
      await appendLine(file, JSON.stringify(record), { fsync: false })
      return true
    } catch {
      return false
    }
  }

  /**
   * 归一化字段，保证每行的键集稳定（方便 grep / jq）。
   * @param {AuditEvent} event
   */
  _normalize(event) {
    const now = new Date().toISOString()
    const normalized = {
      at: now,
      eventId: event.eventId ?? ulid(),
      eventSource: event.eventSource ?? 'plugin',
      sessionId: event.sessionId ?? null,
      sessionIdSource: event.sessionIdSource ?? null,
      taskId: event.taskId ?? null,
      taskIdScope: event.taskIdScope ?? null,
      taskIdSource: event.taskIdSource ?? null,
      effectiveTaskKey: event.effectiveTaskKey ?? null,
      idempotency: event.idempotency ?? null,
      op: event.op,
      target: event.target ?? null,
      beforeHash: event.beforeHash ?? null,
      afterHash: event.afterHash ?? null,
      result: event.result ?? 'ok',
      error: event.error ?? null,
      configFile: event.configFile ?? null,
      configField: event.configField ?? null,
      confirmed: event.confirmed ?? false,
    }

    let json = JSON.stringify(normalized)
    if (Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES) {
      // 截断最大的字段（通常是 error.message 或 target），保留结构。
      const shrink = {
        ...normalized,
        truncated: true,
        error: normalized.error
          ? { code: normalized.error.code, message: String(normalized.error.message ?? '').slice(0, 512) }
          : null,
        target: typeof normalized.target === 'string' ? normalized.target.slice(0, 512) : normalized.target,
      }
      json = JSON.stringify(shrink)
      // 极端情况下仍超限：丢弃可选字段，只留 identifiers。
      if (Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES) {
        return {
          at: now,
          eventId: normalized.eventId,
          op: normalized.op,
          result: normalized.result,
          truncated: true,
        }
      }
      return shrink
    }
    return normalized
  }

  /**
   * 降级只升不降（§14.1：降级态自动改权限是被禁止的）。
   * @param {'L1'|'L2'} level
   * @param {string} reason
   */
  _raise(level, reason) {
    const order = { normal: 0, L1: 1, L2: 2 }
    if (order[level] > order[this.level]) {
      this.level = level
      this.triggers.push(reason)
    }
  }

  /**
   * 工具返回里要用的降级级别（audit 自己不能决定全局，只报告自己那一份）。
   * @returns {'normal'|'L1'|'L2'}
   */
  get degradedLevel() {
    return this.level
  }
}

/**
 * 便捷函数：写一条然后不管结果。给「不阻断主流程」的调用点用。
 * @param {AuditWriter} writer
 * @param {AuditEvent} event
 */
export async function auditQuietly(writer, event) {
  try {
    await writer.write(event)
  } catch {
    // 审计层自己有 fallback；这里再兜一层，保证业务路径绝不被审计拖死。
  }
}

/**
 * 构造一个「审计不可用」时抛的码，供确实需要审计落盘才能继续的场景用。
 */
export function auditUnavailable() {
  return pluginError('E_PERMISSION', { target: 'logs/audit' })
}
