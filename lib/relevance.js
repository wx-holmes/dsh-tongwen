/**
 * 相关性路由（0.5.20）——「这次要做什么，就只给什么」。
 *
 * 你 2026-11-06 22:13 的要求：通知堆在一起既费时间又拉低准确度；
 * 上传就该定位到隐私手册，做插件就该定位到联动契约。要的是相关性，
 * 不是一股脑全推。
 *
 * 做法分两步，都可检：
 *   1) 主题表 TOPICS：每个主题 → 关键词 + 该读的文档（含章节线索）；
 *   2) routeFocus()：拿一句任务描述打分，返回「读哪几页 + 哪几条请求相关」，
 *      其余明确标成「不相关，先放着」。
 *
 * 这里只做判断，不读用户目录之外的东西，也不改任何文件。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/** 关键词命中上限：同一关键词出现很多次也不该压过别的主题。 */
const PER_KEYWORD_CAP = 3

/** 主题表。docs 里的 path 相对交接根目录；check 用来在文档里找对应小节。 */
export const TOPICS = [
  {
    id: 'publish',
    label: '发布 / 上传公开仓库',
    keywords: ['上传', '推送', 'push', '公开仓库', '仓库', 'github', '隐私', '清洗', '发布', 'commit', 'git'],
    docs: [
      { path: 'handoff/手册/上传仓库前的隐私清洗.md', why: '上传/推送前先过清洗，两类隐私都要扫' },
      { path: 'handoff/手册/交接规范.md', why: '收尾仍要产出两份交接' },
    ],
  },
  {
    id: 'plugin',
    label: '做插件 / 合体联动',
    keywords: ['插件', '名片', '器官', 'organ', '联动', '契约', '接口', '能力', '事件', '心跳', '手', '合体'],
    docs: [
      { path: 'handoff/手册/插件接口与合体契约.md', why: '名片四插头 + 三条规矩 + 吸收不是照抄' },
      { path: 'handoff/手册/联动契约.md', why: '合体时怎么调别人、怎么退化' },
      { path: 'handoff/手册/合体接入清单.md', why: '接入自检清单' },
      { path: 'handoff/手册/断言契约.md', why: '验收断言怎么写、放在哪一层' },
    ],
  },
  {
    id: 'restart',
    label: '重启 DSH',
    keywords: ['重启', '端口', '排程', 'restart', '加载'],
    docs: [{ path: 'handoff/手册/重启.md', why: '只走 restart_dsh + 排程脚本；端口会变' }],
  },
  {
    id: 'handoff',
    label: '交接 / 收尾',
    keywords: ['交接', '归档', '收尾', 'end_task', 'begin_task', 'machine', '用户版', '配对', 'next'],
    docs: [
      { path: 'handoff/手册/交接规范.md', why: '两份交接、字段写法、next 四种写法' },
      { path: 'handoff/手册/信息分层.md', why: '哪个读者看哪一层' },
    ],
  },
  {
    id: 'files',
    label: '文件存放 / 九档',
    keywords: ['文件', '存放', '路径', '九档', '落盘', '软删', '目录', '归档'],
    docs: [
      { path: 'handoff/索引/文件目录.md', why: '九档与各区放置规则' },
      { path: 'handoff/手册/信息分层.md', why: '为什么放这一层' },
    ],
  },
  {
    id: 'ledger',
    label: '账本 / 资源',
    keywords: ['账本', 'strong', '日报', 'token', '额度'],
    docs: [{ path: 'logs/账本/记录规范.md', why: '一行一条、字段与口径' }],
  },
  {
    id: 'memory',
    label: '记忆 / 日档 / 人格',
    keywords: ['记忆', '人格', 'persona', '日档', '日记', '自我'],
    docs: [
      { path: 'handoff/手册/记忆卡时空来源.md', why: '记忆卡从哪来、写什么' },
      { path: 'self/日档/README.md', why: '日档五段怎么写' },
    ],
  },
]

/** 兜底主题：什么都没看出来时，只给「先看规矩」这一页。 */
const FALLBACK = {
  id: 'general',
  label: '未识别（先看规矩）',
  keywords: [],
  docs: [{ path: 'handoff/手册总览.md', why: '不确定主题时只读这一页，再回来调 focus_context 细化' }],
}

/**
 * 打分：关键词按出现次数计（每词封顶 3），标签整体命中再加 2。
 * 不做模糊匹配——宁可漏，也不要把无关的东西推给人。
 */
export function detectTopics(taskText) {
  const text = String(taskText ?? '').toLowerCase()
  if (!text.trim()) return []
  const scored = []
  for (const topic of TOPICS) {
    let score = 0
    const hits = []
    for (const kw of topic.keywords) {
      const needle = kw.toLowerCase()
      if (!needle) continue
      let count = 0
      let from = 0
      while (count < PER_KEYWORD_CAP) {
        const at = text.indexOf(needle, from)
        if (at < 0) break
        count += 1
        from = at + needle.length
      }
      if (count > 0) {
        score += count
        hits.push(kw)
      }
    }
    if (score > 0) scored.push({ id: topic.id, label: topic.label, score, hits })
  }
  return scored.sort((a, b) => b.score - a.score)
}

/** 取相关文档（去重、保序）。主题没命中时返回兜底文档。 */
export function collectDocs(topics) {
  const picked = topics.length > 0 ? topics : [FALLBACK]
  const seen = new Set()
  const out = []
  for (const t of picked) {
    const def = TOPICS.find((x) => x.id === t.id) ?? FALLBACK
    for (const doc of def.docs) {
      if (seen.has(doc.path)) continue
      seen.add(doc.path)
      out.push({ ...doc, topic: def.id, topicLabel: def.label })
    }
  }
  return out
}

/** 文档摘要：是否存在、多大、和主题相关的小节（标题行）。读不到就如实说。 */
export async function inspectDoc(root, doc, topics) {
  const abs = path.join(root, doc.path)
  const info = { path: doc.path, why: doc.why, topic: doc.topic, topicLabel: doc.topicLabel, exists: false }
  let text
  try {
    const st = await fsp.stat(abs)
    if (!st.isFile()) return { ...info, error: '不是文件' }
    text = await fsp.readFile(abs, 'utf8')
    info.exists = true
    info.bytes = st.size
  } catch {
    return { ...info, error: '文件不存在或读不到' }
  }
  const lines = text.split(/\r?\n/)
  info.totalLines = lines.length
  const words = new Set()
  for (const t of topics.length > 0 ? topics : [])
    for (const kw of TOPICS.find((x) => x.id === t.id)?.keywords ?? []) words.add(kw.toLowerCase())
  const headings = []
  for (let i = 0; i < lines.length && headings.length < 3; i += 1) {
    const line = lines[i]
    if (!/^#{1,4}\s/.test(line)) continue
    const low = line.toLowerCase()
    if ([...words].some((w) => low.includes(w))) headings.push({ line: i + 1, text: line.replace(/^#{1,4}\s*/, '').trim() })
  }
  if (headings.length === 0) {
    const first = lines.findIndex((l) => /^#\s/.test(l))
    if (first >= 0) headings.push({ line: first + 1, text: lines[first].replace(/^#\s*/, '').trim() })
  }
  info.headings = headings
  return info
}

/**
 * 给一条请求打分：项目对上最重要，其次是主题词，再次是点名给我。
 * 返回 {score, why[]}；分数 0 表示看不出相关——不删，只降级。
 */
export function scoreRequest(item, { task, project, sessionId, topics }) {
  const why = []
  let score = 0
  const body = `${item.request ?? ''} ${item.project ?? ''}`.toLowerCase()
  if (project && item.project === project) {
    score += 4
    why.push(`同一项目 ${project}`)
  }
  if (sessionId && item.to === sessionId) {
    score += 3
    why.push('点名给我')
  } else if (item.to === 'any') {
    score += 1
    why.push('广播')
  }
  const words = new Set()
  for (const kw of String(task ?? '').toLowerCase().split(/[\s,，。;；、/]+/)) {
    if (kw.length >= 2) words.add(kw)
  }
  for (const t of topics) {
    for (const kw of TOPICS.find((x) => x.id === t.id)?.keywords ?? []) words.add(kw.toLowerCase())
  }
  let hits = 0
  for (const w of words) {
    if (w && body.includes(w)) hits += 1
  }
  if (hits > 0) {
    score += Math.min(hits, 4)
    why.push(`命中 ${hits} 个相关词`)
  }
  return { score, why }
}

/**
 * 主入口：给一句任务描述，返回该读什么、哪些请求相关、其余先放着。
 *
 * @param {object} params
 * @param {string} params.root 交接根目录
 * @param {string} params.task 这次要做什么（一句话）
 * @param {string} [params.project] 当前项目 id
 * @param {string} [params.sessionId]
 * @param {Array<object>} [params.requests] 未关闭的请求（已由调用方读出）
 * @param {number} [params.limit]
 */
export async function routeFocus({ root, task, project, sessionId, requests = [], limit = 5 }) {
  const topics = detectTopics(task)
  const docs = collectDocs(topics)
  const read = []
  for (const doc of docs) read.push(await inspectDoc(root, doc, topics))

  const scored = requests
    .map((item) => {
      const { score, why } = scoreRequest(item, { task, project, sessionId, topics })
      return { item, score, why }
    })
    .sort((a, b) => b.score - a.score)

  const relevant = scored.filter((x) => x.score >= 2).slice(0, limit)
  const ignored = scored.length - relevant.length

  return {
    task: String(task ?? ''),
    project: project ?? null,
    topics: topics.length > 0 ? topics : [{ id: FALLBACK.id, label: FALLBACK.label, score: 0, hits: [] }],
    read: read.map((d) => ({
      path: d.path,
      why: d.why,
      topic: d.topic,
      exists: d.exists,
      bytes: d.bytes ?? null,
      totalLines: d.totalLines ?? null,
      headings: d.headings ?? [],
      ...(d.error ? { error: d.error } : {}),
    })),
    requests: relevant.map((x) => ({
      id: x.item.id,
      to: x.item.to,
      project: x.item.project ?? null,
      score: x.score,
      why: x.why,
      request: String(x.item.request ?? '').slice(0, 200),
      createdAt: x.item.createdAt ?? null,
    })),
    requestsIgnored: ignored,
    rule:
      topics.length > 0
        ? '只读 read 里列出的文件（优先 headings 指的小节）；requests 之外的请求先放着，等任务相关了再看。'
        : '没看出主题：只读兜底那一页；任务说清楚一点再调一次。',
  }
}

/** 给开场注用的一行索引：让人知道有这条路，不用背主题表。 */
export function topicIndexLine() {
  return TOPICS.map((t) => `${t.id}→${t.label}`).join('；')
}
