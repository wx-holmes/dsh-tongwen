/**
 * ULID 生成 —— 规格 §4.8 / §6.2 / §9.4 都用 ULID 做 ID。
 *
 * 26 字符 Crockford Base32：前 10 字符时间戳（毫秒），后 16 字符随机。
 * 单调性不保证（同毫秒内随机），但规格只要求唯一，不要求可排序。
 */

import { randomBytes } from 'node:crypto'

/** Crockford Base32 字母表（去掉了 I L O U）。 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_LEN = 32
const TIME_LEN = 10
const RANDOM_LEN = 16

/**
 * @param {number} time 毫秒时间戳
 * @returns {string}
 */
function encodeTime(time) {
  let remaining = Math.max(0, Math.floor(time))
  let out = ''
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    const mod = remaining % ENCODING_LEN
    out = ENCODING[mod] + out
    remaining = (remaining - mod) / ENCODING_LEN
  }
  return out
}

/**
 * @returns {string}
 */
function encodeRandom() {
  const bytes = randomBytes(RANDOM_LEN)
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out += ENCODING[bytes[i] % ENCODING_LEN]
  }
  return out
}

/**
 * 生成一个 ULID。
 * @param {number} [now]
 * @returns {string}
 */
export function ulid(now = Date.now()) {
  return encodeTime(now) + encodeRandom()
}

/** ULID 形状校验（26 位、Crockford 字母表）。 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUlid(value) {
  return typeof value === 'string' && ULID_RE.test(value)
}

/** §4.8 taskId 自定义格式：^[A-Za-z0-9._:-]{1,128}$，禁止路径分隔符、空格。 */
const TASK_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidTaskId(value) {
  return typeof value === 'string' && TASK_ID_RE.test(value)
}

/**
 * 生成自动 taskId：auto-<sessionId>-<seq>（§4.8）。
 * @param {string} sessionId
 * @param {number} seq
 * @returns {string}
 */
export function generatedTaskId(sessionId, seq) {
  const safeSession = String(sessionId).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64)
  return `auto-${safeSession}-${seq}`
}

/**
 * 生成 sessionId：gen-<YYYYMMDDTHHmmssZ>-<8hex>（§4.8）。
 * 只能用于本地关联，不得跨会话幂等。
 * @param {number} [now]
 * @returns {string}
 */
export function generatedSessionId(now = Date.now()) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  return `gen-${stamp}-${randomBytes(4).toString('hex')}`
}
