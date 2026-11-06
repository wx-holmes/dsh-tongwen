/**
 * 相关性路由（0.5.20，0.5.23 分类与权重，0.5.24 九档全覆盖 + 教训预读）
 *
 * 你 2026-11-06 22:13 要的：通知堆在一起既费时间又拉低准确度；上传就该定位到
 * 隐私手册，做插件就该定位到《插件的自我管理》。要的是相关性，不是一股脑全推。
 * 22:54 又补了两条：九档都要能按相关性推（self 是我自己的东西，记忆/人格都能推）；
 * 教训日记要按相关度排——一个时空在做某件事时，把以前同类踩过的坑推给它，
 * 这样它不会在同一条沟里翻第二次车。
 *
 * 做法分三步，都可检：
 *   1) 主题表 TOPICS：每个主题 → 关键词 + 优先级 + 该读的文档（含章节线索）；
 *   2) 动态文档 DYNAMIC_DIRS：教训日记按任务相关度挑、日档按最新挑（不是死名单）；
 *   3) routeFocus()：拿一句任务描述打分，返回「读哪几页 + 哪几条请求相关」，
 *      其余明确标成「不相关，先放着」；教训即使没被提名，也自动预读相关的那几篇。
 *
 * 0.5.23 起主题表带「类别骨架」，0.5.24 扩到九档：
 *   - `priority`（0-100，唯一）：同分时按它排；也是「该先看哪类」的排序依据；
 *   - `tier`：core（核心）/ frequent（常用）/ occasional（偶发）/ bucket（九档分区）/ fallback；
 *   - `why`：为什么把它排在这个位置（可审计，不靠记忆）；
 *   - `TOPIC_SCHEMA_VERSION` + `validateTopics()`：加主题/改文档时先自检；
 *   - `topicTable()`：一眼看清现在有几大类、各自的序位，不用去读源码。
 *
 * 这里只做判断，不读用户目录之外的东西，也不改任何文件。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/** 关键词命中上限：同一关键词出现很多次也不该压过别的主题。 */
const PER_KEYWORD_CAP = 3

/**
 * 主题表结构版本。加主题、改字段、删主题时 +1，`validateTopics()` 会把它带出去，
 * 老时空（或旧版插件）读到新表能立刻看出「表变过」。
 *   1 → 0.5.23 初始骨架（7 主题 + 兜底）
 *   2 → 0.5.24 九档全覆盖 + 动态文档（教训/日档）
 */
export const TOPIC_SCHEMA_VERSION = 2

/** 类别分档：核心 / 常用 / 偶发 / 九档分区 / 兜底。只用来解释排序，不参与打分。 */
export const TIER_LABEL = {
  core: '核心',
  frequent: '常用',
  occasional: '偶发',
  bucket: '九档分区',
  fallback: '兜底',
}

/**
 * 主题表。docs 里的 path 相对交接根目录；check 用来在文档里找对应小节。
 *
 * 排序口径（priority，0-100，唯一）：出现频率 × 出错代价。
 *   - 核心（94-85）：每件事都要碰（交接）、当前主线（插件）、不可逆（发布）、
 *     别再翻车（教训）；
 *   - 常用（80-68）：我自己的东西（self）、路面本身（九档）、全时空断（重启）；
 *   - 偶发（62-56）：日志审计、账本；
 *   - 九档分区（48-26）：created/downloads/incoming/config/scratch/archive——
 *     它们大多只在「东西该放哪、从哪来、删了怎么找回」时才有用，所以排在后面，
 *     但每一档都能被认出来，不再有「找不到该读哪页」的档。
 * `why` 写清为什么排这个位置——排序要可审计，不靠记忆。
 */
export const TOPICS = [
  {
    id: 'handoff',
    label: '交接 / 收尾',
    tier: 'core',
    priority: 94,
    why: '每件事都以交接收口；写漏一次，后面接着干的人全跟着错',
    keywords: ['交接', '归档', '收尾', 'end_task', 'begin_task', 'machine', '用户版', '配对', 'next'],
    docs: [
      { path: 'handoff/手册/交接规范.md', why: '两份交接、字段写法、next 四种写法' },
      { path: 'handoff/手册/信息分层.md', why: '哪个读者看哪一层' },
    ],
  },
  {
    id: 'plugin',
    label: '做插件 / 合体联动',
    tier: 'core',
    priority: 90,
    why: '当前主线：安全插件、外部插件、人格、书同文自己都在这一层互相咬合',
    keywords: ['插件', '名片', '器官', 'organ', '联动', '契约', '接口', '能力', '事件', '心跳', '手', '合体', '提示词'],
    docs: [
      { path: 'handoff/手册/插件的自我管理.md', why: '一页读完：三条规矩 + 名片四插头 + 合体与门 + 自查 + 现状' },
      { path: 'handoff/手册/断言契约.md', why: '验收断言怎么写、放在哪一层' },
    ],
  },
  {
    id: 'publish',
    label: '发布 / 上传公开仓库',
    tier: 'core',
    priority: 87,
    why: '对外交付不可逆：推出去就收不回，隐私漏一次补不回来',
    keywords: ['上传', '推送', 'push', '公开仓库', '仓库', 'github', '隐私', '清洗', '发布', 'commit', 'git'],
    docs: [
      { path: 'handoff/手册/上传仓库前的隐私清洗.md', why: '上传/推送前先过清洗，两类隐私都要扫' },
      { path: 'handoff/手册/交接规范.md', why: '收尾仍要产出两份交接' },
    ],
  },
  {
    id: 'lessons',
    label: '教训日记 / 别再踩同一个坑',
    tier: 'core',
    priority: 85,
    why: '同一个错翻两次车的代价最高；先看别人怎么绕开，比事后补救便宜',
    keywords: ['教训', '踩坑', '事故', '复盘', '别再', '老毛病', '重复犯错', '上次', '之前那次', '翻车', '起不来', '静默失败'],
    docs: [{ path: 'handoff/教训日记/README.md', why: '怎么写教训才搜得到：文件名写现象、正文四段、下次怎么做要可验证' }],
  },
  {
    id: 'self',
    label: '我自己的东西 / 记忆 / 人格',
    tier: 'core',
    priority: 80,
    why: 'self 这一档是我自己：人格卡、记忆卡、日档、日记；写偏一点，人格会慢慢漂',
    keywords: ['记忆', '人格', 'persona', '日档', '日记', '自我', '好感度', '角色', '记忆卡', '我是谁', '时空名', 'characters'],
    docs: [
      { path: 'self/README.md', why: 'self 里有什么：人格卡、日记、日档、备份，插件只扫描不解析' },
      { path: 'self/日档/README.md', why: '日档五段怎么写（触点/我的想/变/我的回/回声）' },
      { path: 'handoff/手册/记忆卡时空来源.md', why: '记忆卡从哪来、写什么' },
    ],
  },
  {
    id: 'files',
    label: '文件存放 / 九档',
    tier: 'frequent',
    priority: 74,
    why: '九档是唯一路面：放错档等于没放，别人找不到',
    keywords: ['文件', '存放', '路径', '九档', '落盘', '软删', '目录'],
    docs: [
      { path: 'handoff/索引/文件目录.md', why: '九档与各区放置规则' },
      { path: 'handoff/手册/信息分层.md', why: '为什么放这一层' },
    ],
  },
  {
    id: 'restart',
    label: '重启 DSH',
    tier: 'occasional',
    priority: 68,
    why: '不常发生，一旦发生是所有时空一起断，所以不能只按频率排',
    keywords: ['重启', '端口', '排程', 'restart', '加载'],
    docs: [{ path: 'handoff/手册/重启.md', why: '只走 restart_dsh + 排程脚本；端口会变' }],
  },
  {
    id: 'logs',
    label: '日志 / 审计 / 清扫',
    tier: 'occasional',
    priority: 62,
    why: '排查问题靠它，平时不用读；读错会拿错证据下结论',
    keywords: ['日志', '审计', '记录', '清扫', '流水', 'history', 'log'],
    docs: [
      { path: 'handoff/索引/文件目录.md', why: 'logs 档放什么：审计、账本、发布日志、清扫报告' },
      { path: 'handoff/手册/信息分层.md', why: '日志属于哪一层、谁能改' },
    ],
  },
  {
    id: 'ledger',
    label: '账本 / 资源',
    tier: 'occasional',
    priority: 56,
    why: '流水账，错了能补；但补之前会拿错数做判断',
    keywords: ['账本', 'strong', '日报', 'token', '额度'],
    docs: [{ path: 'logs/账本/记录规范.md', why: '一行一条、字段与口径' }],
  },
  {
    id: 'created',
    label: 'created / 交付物',
    tier: 'bucket',
    priority: 48,
    why: '做出来的东西放这儿；放错会和交接混在一起，别人分不清哪个是成品',
    keywords: ['交付物', '产物', '生成', '制作', 'created', '成品'],
    docs: [{ path: 'handoff/索引/文件目录.md', why: 'created 放交付物原样；交接只写「东西在哪」' }],
  },
  {
    id: 'incoming',
    label: 'incoming / 外部投递',
    tier: 'bucket',
    priority: 44,
    why: '别人给的东西先进这儿，整理后再分档；混进 handoff 会被当成规矩',
    keywords: ['外部', '投递', '收到', '别人给的', 'incoming', '转发'],
    docs: [{ path: 'handoff/索引/文件目录.md', why: 'incoming 只收外来件，整理后要挪走' }],
  },
  {
    id: 'downloads',
    label: 'downloads / 下载与素材',
    tier: 'bucket',
    priority: 40,
    why: '安装包、压缩包、素材；不清理会吃盘，但删错也能重下',
    keywords: ['下载', '安装包', '压缩包', '素材', 'downloads', 'exe', 'zip'],
    docs: [{ path: 'handoff/索引/文件目录.md', why: 'downloads 放下载物，用完按规则清' }],
  },
  {
    id: 'config',
    label: 'config / 配置',
    tier: 'bucket',
    priority: 36,
    why: '改的是运行中的行为；改错当场生效，比文件放错更危险',
    keywords: ['配置', '设置', 'config', '插件目录', '开关'],
    docs: [{ path: 'handoff/索引/插件目录.md', why: '插件与配置在哪、改之前先看目录' }],
  },
  {
    id: 'scratch',
    label: 'scratch / 试验场',
    tier: 'bucket',
    priority: 30,
    why: '临时试验的东西，随时可删；但别忘了它不是成品，别从这儿直接交付',
    keywords: ['试验', '临时', '草稿', '试一下', 'scratch'],
    docs: [{ path: 'handoff/索引/文件目录.md', why: 'scratch 是试验场：可以乱，但交付物要挪走' }],
  },
  {
    id: 'archive',
    label: 'archive / 回收站与版本',
    tier: 'bucket',
    priority: 26,
    why: '删东西、回滚时才用；平时不读，但找不回来时它是最后一根绳',
    keywords: ['软删', '回收站', '回滚', '历史版本', 'trash', 'versions', 'archive', '恢复'],
    docs: [
      { path: 'handoff/索引/文件目录.md', why: '软删进 trash、版本在 versions；恢复先看这里' },
    ],
  },
]

/** 兜底主题：什么都没看出来时，只给「先看规矩」这一页。 */
const FALLBACK = {
  id: 'general',
  label: '未识别（先看规矩）',
  tier: 'fallback',
  priority: 0,
  why: '看不出主题就别猜；先读一页规矩，再回来把任务说清楚',
  keywords: [],
  docs: [{ path: 'handoff/手册总览.md', why: '不确定主题时只读这一页，再回来调 focus_context 细化' }],
}

/**
 * 动态文档：不在主题表里写死文件名，运行时按目录挑。
 *   - lessons：按任务与《教训日记》文件名/正文的重合度挑，防同一个坑翻两次车；
 *   - self：按日期挑最近两份日档——先看上一个我收在哪，再决定今天写什么。
 */
export const DYNAMIC_DIRS = {
  lessons: { dir: 'handoff/教训日记', max: 3, mode: 'match', minScore: 4, why: '上次同类踩过的坑' },
  self: { dir: 'self/日档', max: 2, mode: 'latest', why: '最近的日档：上一个我收在哪' },
}

/**
 * 中文没有空格，按「两字滑窗」取特征：既能认出「插件」「重启」，也不会
 * 把整句当成一个词。只留汉字/字母数字，标点和空白不参与。
 */
function bigrams(text) {
  const s = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const token of s.split(/[^\p{Script=Han}a-z0-9]+/u)) {
    if (!token) continue
    if (/^[a-z0-9]+$/.test(token)) {
      if (token.length >= 2) out.add(token)
      continue
    }
    for (let i = 0; i < token.length - 1; i += 1) {
      const pair = token.slice(i, i + 2)
      if (/^\p{Script=Han}{2}$/u.test(pair)) out.add(pair)
    }
  }
  return out
}

/** 动态文档解析：按配置读目录、按需打分，返回 [{path, why, topic, terms?}]。 */
async function resolveDynamic(root, topic, { task } = {}) {
  const cfg = DYNAMIC_DIRS[topic.id]
  if (!cfg || !root) return []
  let names
  try {
    names = await fsp.readdir(path.join(root, cfg.dir))
  } catch {
    return []
  }
  const files = names
    .filter((n) => n.toLowerCase().endsWith('.md') && n.toLowerCase() !== 'readme.md')
    .sort()
    .reverse()
  if (files.length === 0) return []

  const base = { topic: topic.id, topicLabel: topic.label }
  if (cfg.mode === 'latest') {
    return files.slice(0, cfg.max).map((name) => ({ ...base, path: `${cfg.dir}/${name}`, why: cfg.why }))
  }

  const terms = [...bigrams(task)]
  if (terms.length === 0) return []
  const scored = []
  for (const name of files) {
    let body = ''
    try {
      body = await fsp.readFile(path.join(root, cfg.dir, name), 'utf8')
    } catch {
      continue
    }
    const nameText = name.toLowerCase()
    const bodyText = body.slice(0, 4000).toLowerCase()
    let nameHits = 0
    let bodyHits = 0
    for (const term of terms) {
      if (nameText.includes(term)) nameHits += 1
      if (bodyText.includes(term)) bodyHits += 1
    }
    const score = nameHits * 2 + Math.min(bodyHits, 8)
    if (score >= cfg.minScore) scored.push({ name, score })
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return scored.slice(0, cfg.max).map(({ name, score }) => ({
    ...base,
    path: `${cfg.dir}/${name}`,
    why: `${cfg.why}（相关度 ${score}）`,
    terms,
  }))
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
    if (score > 0)
      scored.push({
        id: topic.id,
        label: topic.label,
        tier: topic.tier,
        priority: topic.priority,
        score,
        hits,
      })
  }
  // 同分时按 priority 定先后（再同就按 id，保证结果可复现）。
  return scored.sort((a, b) => b.score - a.score || b.priority - a.priority || a.id.localeCompare(b.id))
}

/** 取相关文档（去重、保序）；动态文档在 routeFocus 里按任务补。 */
export async function collectDocs(topics, { root, task } = {}) {
  const picked = topics.length > 0 ? topics : [FALLBACK]
  const seen = new Set()
  const out = []
  for (const t of picked) {
    const def = topicById(t.id)
    for (const doc of def.docs) {
      if (seen.has(doc.path)) continue
      seen.add(doc.path)
      out.push({ ...doc, topic: def.id, topicLabel: def.label })
    }
    if (DYNAMIC_DIRS[def.id]) {
      for (const doc of await resolveDynamic(root, def, { task })) {
        if (seen.has(doc.path)) continue
        seen.add(doc.path)
        out.push(doc)
      }
    }
  }
  return out
}

/** 文档摘要：是否存在、多大、相关小节（标题行）与命中行（教训日记用）。读不到就如实说。 */
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

  // 项目白板这类长文档：小节标题本身就是导航（当前一棒/挂账），
  // 别因为标题里没有主题词就丢掉——直接按名字把行号指出来（0.5.26）。
  const wanted = Array.isArray(doc.sections) ? doc.sections : []
  if (wanted.length > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^##\s+(.+?)\s*$/)
      if (!m) continue
      const title = m[1].replace(/\s*[（(].*$/, '').trim()
      if (!wanted.some((w) => title === w || title.includes(w))) continue
      if (info.headings.some((h) => h.line === i + 1)) continue
      info.headings.push({ line: i + 1, text: m[1].trim() })
    }
  }

  // 教训日记：把「这次可能踩到」的原文行直接指出来，省得它从头读到尾。
  const terms = Array.isArray(doc.terms) ? doc.terms : []
  if (terms.length > 0) {
    const matched = []
    for (let i = 0; i < lines.length && matched.length < 3; i += 1) {
      const low = lines[i].toLowerCase()
      if (!low.trim()) continue
      if (terms.some((t) => low.includes(t))) {
        matched.push({ line: i + 1, text: lines[i].trim().slice(0, 160) })
      }
    }
    if (matched.length > 0) info.matched = matched
  }
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
  const docs = await collectDocs(topics, { root, task })

  // 项目白板：调用方点名了项目（或任务里出现了项目 id），就把那一页带上——
  // 当前一棒是「这个项目现在该干什么」的第一手来源，不该等人自己去找（0.5.26）。
  // 只读指定项目这一页，不把 projects 目录整个推出去。
  if (root && project) {
    const rel = `handoff/projects/${String(project).trim()}.md`
    if (!docs.some((d) => d.path === rel)) {
      try {
        const st = await fsp.stat(path.join(root, rel))
        if (st.isFile()) {
          docs.push({
            path: rel,
            why: `项目 ${project} 的白板：当前一棒 / 挂账看 headings 的行号`,
            topic: 'handoff',
            sections: ['当前一棒', '挂账', '⚠ 挂账'],
          })
        }
      } catch {
        /* 项目没有白板就不带 */
      }
    }
  }

  // 教训预读：这次没提「教训」，也按任务找一遍同类的坑——
  // 防重复犯错靠的是「做这件事时顺手推」，不是等人想起来去搜。
  let autoLessons = 0
  if (root && !topics.some((t) => t.id === 'lessons')) {
    const lessons = topicById('lessons')
    const extra = await resolveDynamic(root, lessons, { task })
    for (const doc of extra) {
      if (docs.some((d) => d.path === doc.path)) continue
      docs.push({ ...doc, auto: true })
      autoLessons += 1
    }
    if (autoLessons > 0) {
      topics.push({
        id: 'lessons',
        label: '教训日记（自动预读）',
        tier: 'core',
        priority: lessons.priority,
        score: 0,
        hits: [],
        auto: true,
      })
    }
  }

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
      ...(d.matched ? { matched: d.matched } : {}),
      ...(d.auto ? { auto: true } : {}),
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
        ? `只读 read 里列出的文件（优先 headings 指的小节${autoLessons > 0 ? '；教训日记先看 matched 那几行和「下次怎么做」' : ''}）；requests 之外的请求先放着，等任务相关了再看。`
        : '没看出主题：只读兜底那一页；任务说清楚一点再调一次。',
  }
}

/**
 * 目录表：现在有几大类、各自序位、各自几页文档。按 priority 从高到低，兜底永远最后。
 * 和 `validateTopics()` 一起，构成「加主题之前先看一眼」的入口。
 */
export function topicTable(list = TOPICS) {
  return [...list, FALLBACK]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map((t) => ({
      id: t.id,
      label: t.label,
      tier: t.tier,
      tierLabel: TIER_LABEL[t.tier] ?? t.tier,
      priority: t.priority,
      why: t.why ?? '',
      keywords: (t.keywords ?? []).length,
      docs: (t.docs ?? []).length,
      dynamic: Boolean(DYNAMIC_DIRS[t.id]),
    }))
}

/**
 * 自检：加主题、改文档之前先跑它（冒烟里也跑一遍）。
 * 拦的是「写坏」：id 重复、priority 重复或越界、tier 不认识、缺关键词、
 * 文档缺 path/why、动态目录配错。
 * 只警告不拦的是「路径看着不像九档」——交给写的人判断。
 *
 * @returns {{ok: boolean, schemaVersion: number, errors: string[], warnings: string[]}}
 */
export function validateTopics(list = TOPICS) {
  const errors = []
  const warnings = []
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, schemaVersion: TOPIC_SCHEMA_VERSION, errors: ['主题表必须是数组且非空'], warnings }
  }
  const ids = new Set()
  const priorities = new Set()
  const bucketRe = /^(handoff|logs|self|created|downloads|incoming|scratch|archive|config)\//
  for (const [i, t] of list.entries()) {
    const at = `#${i}`
    if (!t || typeof t !== 'object') {
      errors.push(`${at} 不是对象`)
      continue
    }
    const name = t.id ?? '?'
    if (!t.id || typeof t.id !== 'string') errors.push(`${at} 缺 id`)
    else if (ids.has(t.id)) errors.push(`id 重复：${t.id}`)
    else ids.add(t.id)
    if (!t.label || typeof t.label !== 'string') errors.push(`${at}(${name}) 缺 label`)
    if (!TIER_LABEL[t.tier]) errors.push(`${at}(${name}) tier 不认识：${t.tier}`)
    if (!Number.isInteger(t.priority) || t.priority < 0 || t.priority > 100) {
      errors.push(`${at}(${name}) priority 必须是 0-100 的整数`)
    } else if (priorities.has(t.priority)) {
      errors.push(`priority 重复：${t.priority}（同分排不出先后）`)
    } else {
      priorities.add(t.priority)
    }
    if (!Array.isArray(t.keywords) || t.keywords.length === 0) errors.push(`${at}(${name}) 至少给一个关键词`)
    const dynamic = DYNAMIC_DIRS[t.id]
    if (!Array.isArray(t.docs) || t.docs.length === 0) {
      if (!dynamic) errors.push(`${at}(${name}) 至少给一页文档（或配一条动态文档）`)
    } else {
      for (const [j, d] of t.docs.entries()) {
        if (!d || typeof d.path !== 'string' || !d.path) errors.push(`${at}.docs#${j} 缺 path`)
        else if (!bucketRe.test(d.path)) warnings.push(`${at}.docs#${j} 路径不在九档已知区：${d.path}`)
        if (!d || typeof d.why !== 'string' || !d.why) errors.push(`${at}.docs#${j}(${d?.path ?? '?'}) 缺 why`)
      }
    }
  }
  for (const [id, cfg] of Object.entries(DYNAMIC_DIRS)) {
    if (!list.some((t) => t.id === id)) errors.push(`动态文档挂在未知主题上：${id}`)
    if (!cfg || typeof cfg.dir !== 'string' || !bucketRe.test(cfg.dir)) errors.push(`动态目录 ${id} 不在九档已知区`)
    if (!Number.isInteger(cfg.max) || cfg.max < 1 || cfg.max > 5) errors.push(`动态目录 ${id} 的 max 必须是 1-5`)
    if (!['latest', 'match'].includes(cfg.mode)) errors.push(`动态目录 ${id} 的 mode 只能是 latest/match`)
  }
  return { ok: errors.length === 0, schemaVersion: TOPIC_SCHEMA_VERSION, errors, warnings }
}

/** 按 id 取主题；认不出来返回 null（给未来「主题继承 / 别名」留的入口）。 */
export function topicById(id, list = TOPICS) {
  return list.find((t) => t.id === id) ?? (id === FALLBACK.id ? FALLBACK : null)
}

/** 给开场注用的一行索引：按 priority 排，让人知道先看哪类，不用背主题表。 */
export function topicIndexLine() {
  return [...TOPICS]
    .sort((a, b) => b.priority - a.priority)
    .map((t) => `${t.id}→${t.label}`)
    .join('；')
}
