/**
 * 交接文件 —— 规格 §5 冻结。
 *
 * 双份制：`<实例>.machine.md`（dsh 读）+ `<实例>.user.md`（用户读），内容同源。
 * 固定名永远指向最新版；旧版只进 archive/versions/<实例>/，handoff 下禁止出现 .v<n>.md。
 *
 * 六节（machine）与五段（user）的结构在这里唯一确定：
 * 渲染与解析成对出现，改动一处必须同时改另一处，否则 inspect_handoff 会读偏。
 */

import { pluginError } from './errors.js'

/** machine 六节标题（顺序即结构，不得增删）。 */
export const MACHINE_SECTIONS = Object.freeze([
  '1. 身份',
  '2. 产物清单',
  '3. 目标与当前状态',
  '4. 方向锚点',
  '5. 事实 vs 假设',
  '6. 建议入口',
])

/**
 * update_handoff 只允许改这四节（§4.9 关键约束）。
 * 用节标题常量而不是序号，避免序号变了以后静默改错地方。
 */
export const UPDATABLE_SECTIONS = Object.freeze([
  '3. 目标与当前状态',
  '4. 方向锚点',
  '5. 事实 vs 假设',
  '6. 建议入口',
])

/** user 五段标题。 */
export const USER_SECTIONS = Object.freeze([
  '1. 这是什么',
  '2. 里面有什么',
  '3. 做到哪了',
  '4. 下一步',
  '5. 别当真',
])

/** 第 5 段无假设时的固定措辞（§5.3 硬约束：这一段必须出现）。 */
export const NO_ASSUMPTIONS_TEXT = '本次没有未验证的推断。'

const TYPE_LABELS = Object.freeze({
  file: '文件',
  dir: '文件夹',
  symlink: '链接',
  other: '其他',
})

/**
 * @typedef {object} ArtifactRow
 * @property {string} path       `<bucket>/<相对路径>`
 * @property {'file'|'dir'|'symlink'|'other'} type
 * @property {'yes'|'no'|'unknown'} exists
 * @property {number} size
 * @property {string|null} sha256
 * @property {'ok'|'partial'|'failed'|'missing'|'unknown'|'skipped_too_large'} hashStatus
 * @property {string} [note]
 */

/**
 * @typedef {object} MachineHandoffModel
 * @property {object} identity
 * @property {ArtifactRow[]} artifacts
 * @property {{goal: string, done: string[], blocked: string[]}} progress
 * @property {object} direction
 * @property {{confirmed: Array<{text: string, source: string}>, assumptions: string[]}} facts
 * @property {{readFirst: string[], avoid: string[]}} suggestions
 */

/** 把可能含换行的文本压成单行，防止破坏列表结构。 */
function oneLine(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ').trim()
}

/** 值里的 `｜` 会破坏产物清单的行结构，替换成全角竖线的近似符。 */
function safeCell(value) {
  return oneLine(value).replace(/\｜/g, '¦').replace(/\|/g, '¦')
}

/**
 * 渲染 machine 六节。
 * @param {MachineHandoffModel} model
 * @returns {string}
 */
export function renderMachine(model) {
  const id = model.identity ?? {}
  const lines = []

  lines.push(`# ${oneLine(id.displayName || id.instance || '未命名交接')}`)
  lines.push('')
  lines.push(`> 实例 \`${oneLine(id.instance)}\` · 类型 ${oneLine(id.typeDisplayName)} · 交接状态 ${oneLine(id.status || 'normal')}`)
  lines.push(`> 项目 ${oneLine(id.project || '未归项目')} · 交给 ${oneLine(id.to || 'any（接棒时空）')}`)
  lines.push('')

  // ── 1. 身份 ──
  lines.push(`## ${MACHINE_SECTIONS[0]}`)
  lines.push('')
  const identityFields = [
    ['类型', id.typeDisplayName],
    ['类型短名', id.typeSlug],
    ['实例物理名', id.instance],
    ['显示名', id.displayName],
    ['项目', id.project ?? '未归项目'],
    ['交给', id.to ?? 'any（接棒时空）'],
    ['创建时间', id.createdAt],
    ['最后更新时间', id.updatedAt],
    ['关联任务ID', id.taskId ?? '无'],
    ['effectiveTaskKey', id.effectiveTaskKey ?? '无'],
    ['taskId 作用域来源', id.taskIdScope ?? 'unknown'],
    ['关联会话ID', id.sessionId ?? '无'],
    ['来源', id.source ?? 'dsh'],
    ['交接状态', id.status ?? 'normal'],
  ]
  for (const [label, value] of identityFields) {
    lines.push(`- ${label}：${oneLine(value ?? '无')}`)
  }
  lines.push('')

  // ── 2. 产物清单 ──
  lines.push(`## ${MACHINE_SECTIONS[1]}`)
  lines.push('')
  lines.push('格式：`<bucket/相对路径>` ｜ 类型 ｜ 存在 ｜ 大小 ｜ SHA-256 ｜ hashStatus ｜ 备注')
  lines.push('')
  const artifacts = Array.isArray(model.artifacts) ? model.artifacts : []
  if (artifacts.length === 0) {
    lines.push('（本次没有产物）')
  } else {
    for (const row of artifacts) {
      lines.push(`- ${[
        `\`${safeCell(row.path)}\``,
        safeCell(row.type),
        safeCell(row.exists),
        String(Number.isFinite(row.size) ? row.size : 0),
        row.sha256 ? safeCell(row.sha256) : '无',
        safeCell(row.hashStatus),
        safeCell(row.note ?? ''),
      ].join(' ｜ ')}`)
    }
  }
  lines.push('')

  // ── 3. 目标与当前状态 ──
  lines.push(`## ${MACHINE_SECTIONS[2]}`)
  lines.push('')
  lines.push(`**本次目标**：${oneLine(model.progress?.goal || '未填写')}`)
  lines.push('')
  lines.push('**已完成**：')
  const done = Array.isArray(model.progress?.done) ? model.progress.done : []
  if (done.length === 0) lines.push('- （无）')
  else for (const item of done) lines.push(`- ${oneLine(item)}`)
  lines.push('')
  lines.push('**未完成或阻塞**：')
  const blocked = Array.isArray(model.progress?.blocked) ? model.progress.blocked : []
  if (blocked.length === 0) lines.push('- （无）')
  else for (const item of blocked) lines.push(`- ${oneLine(item)}`)
  lines.push('')

  // ── 4. 方向锚点 ──
  lines.push(`## ${MACHINE_SECTIONS[3]}`)
  lines.push('')
  const dir = model.direction ?? {}
  const directionFields = [
    ['本次方向', dir.direction || '未填写'],
    ['directionId', dir.directionId ?? '无'],
    ['previousDirectionId', dir.previousDirectionId ?? '无'],
    ['关系', dir.relation ?? 'origin'],
    ['原因', dir.reason ?? '未填写'],
    // 用户裁决字段 dsh 不得自行填写（§5.2 硬约束）：没裁决就写「未裁决」。
    ['用户裁决', dir.userVerdict ?? '未裁决'],
    ['裁决记录位置', dir.verdictRef ?? '无'],
  ]
  for (const [label, value] of directionFields) {
    lines.push(`- ${label}：${oneLine(value)}`)
  }
  lines.push('')

  // ── 5. 事实 vs 假设（物理隔开，§5.2 硬约束）──
  lines.push(`## ${MACHINE_SECTIONS[4]}`)
  lines.push('')
  lines.push('### 已确认事实')
  lines.push('')
  const confirmed = Array.isArray(model.facts?.confirmed) ? model.facts.confirmed : []
  if (confirmed.length === 0) lines.push('- （无）')
  else {
    for (const item of confirmed) {
      const text = typeof item === 'string' ? item : item?.text
      const source = typeof item === 'string' ? '' : item?.source
      lines.push(`- ${oneLine(text)}${source ? `（来源：${oneLine(source)}）` : ''}`)
    }
  }
  lines.push('')
  lines.push('### 未验证假设')
  lines.push('')
  const assumptions = Array.isArray(model.facts?.assumptions) ? model.facts.assumptions : []
  if (assumptions.length === 0) lines.push('- （无）')
  else for (const item of assumptions) lines.push(`- ${oneLine(item)}（待证实）`)
  lines.push('')

  // ── 6. 建议入口 ──
  lines.push(`## ${MACHINE_SECTIONS[5]}`)
  lines.push('')
  lines.push('**建议先读**：')
  const readFirst = Array.isArray(model.suggestions?.readFirst) ? model.suggestions.readFirst : []
  if (readFirst.length === 0) lines.push('- （无）')
  else for (const item of readFirst) lines.push(`- ${oneLine(item)}`)
  lines.push('')
  lines.push('**建议不要做**：')
  const avoid = Array.isArray(model.suggestions?.avoid) ? model.suggestions.avoid : []
  if (avoid.length === 0) lines.push('- （无）')
  else for (const item of avoid) lines.push(`- ${oneLine(item)}`)
  lines.push('')
  // 0.5.4：`next` 的排版位（原来只进信箱/白板，交接正文里读不到）
  const nextUp = Array.isArray(model.suggestions?.next) ? model.suggestions.next : []
  if (nextUp.length > 0) {
    lines.push('**下一步（交给谁）**：')
    for (const item of nextUp) lines.push(`- ${oneLine(item)}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 用户版只说人话。机器侧那些词（taskId / idempotency / bucket / 会话 ID）
 * 对用户没有意义，混在句子里就是噪声，这里保守地摘掉它们。
 * 摘不干净的由调用方负责——end_task 的 done/blocked 本来就该写成大白话。
 *
 * @param {string} text
 * @returns {string}
 */
function stripTechTalk(text) {
  return oneLine(text)
    .replace(/（\s*(?:taskId|idempotency|bucket|effectiveTaskKey|sessionId)[^）]*）/gi, '')
    .replace(/\(\s*(?:taskId|idempotency|bucket|effectiveTaskKey|sessionId)[^)]*\)/gi, '')
    .replace(/\b(?:taskId|idempotency|effectiveTaskKey)\s*[:：]?\s*[\w:.\-]*/gi, '')
    .replace(/\bbucket\s*[:：]?\s*[\w.\-]*/gi, '')
    .replace(/\bauto-session-[\w\-]+/g, '')
    .replace(/\bsession-[\da-f]{8}-[\da-f\-]{20,}/gi, '')
    .replace(/[；;]\s*(?=[；;])/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[：:，,、\s]+|[：:，,、\s]+$/g, '')
    .trim()
}

/**
 * 人读的交接（§5.3 五段）。
 *
 * @param {import('./handoff.js').MachineHandoffModel} model
 * @param {{summaryItems?: string[]}} [extra]
 * @returns {string}
 */
export function renderUser(model, extra = {}) {
  const id = model.identity ?? {}
  const lines = []

  lines.push(`# ${oneLine(id.displayName || id.instance || '未命名')}`)
  lines.push('')

  // ── 1. 这是什么 ──
  lines.push(`## ${USER_SECTIONS[0]}`)
  lines.push('')
  const goal = oneLine(model.progress?.goal || '')
  const typeName = oneLine(id.typeDisplayName || '一次任务')
  lines.push(
    goal
      ? `这是「${typeName}」这一类里的一次整理结果，目标是：${goal}。`
      : `这是「${typeName}」这一类里的一次整理结果。`,
  )
  lines.push('')
  lines.push(`- 项目：${oneLine(id.project || '未归项目')} · 交给：${oneLine(id.to || 'any（接棒时空）')}`)
  lines.push('')

  // ── 2. 里面有什么 ──
  lines.push(`## ${USER_SECTIONS[1]}`)
  lines.push('')
  const items = Array.isArray(extra.summaryItems) && extra.summaryItems.length > 0
    ? extra.summaryItems
    : (model.artifacts ?? []).map((row) => {
        const note = oneLine(row.note ?? '')
        if (note) return note
        return `一份${TYPE_LABELS[row.type] ?? '东西'}`
      })
  if (items.length === 0) lines.push('- 这次没有产生任何东西。')
  else for (const item of items) lines.push(`- ${oneLine(item)}`)
  lines.push('')

  // ── 3. 做到哪了（三句话）──
  lines.push(`## ${USER_SECTIONS[2]}`)
  lines.push('')
  const doneList = Array.isArray(model.progress?.done) ? model.progress.done : []
  const blockedList = Array.isArray(model.progress?.blocked) ? model.progress.blocked : []
  const lastStop = stripTechTalk(model.progress?.lastStop || '')
  const donePlain = doneList.map(stripTechTalk).filter(Boolean)
  const blockedPlain = blockedList.map(stripTechTalk).filter(Boolean)
  lines.push(`上次到哪：${lastStop || '这是第一次整理这一类内容。'}`)
  lines.push('')
  lines.push(`这次做了什么：${donePlain.length > 0 ? donePlain.join('；') : '这次只是建立了记录，还没有实质产出。'}`)
  lines.push('')
  // 0.5.4：这一行原来写「下次可能要做什么」却塞了 blocked —— 卡住 ≠ 下一步。
  // 现在第 3 段只说「卡住的」，第 4 段才讲「下一步给谁」。
  lines.push(`卡住的地方：${blockedPlain.length > 0 ? blockedPlain.join('；') : '这次没有卡住的地方。'}`)
  lines.push('')

  // ── 4. 下一步 ──
  lines.push(`## ${USER_SECTIONS[3]}`)
  lines.push('')
  const verdict = model.direction?.userVerdict
  const nextUp = Array.isArray(model.suggestions?.next) ? model.suggestions.next : []
  const hasVerdict = Boolean(verdict) && verdict !== '未裁决' && verdict !== 'not_applicable'
  if (hasVerdict) {
    lines.push(`方向已经定了（你选的 ${oneLine(verdict)}），可以直接按这个往下走。`)
    lines.push('')
  }
  if (nextUp.length > 0) {
    lines.push('接下来是这些（每条后面都写着交给谁）：')
    lines.push('')
    for (const item of nextUp) lines.push(`- ${oneLine(stripTechTalk(item))}`)
    lines.push('')
  }
  if (blockedList.length > 0) {
    // 0.5.18：blocked 是「干活时撞上的坎」，不是「等你拍板的事」——原来那句「需要你决定怎么处理」
    // 让你误以为都在等他，其实多数是下一个时空该接着啃的。这里改成如实说明 + 给他一条真正的出口。
    lines.push(`还有 ${blockedList.length} 件事卡着（上面「卡住的地方」写着是什么）。这些不用你现在决定，下一棒会带着它们继续做；`)
    lines.push('要是你想先动哪一件，或者哪件其实不用做，跟我说一声就按你的来。')
  } else if (!hasVerdict && nextUp.length === 0) {
    lines.push('暂时不需要你做什么，想继续往下做的时候叫我一声就行。')
  }
  lines.push('')

  // ── 5. 别当真（必出现）──
  lines.push(`## ${USER_SECTIONS[4]}`)
  lines.push('')
  const assumptions = Array.isArray(model.facts?.assumptions) ? model.facts.assumptions : []
  if (assumptions.length === 0) {
    lines.push(NO_ASSUMPTIONS_TEXT)
  } else {
    lines.push('下面这些是我猜的，还没核实，别当结论用：')
    lines.push('')
    for (const item of assumptions) lines.push(`- ${oneLine(item)}`)
  }
  lines.push('')

  return lines.join('\n')
}

/**
 * 解析 machine 交接。用于 inspect_handoff 的 structured 输出与启动自愈回填。
 * 解不出来的字段给 null，不臆造。
 *
 * @param {string} text
 * @returns {{sections: Record<string, string>, structured: object}}
 */
export function parseMachine(text) {
  const raw = String(text ?? '')
  const sections = splitSections(raw, MACHINE_SECTIONS)

  const identity = {}
  for (const line of (sections[MACHINE_SECTIONS[0]] ?? '').split('\n')) {
    const m = /^-\s*([^：]+)：\s*(.*)$/.exec(line.trim())
    if (m) identity[m[1].trim()] = m[2].trim()
  }

  const artifacts = []
  for (const line of (sections[MACHINE_SECTIONS[1]] ?? '').split('\n')) {
    const trimmed = line.trim()
    // 老版本写出来的产物行没有 `- ` 前缀，这里两种都认，免得升级后读不回自己的历史。
    const body = trimmed.startsWith('- `') ? trimmed.slice(2) : trimmed.startsWith('`') ? trimmed : null
    if (body === null) continue
    const cells = body.split('｜').map((c) => c.trim())
    if (cells.length < 6) continue
    const pathCell = cells[0].replace(/^`|`$/g, '')
    artifacts.push({
      path: pathCell,
      type: cells[1],
      exists: cells[2],
      size: Number(cells[3]) || 0,
      sha256: cells[4] === '无' ? null : cells[4],
      hashStatus: cells[5],
      note: cells[6] ?? '',
    })
  }

  const progressBlock = sections[MACHINE_SECTIONS[2]] ?? ''
  const progress = {
    goal: pickInline(progressBlock, '本次目标') ?? '',
    done: pickBullets(progressBlock, '已完成'),
    blocked: pickBullets(progressBlock, '未完成或阻塞'),
  }

  const directionBlock = sections[MACHINE_SECTIONS[3]] ?? ''
  const directionRaw = {}
  for (const line of directionBlock.split('\n')) {
    const m = /^-\s*([^：]+)：\s*(.*)$/.exec(line.trim())
    if (m) directionRaw[m[1].trim()] = m[2].trim()
  }
  const direction = {
    direction: directionRaw['本次方向'] ?? '',
    directionId: nullIfNone(directionRaw.directionId),
    previousDirectionId: nullIfNone(directionRaw.previousDirectionId),
    relation: directionRaw['关系'] ?? 'origin',
    reason: directionRaw['原因'] ?? '',
    userVerdict: nullIfNone(directionRaw['用户裁决']),
    verdictRef: nullIfNone(directionRaw['裁决记录位置']),
  }

  const factsBlock = sections[MACHINE_SECTIONS[4]] ?? ''
  const [confirmedRaw, assumptionsRaw] = splitByHeading(factsBlock, '已确认事实', '未验证假设')
  const facts = {
    confirmed: pickBullets(confirmedRaw),
    assumptions: pickBullets(assumptionsRaw).map((s) => s.replace(/（待证实）$/, '')),
  }

  const suggestionsBlock = sections[MACHINE_SECTIONS[5]] ?? ''
  const suggestions = {
    readFirst: pickBullets(suggestionsBlock, '建议先读'),
    avoid: pickBullets(suggestionsBlock, '建议不要做'),
  }

  return {
    sections,
    structured: {
      identity: {
        typeDisplayName: identity['类型'] ?? null,
        typeSlug: identity['类型短名'] ?? null,
        instance: identity['实例物理名'] ?? null,
        displayName: identity['显示名'] ?? null,
        createdAt: identity['创建时间'] ?? null,
        updatedAt: identity['最后更新时间'] ?? null,
        taskId: nullIfNone(identity['关联任务ID']),
        effectiveTaskKey: nullIfNone(identity.effectiveTaskKey),
        taskIdScope: identity['taskId 作用域来源'] ?? 'unknown',
        sessionId: nullIfNone(identity['关联会话ID']),
        source: identity['来源'] ?? null,
        status: identity['交接状态'] ?? 'normal',
      },
      artifacts,
      progress,
      direction,
      facts,
      suggestions,
    },
  }
}

/**
 * 解析 user 版五段（只取原文，不做结构化推断）。
 * @param {string} text
 */
export function parseUser(text) {
  return splitSections(String(text ?? ''), USER_SECTIONS)
}

/**
 * 按 `## <标题>` 切节。标题必须精确匹配已知清单，未知节进 `_other`。
 * @param {string} text
 * @param {readonly string[]} knownTitles
 * @returns {Record<string, string>}
 */
function splitSections(text, knownTitles) {
  const result = {}
  const known = new Set(knownTitles)
  const lines = text.split('\n')
  let current = '_other'
  result[current] = ''

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m && known.has(m[1])) {
      current = m[1]
      result[current] = ''
      continue
    }
    if (m) {
      current = '_other'
      result[current] = result[current] ?? ''
    }
    result[current] = `${result[current] ?? ''}${line}\n`
  }
  return result
}

/**
 * 取 `**键**：值` 形式的单行值。
 * @param {string} block
 * @param {string} label
 */
function pickInline(block, label) {
  const re = new RegExp(`\\*\\*${label}\\*\\*[：:]\\s*(.*)`)
  const m = re.exec(block)
  return m ? m[1].trim() : null
}

/**
 * 取 `**标题**：` 之后的 `- ` 列表项，直到下一个 `**`。
 * @param {string} block
 * @param {string} [label] 省略时取整块里的列表项
 * @returns {string[]}
 */
function pickBullets(block, label) {
  let scope = block
  if (label) {
    const idx = block.indexOf(`**${label}**`)
    if (idx < 0) return []
    const rest = block.slice(idx + label.length + 4)
    const nextIdx = rest.search(/\n\*\*/)
    scope = nextIdx < 0 ? rest : rest.slice(0, nextIdx)
  }
  const out = []
  for (const line of scope.split('\n')) {
    const m = /^-\s+(.*)$/.exec(line.trim())
    if (!m) continue
    const value = m[1].trim()
    if (value === '（无）') continue
    out.push(value)
  }
  return out
}

/**
 * 把「已确认事实 / 未验证假设」两个 ### 子块切开。
 * @param {string} block
 * @param {string} a
 * @param {string} b
 * @returns {[string, string]}
 */
function splitByHeading(block, a, b) {
  const ia = block.indexOf(`### ${a}`)
  const ib = block.indexOf(`### ${b}`)
  if (ia < 0 || ib < 0 || ib < ia) return [block, '']
  return [block.slice(ia + a.length + 4, ib), block.slice(ib + b.length + 4)]
}

/** 「无」/「未裁决」/ 空串 → null。 */
function nullIfNone(value) {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  if (s === '' || s === '无' || s === '未裁决') return null
  return s
}

/**
 * 渲染前的结构自检：缺必填字段就拒绝写盘（E_VALIDATION_BLOCKING）。
 * @param {MachineHandoffModel} model
 */
export function validateModel(model) {
  const id = model.identity ?? {}
  const problems = []
  if (!id.instance) problems.push('身份节缺「实例物理名」')
  if (!id.typeSlug) problems.push('身份节缺「类型短名」')
  if (!id.displayName) problems.push('身份节缺「显示名」')
  if (!id.createdAt) problems.push('身份节缺「创建时间」')
  if (!id.updatedAt) problems.push('身份节缺「最后更新时间」')
  if (!Array.isArray(model.artifacts)) problems.push('产物清单必须是数组')

  for (const row of model.artifacts ?? []) {
    if (!row.path) problems.push('产物清单存在空路径')
    if (!['file', 'dir', 'symlink', 'other'].includes(row.type)) {
      problems.push(`产物类型非法：${row.type}（${row.path}）`)
    }
    if (!['yes', 'no', 'unknown'].includes(row.exists)) {
      problems.push(`产物存在性非法：${row.exists}（${row.path}）`)
    }
    if (!row.hashStatus) problems.push(`产物缺 hashStatus（${row.path}）`)
  }

  if (problems.length > 0) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'handoff',
      reason: problems.join('；'),
    })
  }
  return true
}

/**
 * 固定名生成：文件名就是内容总结 —— `<日期>-<时分>-<总结>.machine.md` / `.user.md`。
 *
 * 0.3.22 起按你要求统一：查的时候扫文件名就知道内容，不再用 `<实例>.machine.md`。
 * 老文件仍按实例名存在，由 catalog 的扫盘逻辑按 mtime 兜底显示。
 *
 * @param {string} instance
 * @param {{ displayName?: string, at?: Date }} [options]
 */
export function handoffFileNames(instance, options = {}) {
  const at = options.at instanceof Date ? options.at : new Date()
  const bj = new Date(at.getTime() + 8 * 3600e3).toISOString()
  const date = bj.slice(0, 10)
  const hm = bj.slice(11, 13) + bj.slice(14, 16)
  const raw = String(options.displayName || instance || '交接')
  const summary =
    raw
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || '交接'
  const stem = `${date}-${hm}-${summary}`
  return {
    stem,
    machine: `${stem}.machine.md`,
    user: `${stem}.user.md`,
  }
}
