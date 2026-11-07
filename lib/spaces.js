/**
 * 时空地址簿（0.5.32）
 *
 * 目的：给「现在有哪些时空活着、它们各自住哪」一份可读、可路由的清单，
 * 后续虫洞要精准投递时，直接按 address 投，不用再猜 id。
 *
 * 事实来源（全部只读，不猜）：
 *   1. `$DSH_HOME/storages/workspace.json` —— 工作区的**权威**归属表：
 *      workspaceId(uuid) + path + title + sessionIds[]，以及哪些会话已归档。
 *   2. `$DSH_HOME/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd` —— 落盘事实：
 *      文件大小 + 最后写入时间（用来判「活着 / 歇了 / 凉了」）。
 *   3. `handoff/projects/*.md` —— 白板里提到过的会话 id，用来标「这条时空在管哪个项目」。
 *
 * 两种 id 的区别（写清楚，省得再混）：
 *   - **sessionId**：`session-xxxxxxxx-....`，一次对话一个。环境变量 `DSH_SESSION_ID` 给的就是它，
 *     决定会话文件落在哪个桶；虫洞投递投的是它。地址 `dsh://session/<sessionId>`。
 *   - **workspaceId**：`xxxxxxxx-....`（uuid），一个工作区一个，多个会话共用。
 *     它决定「这个时空开在哪个桌面/文件夹」。地址 `dsh://workspace/<workspaceId>`。
 *   - 另外，工具回执里出现的 `sessionId` 不一定是「你」的——见《运维两个坑》§一。
 *
 * 只读扫描，不写任何会话文件。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

const ACTIVE_MS = 15 * 60 * 1000
const IDLE_MS = 24 * 60 * 60 * 1000

function homeFromEnv() {
  return process.env.DSH_HOME || 'A:\\dsh-home'
}

function shortHandle(sessionId) {
  const m = /^session-([0-9a-f]{8})/i.exec(sessionId)
  return m ? m[1] : sessionId.slice(-8)
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 时空名册（手写、只追加）：谁给自己起了什么名字 → 地址。地址由 space_register 工具自己填，不靠人抄。 */
export async function readRoster(root) {
  const file = path.join(root, 'handoff', '时空名册.md')
  const map = new Map()
  try {
    const raw = await fsp.readFile(file, 'utf8')
    // 「已替换」段只是留档，不参与解析——否则旧行会把现行行盖掉
    const text = raw.split('## 已替换')[0]
    for (const line of text.split('\n')) {
      const m = /^-\s*([^|]+?)\s*\|\s*(dsh:\/\/session\/session-[0-9a-f-]{36})/.exec(line.trim())
      if (!m) continue
      const [, name, address] = m
      const sid = address.split('/').pop()
      map.set(sid, { name: name.trim(), address })
    }
  } catch {
    // 名册还没建：空表就行
  }
  return { file, map }
}

/** 按地址登记一行（覆盖式：同 sid 或同名只留一行）。返回写进去的那一行。 */
export async function appendRoster(root, { sessionId, name, workspaceTitle }) {
  const file = path.join(root, 'handoff', '时空名册.md')
  const nowText = new Date().toLocaleString('zh-CN', { hour12: false })
  const line = `- ${name} | dsh://session/${sessionId} | ${workspaceTitle ?? '—'} | ${nowText}`
  const header =
    '# 时空名册\n\n' +
    '> `space_register` 自动维护：**每个地址只留一行、每个名字只留一行**（重启/改名会替换旧的，不再追加）。\n' +
    '> 格式：`- 名字 | 地址 | 工作区 | 登记时间`\n\n' +
    '## 现行\n\n'
  const dropHeader =
    '\n\n## 已替换（留档，不再生效）\n\n'
  let text = ''
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    text = header
  }
  // 拆成「现行」与「已替换」两段；现行段里同 sid / 同名 的行要被替换
  const [beforeRetired] = text.split(dropHeader)
  const retiredPart = text.includes(dropHeader) ? text.split(dropHeader)[1] : ''
  const bodyLines = beforeRetired.split('\n')
  const keep = []
  const retired = []
  for (const raw of bodyLines) {
    const m = /^-\s*([^|]+?)\s*\|\s*(dsh:\/\/session\/session-[0-9a-f-]{36})/.exec(raw.trim())
    if (!m) {
      keep.push(raw)
      continue
    }
    const sid = m[2].split('/').pop()
    if (sid === sessionId || m[1].trim() === name) retired.push(raw.trim())
    else keep.push(raw)
  }
  let body = keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
  if (!body.includes('## 现行')) body = header + body.replace(/^# 时空名册[\s\S]*?(?=\n-\s|$)/, '').trimStart()
  const retiredLines = [...retired, ...retiredPart.split('\n').filter((l) => /^-\s/.test(l.trim()))]
  const next =
    body +
    (body.endsWith('\n') ? '' : '\n') +
    line +
    '\n' +
    (retiredLines.length ? dropHeader + retiredLines.join('\n') + '\n' : '')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  // 0.5.40：写前留一份 .bak。人手重写会擦掉别人的行（2026-11-08 03:41 就这么丢过意识那一行）
  try {
    await fsp.copyFile(file, file + '.bak')
  } catch {
    // 第一次写没有旧文件，正常
  }
  await fsp.writeFile(file, next, 'utf8')
  return { file, line, replaced: retired.length }
}

/** 扫 sessions 目录：sid -> {bucket, bytes, lastWriteMs} */
async function scanSessionFiles(sessionsRoot) {
  const out = new Map()
  let buckets
  try {
    buckets = await fsp.readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const bucketDir = path.join(sessionsRoot, bucket.name)
    let entries
    try {
      entries = await fsp.readdir(bucketDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
      const file = path.join(bucketDir, entry.name, 'session.v4.jsonl.zstd')
      try {
        const st = await fsp.stat(file)
        out.set(entry.name, {
          bucket: bucket.name,
          bytes: st.size,
          lastWriteMs: st.mtimeMs,
        })
      } catch {
        out.set(entry.name, { bucket: bucket.name, bytes: 0, lastWriteMs: 0 })
      }
    }
  }
  return out
}

/** 白板里出现过的会话 id → 项目 id 列表 */
async function scanProjectRefs(projectsDir) {
  const map = new Map()
  let files
  try {
    files = await fsp.readdir(projectsDir, { withFileTypes: true })
  } catch {
    return map
  }
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue
    const projectId = f.name.replace(/\.md$/, '')
    let text
    try {
      text = await fsp.readFile(path.join(projectsDir, f.name), 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) {
      const sid = m[0]
      const list = map.get(sid) ?? []
      if (!list.includes(projectId)) list.push(projectId)
      map.set(sid, list)
    }
  }
  return map
}

/** 项目的标题与一句话目标（用来给「这次要做什么」打分） */
async function scanProjectMeta(projectsDir) {
  const out = new Map()
  let files
  try {
    files = await fsp.readdir(projectsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue
    const id = f.name.replace(/\.md$/, '')
    let text
    try {
      text = await fsp.readFile(path.join(projectsDir, f.name), 'utf8')
    } catch {
      continue
    }
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? ''
    const goal = /^##\s*目标\s*$([\s\S]*?)(?=^##\s|\Z)/m.exec(text)?.[1]?.trim().split('\n')[0]?.trim() ?? ''
    out.set(id, { id, title, goal })
  }
  return out
}

/** 中文按 2 字切、英文数字按词切；短的（<2）丢掉 */
export function tokenizeTask(task) {
  const text = String(task ?? '').toLowerCase()
  const tokens = new Set()
  for (const m of text.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) tokens.add(m[0])
  const cjk = text.replace(/[^\u4e00-\u9fff]+/g, ' ')
  for (const chunk of cjk.split(/\s+/)) {
    if (!chunk) continue
    if (chunk.length <= 2) tokens.add(chunk)
    else for (let i = 0; i + 2 <= chunk.length; i += 1) tokens.add(chunk.slice(i, i + 2))
  }
  return [...tokens]
}

/**
 * 按任务给时空排序：谁的白板跟这件事最对得上，就把地址排前面。
 * 打分只看「项目标题 + 目标」的字面命中——不做语义猜测，命中几个词就是几分，可审计。
 */
export function rankSpacesByTask(book, task, { status = null, excludeSelf = false, selfId = null, includeArchived = false } = {}) {
  const tokens = tokenizeTask(task)
  const projectScore = new Map()
  for (const meta of book.projects ?? []) {
    const hay = `${meta.id} ${meta.title} ${meta.goal}`.toLowerCase()
    const hits = tokens.filter((t) => hay.includes(t))
    if (hits.length) projectScore.set(meta.id, { score: hits.length, hits })
  }
  const rows = []
  for (const s of book.spaces) {
    if (status && s.status !== status) continue
    // 已归档的不作候选：它还能收信，但不会回话；要列出来得显式 includeArchived
    if (!includeArchived && s.status === 'archived') continue
    // 空壳不当候选：它不会回话，投进去等于扔掉
    if (s.status === 'stub') continue
    if (excludeSelf && (s.self || (selfId && s.sessionId === selfId))) continue
    let best = 0
    const matched = []
    for (const pid of s.projects) {
      const hit = projectScore.get(pid)
      if (!hit) continue
      if (hit.score > best) best = hit.score
      matched.push({ project: pid, score: hit.score, hits: hit.hits })
    }
    if (best <= 0) continue
    matched.sort((a, b) => b.score - a.score)
    const statusBonus = s.status === 'active' ? 0.5 : s.status === 'idle' ? 0.2 : 0
    // 越近动过越可信：24 小时内线性给 0~0.3 分
    const ageMin = s.ageMinutes ?? 24 * 60
    const recencyBonus = Math.max(0, 0.3 * (1 - Math.min(ageMin, 24 * 60) / (24 * 60)))
    const nameHits = s.name ? tokens.filter((t) => s.name.toLowerCase().includes(t)) : []
    const score = best + statusBonus + recencyBonus + (nameHits.length ? 0.8 : 0)
    rows.push({
      ...s,
      score: Number(score.toFixed(2)),
      matchedProjects: matched.slice(0, 3),
      matchedName: nameHits.length ? nameHits : undefined,
      why: `命中 ${best} 个词（${matched[0]?.project ?? ''}）${nameHits.length ? ` + 名字命中 ${nameHits.join('/')}` : ''} + 状态 ${s.status} + 最后活动 ${s.ageMinutes ?? '?'} 分钟前`,
    })
  }
  rows.sort((a, b) => b.score - a.score || (b.lastWriteAt ?? '').localeCompare(a.lastWriteAt ?? ''))
  return rows
}

function statusOf(ageMs, archived, bytes = 0) {
  if (archived) return 'archived'
  // 空壳：几百字节的会话文件不可能在干活（2026-11-08 黑洞/意识都踩过这种壳）
  if (bytes > 0 && bytes < 4096) return 'stub'
  if (ageMs <= ACTIVE_MS) return 'active'
  if (ageMs <= IDLE_MS) return 'idle'
  return 'stale'
}

/**
 * 扫一遍磁盘，返回地址簿。
 * @param {{root: string, sessionId?: string|null, now?: number}} opts  root = handoff 根目录
 */
export async function collectSpaces({ root, sessionId = null, now = Date.now() }) {
  const dshHome = homeFromEnv()
  const wsFile = path.join(dshHome, 'storages', 'workspace.json')
  const sessionsRoot = path.join(dshHome, 'sessions')
  const projectsDir = path.join(root, 'handoff', 'projects')

  const ws = (await readJson(wsFile)) ?? {}
  const files = await scanSessionFiles(sessionsRoot)
  const projectRefs = await scanProjectRefs(projectsDir)
  const projectMeta = await scanProjectMeta(projectsDir)
  const roster = await readRoster(root)
  const archived = new Set(ws?.global?.archivedSessionIds ?? [])
  const table = ws?.tables?.workspaces ?? {}

  const spaces = []
  for (const [workspaceId, entry] of Object.entries(table)) {
    for (const sid of entry.sessionIds ?? []) {
      const file = files.get(sid) ?? null
      const lastWriteMs = file?.lastWriteMs || 0
      const ageMs = lastWriteMs ? Math.max(0, now - lastWriteMs) : null
      const isArchived = archived.has(sid)
      spaces.push({
        address: `dsh://session/${sid}`,
        handle: shortHandle(sid),
        sessionId: sid,
        workspace: {
          address: `dsh://workspace/${workspaceId}`,
          id: workspaceId,
          title: entry.title ?? null,
          path: entry.path ?? null,
        },
        bytes: file?.bytes ?? null,
        lastWriteAt: lastWriteMs ? new Date(lastWriteMs).toISOString() : null,
        ageMinutes: ageMs === null ? null : Math.round(ageMs / 60000),
        status: statusOf(ageMs ?? Number.MAX_SAFE_INTEGER, isArchived, file?.bytes ?? 0),
        self: sessionId ? sid === sessionId : false,
        name: roster.map.get(sid)?.name ?? null,
        projects: projectRefs.get(sid) ?? [],
      })
    }
  }

  // 磁盘上有、归属表里没有的（孤儿会话）也列出来：它们照样能收信
  for (const [sid, file] of files) {
    if (spaces.some((s) => s.sessionId === sid)) continue
    const ageMs = file.lastWriteMs ? Math.max(0, now - file.lastWriteMs) : null
    spaces.push({
      address: `dsh://session/${sid}`,
      handle: shortHandle(sid),
      sessionId: sid,
      workspace: { address: null, id: null, title: null, path: null },
      bytes: file.bytes,
      lastWriteAt: file.lastWriteMs ? new Date(file.lastWriteMs).toISOString() : null,
      ageMinutes: ageMs === null ? null : Math.round(ageMs / 60000),
      status: statusOf(ageMs ?? Number.MAX_SAFE_INTEGER, archived.has(sid), file.bytes),
      self: sessionId ? sid === sessionId : false,
      name: roster.map.get(sid)?.name ?? null,
      projects: projectRefs.get(sid) ?? [],
      orphan: true,
    })
  }

  spaces.sort((a, b) => (b.lastWriteAt ?? '').localeCompare(a.lastWriteAt ?? ''))
  const byStatus = (s) => spaces.filter((x) => x.status === s).length
  return {
    generatedAt: new Date(now).toISOString(),
    sessionsRoot,
    workspaceFile: wsFile,
    total: spaces.length,
    counts: {
      active: byStatus('active'),
      idle: byStatus('idle'),
      stale: byStatus('stale'),
      archived: byStatus('archived'),
      stub: byStatus('stub'),
      orphan: spaces.filter((s) => s.orphan).length,
    },
    projects: [...projectMeta.values()],
    rosterFile: roster.file,
    registered: roster.map.size,
    spaces,
  }
}

/** 按地址 / 会话 id / 短句柄 找一条 */
export function findSpace(book, key) {
  if (!key) return null
  const k = String(key).trim()
  return (
    book.spaces.find((s) => s.address === k) ??
    book.spaces.find((s) => s.sessionId === k) ??
    book.spaces.find((s) => s.handle === k) ??
    book.spaces.find((s) => s.workspace.address === k) ??
    null
  )
}
