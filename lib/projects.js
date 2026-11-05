/**
 * 项目白板 —— 跨会话共享的「这个项目现在到哪了」。
 *
 * 每个项目一份 `handoff/projects/<slug>.md`，固定六节。
 * 这是规格 §2.2 之外新增的扩展（用户已裁决接受）：九档顶层不变，
 * 只在 handoff 档内加一个二级目录，不新建第 10 档。
 *
 * 不解析「内容」意思，只按 `## 标题` 切段，手改过的文件也能读。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.js'
import { pluginError } from './errors.js'
import { slugifyBase } from './naming.js'

/** 项目 id 只认 ASCII 小写字母、数字、连字符（§3.1 物理名口径）。 */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/

/** 白板允许的状态。 */
export const PROJECT_STATUSES = ['active', 'paused', 'done']

/** 优先级：P0 立刻做 / P1 本周 / P2 有空 / P3 以后。默认 P2。 */
export const PROJECT_PRIORITIES = ['P0', 'P1', 'P2', 'P3']

/** 排序权重（越小越先做）。 */
export const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 }

/** 做完的项目搬进这个子目录，总目录里只留一行「已归档」。 */
export const DONE_DIRNAME = 'done'

/** 固定六节的标题（解析与渲染共用）。 */
export const PROJECT_SECTIONS = {
  goal: '目标',
  participants: '参与会话',
  roles: '分工',
  decisions: '决定（只追加）',
  baton: '当前一棒',
  todo: '待办',
  issues: '挂账',
}

const SECTION_KEYS = Object.keys(PROJECT_SECTIONS)

/**
 * 把用户给的项目名规整成 id。非 ASCII 转不出东西时报错让人给一个，
 * 不替用户编一个（§3.3：命名不确定就问，不编造）。
 *
 * @param {string} raw
 * @returns {string}
 */
export function projectIdOf(raw) {
  const value = String(raw ?? '').trim()
  if (!value) {
    throw pluginError('E_VALIDATION_BLOCKING', { field: 'id', reason: '项目 id 不能为空' })
  }
  if (PROJECT_ID_PATTERN.test(value)) return value
  const slug = slugifyBase(value, 48)
  if (!slug || !PROJECT_ID_PATTERN.test(slug)) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'id',
      reason: `项目 id 只认小写字母、数字、连字符（收到「${value}」）。中文名请放到 title 里，id 另给一个英文短名。`,
    })
  }
  return slug
}

/**
 * @typedef {object} ProjectModel
 * @property {string} id
 * @property {string} title
 * @property {'active'|'paused'|'done'} status
 * @property {'P0'|'P1'|'P2'|'P3'} priority
 * @property {string} updated
 * @property {string} goal
 * @property {string[]} participants
 * @property {string[]} roles
 * @property {string[]} decisions
 * @property {{to: string, action: string}|null} baton
 * @property {string[]} todo
 */

/** @returns {ProjectModel} */
export function emptyProject(id, now = new Date()) {
  return {
    id,
    title: id,
    status: 'active',
    priority: 'P2',
    updated: now.toISOString(),
    goal: '',
    participants: [],
    roles: [],
    decisions: [],
    baton: null,
    todo: [],
    issues: [],
  }
}

/**
 * 渲染成 Markdown。
 * @param {ProjectModel} model
 * @returns {string}
 */
export function renderProject(model) {
  const lines = []
  lines.push(`# ${model.title || model.id}`)
  lines.push('')
  lines.push(`> id: ${model.id} · status: ${model.status} · priority: ${model.priority} · updated: ${model.updated}`)
  lines.push('')
  lines.push(`## ${PROJECT_SECTIONS.goal}`)
  lines.push(model.goal || '（还没写目标）')
  lines.push('')
  lines.push(`## ${PROJECT_SECTIONS.participants}`)
  if (model.participants.length) {
    for (const line of model.participants) lines.push(`- ${line}`)
  } else {
    lines.push('- （还没有会话加入）')
  }
  lines.push('')
  lines.push(`## ${PROJECT_SECTIONS.roles}`)
  if (model.roles.length) {
    for (const line of model.roles) lines.push(`- ${line}`)
  } else {
    lines.push('- （还没分工）')
  }
  lines.push('')
  lines.push(`## ${PROJECT_SECTIONS.decisions}`)
  if (model.decisions.length) {
    for (const line of model.decisions) lines.push(`- ${line}`)
  } else {
    lines.push('- （还没有决定）')
  }
  lines.push('')
  lines.push(`## ${PROJECT_SECTIONS.baton}`)
  if (model.baton && (model.baton.to || model.baton.action)) {
    lines.push(`- 交给：${model.baton.to || 'any'}`)
    lines.push(`- 要做什么：${model.baton.action || '（没写）'}`)
  } else {
    lines.push('- 交给：any')
    lines.push('- 要做什么：（还没排下一棒）')
  }
  lines.push('')
  lines.push(`## ${PROJECT_SECTIONS.todo}`)
  if (model.todo.length) {
    for (const item of model.todo) lines.push(`- [ ] ${item}`)
  } else {
    lines.push('- [ ] （没有待办）')
  }
  lines.push('')
  lines.push(`## ${PROJECT_SECTIONS.issues}`)
  if (model.issues.length) {
    for (const item of model.issues) lines.push(`- [ ] ${item}`)
  } else {
    lines.push('- [ ] （没有挂账）')
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 从原文解析回模型。手改过的文件也不能炸：缺节就当空。
 *
 * @param {string} text
 * @param {string} fallbackId
 * @returns {ProjectModel}
 */
export function parseProject(text, fallbackId) {
  const model = emptyProject(fallbackId)
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')

  // 标题行
  const titleLine = lines.find((line) => line.startsWith('# '))
  if (titleLine) model.title = titleLine.slice(2).trim() || fallbackId

  // 头行 `> id: x · status: y · priority: P2 · updated: z`（priority 可能缺，老文件默认 P2）
  const header = lines.find((line) => line.startsWith('>'))
  if (header) {
    const idMatch = header.match(/id:\s*([^\s·]+)/)
    const statusMatch = header.match(/status:\s*([^\s·]+)/)
    const priorityMatch = header.match(/priority:\s*([^\s·]+)/)
    const updatedMatch = header.match(/updated:\s*([^\s·]+)/)
    if (idMatch && PROJECT_ID_PATTERN.test(idMatch[1])) model.id = idMatch[1]
    if (statusMatch && PROJECT_STATUSES.includes(statusMatch[1])) model.status = statusMatch[1]
    if (priorityMatch && PROJECT_PRIORITIES.includes(priorityMatch[1].toUpperCase())) {
      model.priority = priorityMatch[1].toUpperCase()
    }
    if (updatedMatch) model.updated = updatedMatch[1]
  }

  // 按 `## ` 切段
  const buckets = new Map()
  let current = null
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (line.startsWith('## ')) {
      current = line.slice(3).trim()
      buckets.set(current, [])
      continue
    }
    if (current) buckets.get(current).push(line)
  }

  const pick = (key) => buckets.get(PROJECT_SECTIONS[key]) ?? []

  const goalLines = pick('goal').filter((line) => line.trim())
  model.goal = goalLines.join('\n').trim()

  model.participants = pick('participants')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line && !line.startsWith('（'))

  model.roles = pick('roles')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line && !line.startsWith('（'))

  model.decisions = pick('decisions')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line && !line.startsWith('（'))

  model.todo = pick('todo')
    .map((line) => line.replace(/^-\s*\[[ xX]\]\s*/, '').trim())
    .filter((line) => line && !line.startsWith('（'))

  model.issues = pick('issues')
    .map((line) => line.replace(/^-\s*\[[ xX]\]\s*/, '').trim())
    .filter((line) => line && !line.startsWith('（'))

  const batonLines = pick('baton').map((line) => line.replace(/^-\s*/, '').trim())
  let batonTo = null
  let batonAction = null
  for (const line of batonLines) {
    if (line.startsWith('交给：')) batonTo = line.slice(3).trim()
    if (line.startsWith('要做什么：')) batonAction = line.slice(5).trim()
  }
  model.baton =
    batonTo || batonAction
      ? {
          to: batonTo && batonTo !== '（没写）' ? batonTo : 'any',
          action: batonAction && !batonAction.startsWith('（') ? batonAction : '',
        }
      : null

  return model
}

/**
 * 项目文件绝对路径（active 的位置）。id 非法直接抛（不猜、不 sanitize 后照写）。
 * @param {string} projectsDir
 * @param {string} id
 */
export function projectFilePath(projectsDir, id) {
  const safe = projectIdOf(id)
  return path.join(projectsDir, `${safe}.md`)
}

/**
 * 做完的项目存放目录。
 * @param {string} projectsDir
 */
export function doneProjectsDir(projectsDir) {
  return path.join(projectsDir, DONE_DIRNAME)
}

/**
 * 读一个项目。先找 active 区，再找 done/；不存在返回 null（不是错误）。
 * @param {string} projectsDir
 * @param {string} id
 * @returns {Promise<{model: ProjectModel, raw: string, exists: boolean, archived: boolean, path: string}>}
 */
export async function readProject(projectsDir, id) {
  const safe = projectIdOf(id)
  const candidates = [
    [path.join(projectsDir, `${safe}.md`), false],
    [path.join(doneProjectsDir(projectsDir), `${safe}.md`), true],
  ]
  for (const [file, archived] of candidates) {
    let raw
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const model = parseProject(raw, safe)
    if (archived) model.status = 'done'
    return { model, raw, exists: true, archived, path: file }
  }
  return { model: emptyProject(safe), raw: '', exists: false, archived: false, path: candidates[0][0] }
}

/**
 * 列出一个目录下的白板（内部用）。
 * @param {string} dir
 * @param {boolean} archived
 */
async function listProjectsIn(dir, archived) {
  let names
  try {
    names = await fsp.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    if (!PROJECT_ID_PATTERN.test(id)) continue
    try {
      const raw = await fsp.readFile(path.join(dir, name), 'utf8')
      const model = parseProject(raw, id)
      if (archived) model.status = 'done'
      out.push({
        id: model.id,
        title: model.title,
        status: model.status,
        priority: model.priority,
        updated: model.updated,
        baton: model.baton?.to ?? null,
        archived,
      })
    } catch {
      // 单个文件读不了不该拖垮整个列表
      out.push({ id, title: id, status: 'unknown', priority: 'P2', updated: '', baton: null, archived })
    }
  }
  return out
}

/**
 * 列出全部项目（在办 + 已归档）。目录不存在返回空数组（懒创建，不预建）。
 * @param {string} projectsDir
 * @returns {Promise<Array<{id: string, title: string, status: string, priority: string, updated: string, baton: string|null, archived: boolean}>>}
 */
export async function listProjects(projectsDir) {
  const current = await listProjectsIn(projectsDir, false)
  const done = await listProjectsIn(doneProjectsDir(projectsDir), true)
  const out = [...current, ...done]
  out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
  return out
}

/**
 * 建或合并一个项目。存在则合并：
 * - title / goal / status / priority 覆盖（给了才改）
 * - status=done 时把白板搬进 projects/done/，重新激活时搬回来
 * - baton / todo 整体替换（给了才改）
 * - participants / roles / decisions 追加（去重）
 *
 * @param {object} params
 * @param {string} params.projectsDir
 * @param {string} params.id
 * @param {string} [params.title]
 * @param {string} [params.goal]
 * @param {string} [params.status]
 * @param {string} [params.priority]
 * @param {{to: string, action: string}} [params.baton]
 * @param {string[]} [params.todo]
 * @param {string} [params.participant]
 * @param {string} [params.role]
 * @param {{text: string, reason?: string}} [params.decision]
 * @param {Date} [params.now]
 * @returns {Promise<{model: ProjectModel, raw: string, created: boolean, path: string, archived: boolean}>}
 */
export async function upsertProject(params) {
  const now = params.now ?? new Date()
  const safe = projectIdOf(params.id)
  const existing = await readProject(params.projectsDir, safe)
  const model = existing.model

  if (typeof params.title === 'string' && params.title.trim()) model.title = params.title.trim()
  if (typeof params.goal === 'string' && params.goal.trim()) model.goal = params.goal.trim()
  if (typeof params.status === 'string') {
    if (!PROJECT_STATUSES.includes(params.status)) {
      throw pluginError('E_VALIDATION_BLOCKING', {
        field: 'status',
        reason: `项目状态只能是 ${PROJECT_STATUSES.join(' / ')}，收到「${params.status}」`,
      })
    }
    model.status = params.status
  }
  if (typeof params.priority === 'string' && params.priority.trim()) {
    const priority = params.priority.trim().toUpperCase()
    if (!PROJECT_PRIORITIES.includes(priority)) {
      throw pluginError('E_VALIDATION_BLOCKING', {
        field: 'priority',
        reason: `优先级只能是 ${PROJECT_PRIORITIES.join(' / ')}，收到「${params.priority}」`,
      })
    }
    model.priority = priority
  }
  if (params.baton) {
    model.baton = {
      to: String(params.baton.to ?? 'any').trim() || 'any',
      action: String(params.baton.action ?? '').trim(),
    }
  }
  if (Array.isArray(params.todo)) {
    model.todo = params.todo.map((item) => String(item).trim()).filter(Boolean)
  }
  if (typeof params.issue === 'string' && params.issue.trim()) {
    const line = params.issue.trim()
    if (!model.issues.includes(line)) model.issues.push(line)
  }
  if (typeof params.resolveIssue === 'string' && params.resolveIssue.trim()) {
    const needle = params.resolveIssue.trim()
    model.issues = model.issues.filter((item) => !item.includes(needle))
  }
  if (typeof params.participant === 'string' && params.participant.trim()) {
    const line = params.participant.trim()
    if (!model.participants.includes(line)) model.participants.push(line)
  }
  if (typeof params.role === 'string' && params.role.trim()) {
    const line = params.role.trim()
    if (!model.roles.includes(line)) model.roles.push(line)
  }
  if (params.decision && typeof params.decision.text === 'string' && params.decision.text.trim()) {
    const day = now.toISOString().slice(0, 10)
    const reason = params.decision.reason ? `（${String(params.decision.reason).trim()}）` : ''
    model.decisions.push(`${day} ${params.decision.text.trim()}${reason}`)
  }
  model.updated = now.toISOString()

  const raw = renderProject(model)
  const targetFile =
    model.status === 'done'
      ? path.join(doneProjectsDir(params.projectsDir), `${safe}.md`)
      : path.join(params.projectsDir, `${safe}.md`)
  const staleFile =
    model.status === 'done'
      ? path.join(params.projectsDir, `${safe}.md`)
      : path.join(doneProjectsDir(params.projectsDir), `${safe}.md`)

  await writeFileAtomic(targetFile, raw, { fsyncFile: true, onFailureTmp: 'discard' })
  try {
    await fsp.unlink(staleFile)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return {
    model,
    raw,
    created: !existing.exists,
    path: targetFile,
    archived: model.status === 'done',
  }
}

/**
 * 只读「当前一棒」那一行，给简报用。读不到就返回 null，不抛。
 * @param {string} projectsDir
 * @param {string} id
 */
export async function readBaton(projectsDir, id) {
  try {
    const { model } = await readProject(projectsDir, id)
    return model.baton
  } catch {
    return null
  }
}

export { SECTION_KEYS }
