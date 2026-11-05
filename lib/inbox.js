/**
 * 请求信箱 —— 会话之间「托付一件事」的落地方式。
 *
 * 没有消息总线，只有文件：`handoff/inbox.jsonl` 是 append-only 事件流，
 * 一行一个事件，读取时按 id 归并。**不覆盖已有行**——这是和 open-items
 * 一致的口径（§14.1 禁止修改 jsonl 已有行）。
 *
 * 两型事件：
 *   {"type":"request","id":"ib_<ulid>","from":{...},"to":"<sessionId>|any","project":"slug|null","request":"一句话","createdAt":"ISO"}
 *   {"type":"close","id":"ib_<ulid>","closedAt":"ISO","resultRef":"handoff/..."|null}
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { appendLine, readJsonl } from './atomic.js'
import { pluginError } from './errors.js'
import { withLock } from './locks.js'
import { ulid } from './ulid.js'

export const INBOX_EVENT_REQUEST = 'request'
export const INBOX_EVENT_CLOSE = 'close'
export const BROADCAST = 'any'

/**
 * @typedef {object} InboxItem
 * @property {string} id
 * @property {{sessionId: string, instance: string|null}} from
 * @property {string} to
 * @property {string|null} project
 * @property {string} request
 * @property {string} createdAt
 * @property {'open'|'done'} status
 * @property {string|null} closedAt
 * @property {string|null} resultRef
 */

/**
 * 把事件流归并成当前状态。坏行跳过不中断（与 §9.4 一致，禁止自动修复）。
 *
 * @param {Array<object>} records
 * @returns {{items: Map<string, InboxItem>, closeWithoutRequest: string[], duplicateRequests: string[]}}
 */
export function mergeInbox(records) {
  /** @type {Map<string, InboxItem>} */
  const items = new Map()
  const closeWithoutRequest = []
  const duplicateRequests = []

  for (const record of records) {
    const type = record?.type
    const id = typeof record?.id === 'string' ? record.id : null
    if (!id) continue

    if (type === INBOX_EVENT_REQUEST) {
      if (items.has(id)) {
        duplicateRequests.push(id)
        continue
      }
      const from = record.from && typeof record.from === 'object' ? record.from : {}
      items.set(id, {
        id,
        from: {
          sessionId: typeof from.sessionId === 'string' ? from.sessionId : '未知会话',
          instance: typeof from.instance === 'string' ? from.instance : null,
        },
        to: typeof record.to === 'string' && record.to.trim() ? record.to.trim() : BROADCAST,
        project: typeof record.project === 'string' && record.project.trim() ? record.project.trim() : null,
        request: typeof record.request === 'string' ? record.request : '',
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
        status: 'open',
        closedAt: null,
        resultRef: null,
      })
      continue
    }

    if (type === INBOX_EVENT_CLOSE) {
      const item = items.get(id)
      if (!item) {
        closeWithoutRequest.push(id)
        continue
      }
      item.status = 'done'
      item.closedAt = typeof record.closedAt === 'string' ? record.closedAt : ''
      item.resultRef = typeof record.resultRef === 'string' && record.resultRef.trim() ? record.resultRef.trim() : null
    }
  }

  return { items, closeWithoutRequest, duplicateRequests }
}

/**
 * 读信箱并归并。文件不存在返回空（懒创建，不预建）。
 *
 * @param {string} file
 * @returns {Promise<{items: Map<string, InboxItem>, records: object[], malformed: number, closeWithoutRequest: string[], duplicateRequests: string[]}>}
 */
export async function readInbox(file) {
  const { records, malformed } = await readJsonl(file)
  const merged = mergeInbox(records)
  return { ...merged, records, malformed: malformed.length }
}

/**
 * 追加一条请求。
 *
 * @param {object} params
 * @param {string} params.file
 * @param {string} params.locksDir
 * @param {{sessionId: string, instance: string|null}} params.from
 * @param {string} params.to
 * @param {string|null} [params.project]
 * @param {string} params.request
 * @param {Date} [params.now]
 * @returns {Promise<InboxItem>}
 */
export async function appendRequest(params) {
  const now = params.now ?? new Date()
  const text = String(params.request ?? '').trim()
  if (!text) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'request', reason: '请求内容不能为空' })
  }
  const to = String(params.to ?? '').trim() || BROADCAST
  const id = `ib_${ulid(now)}`
  const record = {
    type: INBOX_EVENT_REQUEST,
    id,
    from: {
      sessionId: String(params.from?.sessionId ?? '未知会话'),
      instance: params.from?.instance ? String(params.from.instance) : null,
    },
    to,
    project: params.project ? String(params.project) : null,
    request: text,
    createdAt: now.toISOString(),
  }

  await fsp.mkdir(path.dirname(params.file), { recursive: true })
  await withLock(params.locksDir, params.file, { purpose: 'inbox.append' }, async () => {
    await appendLine(params.file, JSON.stringify(record), { fsync: true })
  })

  return {
    id,
    from: record.from,
    to,
    project: record.project,
    request: text,
    createdAt: record.createdAt,
    status: 'open',
    closedAt: null,
    resultRef: null,
  }
}

/**
 * 追加一条关闭事件。同一个 id 重复 close 只认第一次（后面的仍会写进流里，
 * 但归并时以第一次为准——这里不拦，只提示）。
 *
 * @param {object} params
 * @param {string} params.file
 * @param {string} params.locksDir
 * @param {string} params.id
 * @param {string|null} [params.resultRef]
 * @param {Date} [params.now]
 * @returns {Promise<{record: object, alreadyClosed: boolean}>}
 */
export async function appendClose(params) {
  const now = params.now ?? new Date()
  const id = String(params.id ?? '').trim()
  if (!id) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'id', reason: 'id 不能为空' })
  }

  let alreadyClosed = false
  await fsp.mkdir(path.dirname(params.file), { recursive: true })
  await withLock(params.locksDir, params.file, { purpose: 'inbox.close' }, async () => {
    const { items } = await readInbox(params.file)
    const item = items.get(id)
    if (item && item.status === 'done') alreadyClosed = true
    if (!item) {
      throw pluginError('E_NOT_FOUND', { path: `inbox:${id}` })
    }
  })

  const record = {
    type: INBOX_EVENT_CLOSE,
    id,
    closedAt: now.toISOString(),
    resultRef: params.resultRef ? String(params.resultRef) : null,
  }
  await withLock(params.locksDir, params.file, { purpose: 'inbox.append' }, async () => {
    await appendLine(params.file, JSON.stringify(record), { fsync: true })
  })
  return { record, alreadyClosed }
}

/**
 * 按条件筛。
 *
 * @param {Map<string, InboxItem>} items
 * @param {{mine?: string|null, to?: string, project?: string, status?: string}} filter
 * @returns {InboxItem[]}
 */
export function filterInbox(items, filter = {}) {
  let list = [...items.values()]
  if (filter.mine) {
    const mine = String(filter.mine)
    list = list.filter((item) => item.to === mine || item.to === BROADCAST)
  }
  if (filter.to) list = list.filter((item) => item.to === String(filter.to))
  if (filter.project) list = list.filter((item) => item.project === String(filter.project))
  if (filter.status === 'open') list = list.filter((item) => item.status === 'open')
  if (filter.status === 'done') list = list.filter((item) => item.status === 'done')
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return list
}

/**
 * 给某个会话的未处理条数。
 * @param {Map<string, InboxItem>} items
 * @param {string|null} sessionId
 */
export function countOpenFor(items, sessionId) {
  if (!sessionId) return 0
  let n = 0
  for (const item of items.values()) {
    if (item.status !== 'open') continue
    if (item.to === sessionId || item.to === BROADCAST) n += 1
  }
  return n
}

/**
 * 简报用的一行摘要。没内容返回 null（调用方整行省略）。
 *
 * @param {{total: number, latest: InboxItem|null}} summary
 */
export function formatInboxBrief(summary) {
  if (!summary || !summary.total) return null
  const latest = summary.latest
  const who = latest?.from?.instance || latest?.from?.sessionId || '某个会话'
  const text = String(latest?.request ?? '').replace(/\s+/g, ' ').slice(0, 60)
  return `- 给你的请求：${summary.total} 条；最近：${who}：${text}`
}
