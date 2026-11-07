/**
 * 三层信息（0.5.0）：手册版 / 动态白板 / 总目录。
 *
 * 为什么分三层：一个时空刚醒来要回答三个问题——
 *   ① 有什么规矩不能破？（手册版：重启、交接、存放、隐私……定死的）
 *   ② 现在谁在干什么、哪件事该先修？（动态白板：在办项目的一棒、挂账、未接请求）
 *   ③ 东西都在哪？（总目录 README + 索引四页）
 * 以前只有第三层，前两层散在白板与规范文件里，新时空要么漏读、要么读到过期的。
 *
 * 这三页都由插件生成，别手改：改规矩改 `handoff/手册/*.md`，改进度用 project_upsert。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { listProjects, readProject, PRIORITY_ORDER } from './projects.js'
import { readInbox, mergeInbox, filterInbox } from './inbox.js'
import { pendingBroadcastSync, describeBroadcast, bjTime } from './restart.js'
import { writeFileAtomic } from './atomic.js'

export const NORMS_DIR_REL = 'handoff/手册'
export const NORMS_FILE = 'handoff/手册总览.md'
export const DYNAMIC_FILE = 'handoff/动态白板.md'

/** 钉在手册总览最上面的契约（新时空第一眼必须看到「插件怎么接进来」）。 */
export const PINNED_NORMS = ['插件的自我管理.md']

const MAX_UNCLAIMED = 6
const MAX_ISSUES_PER_PROJECT = 3

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 北京时间 `YYYY-MM-DD HH:mm`。 */
function bjMinute(ms) {
  const d = new Date(Number(ms) || Date.now())
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
}

/** 从一篇规范里抽一句话：优先 `> 一句话：…`，其次 `>` 引用首行，最后第一段正文。 */
function gistOf(text) {
  const quoted = String(text).match(/^>\s*(.+)$/gm) ?? []
  for (const line of quoted) {
    const body = line.replace(/^>\s*/, '').trim()
    const m = body.match(/^(?:一句话|用途|干什么)[:：]\s*(.+)$/)
    if (m) return m[1].trim()
  }
  if (quoted.length > 0) {
    const first = quoted[0].replace(/^>\s*/, '').trim()
    if (first && !/^生成|^本页|^自动/.test(first)) return first
  }
  const lines = String(text).split(/\r?\n/)
  let inCode = false
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode || !t || t.startsWith('#') || t.startsWith('>') || t.startsWith('|') || t.startsWith('-') || t.startsWith('*')) continue
    return t.length > 90 ? `${t.slice(0, 88)}…` : t
  }
  return ''
}

/** 手册目录里的文件（同步，给开场注入数数用）。 */
export function normsCountSync(ctx) {
  try {
    return readdirSync(path.join(ctx.root, NORMS_DIR_REL)).filter((n) => n.endsWith('.md')).length
  } catch {
    return 0
  }
}

/** 手册版：扫 handoff/手册/*.md，一页顶住所有规矩。 */
export async function renderNormsPage(ctx) {
  const dir = path.join(ctx.root, NORMS_DIR_REL)
  let names = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md'))
  } catch {
    names = []
  }
  const rows = []
  for (const name of names.sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    const file = path.join(dir, name)
    let text = ''
    let mtime = 0
    try {
      text = await readFile(file, 'utf8')
      mtime = (await stat(file)).mtimeMs
    } catch {
      continue
    }
    const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? name.replace(/\.md$/, '')).trim()
    rows.push({ name, title, gist: gistOf(text), mtime })
  }

  const lines = [
    '# 手册总览 · 定死的规矩（第一层）',
    '',
    '> 一句话：三层信息按重要程度排——**① 手册（本页）→ ② 动态白板（handoff/动态白板.md）→ ③ 总目录（handoff/README.md）**。',
    '> 本页由插件扫描 `handoff/手册/*.md` 生成，别手改；要加/改规矩改那份文件本身，写清「为什么」。',
    `> 生成时间：${bjMinute(Date.now())}（北京时间） · 共 ${rows.length} 条`,
    '',
    '## 先读哪一块（权重写死，读序不许倒）',
    '',
    '| 权重 | 板块 | 文件 | 什么时候看 |',
    '| --- | --- | --- | --- |',
    `| **100** | ① 规矩 | \`${NORMS_FILE}\`（本页） | 开工第一件事。没读它之前不要打开 ②③，也别先翻 README / 项目总览 / 项目白板 |`,
    `| **90** | ② 现在 | \`${DYNAMIC_FILE}\` | 想知道谁在干什么、哪件事先修、哪些请求没人接、有没有全时空重启 |`,
    '| **80** | ③ 目录 | `handoff/README.md` | 要找东西、找旧交接、看文件放哪、看还有哪些项目 |',
    '',
    '> 为什么这么排：规矩决定「能不能这么干」，现在决定「我该干哪一件」，目录只是「东西在哪」。',
    '> 04:40 那次新时空实测就是顺序倒了——先读了动态白板和目录、规矩一个字没读，后面全在被规矩牵着走。',
    '',
    '## 接入契约（所有做插件的时空必读，排在规矩最前）',
    '',
    '用大白话说：每个插件先交一张名片 `organ.json`，再接四个插头——',
    '**头（别人能看你，只看不碰）· 手（你能替人动手，会留痕，所以要先过一道门）· 脚（你干过的事留脚印，别人能顺着查）· 心（你还活着吗，看一个会定时刷新的文件）**。',
    '**头和脚是硬要求，加起来至少三个插头**；少一个，`organ_list` 会点名、`scripts/check-organs.mjs` 会报警。',
    '**手是大家共用的那一双**：插件不各写一只手，只在名片上写「我会用这只手做这几件事」；真正动手时走同一条公共通路（写文件 / 跑命令 / 发请求），先过护城河的门，门批了才落到手上，动手前先在 `logs/organs-exec.jsonl` 留一行、做完再记结果（0.5.8 接上）。',
    '现在五个器官里，登记了「手」的是 `surfcore`（`surfcore.chat.send` / `surfcore.bili.open`）和书同文自己（`tongwen.note.append`）；`dsh-blackhole` / `dsh-self-persona` / `safeprotocol` 只有「头+脚+心」。',
    '**手是真按过的**（2026-11-06 07:10）：派单 → 门 allow → 真发一条 QQ 成功；07:15 又拿一颗没进白名单的假炸弹试门，拿回 `GATE_DENIED`、假炸弹一下都没炸——只验放行不算验过门。',
    `细则、术语和现状表：\`${NORMS_DIR_REL}/插件的自我管理.md\`（开头就是大白话版）——做插件前先读这一页，收工前跑一次自查四条。`,
    '',
    '## 开工前先定位（0.5.28）',
    '',
    `别把 ${rows.length} 页一起读完。先想清楚「这次要做什么」，调 \`focus_context{task:"..."}\`，它会按任务给：`,
    '**该读哪几页**（含 3 个小节）、**哪些请求跟你有关**（打分带理由）、**其它先放着**。',
    `主题和文档的对照写死在 \`lib/relevance.js\` 的 \`TOPICS\`；规矩本身见 \`${NORMS_DIR_REL}/相关性路由.md\`。`,
    '宁可漏、不乱推：拿不准就退回手册总览，而不是把不相干的页一股脑塞给人。',
    '',
    '> 规矩要写大白话：任何一页手册，开头先用人话讲清楚，别一上来就是字段名（主人 2026-11-06 05:53 要求，见 `handoff/手册/信息分层.md` 第十三节）。',
    '',
  ]

  if (rows.length === 0) {
    lines.push('（还没有手册文件。把规矩写进 `handoff/手册/<名字>.md`，插件下次刷新会收进来。）', '')
  } else {
    // 接入契约钉在最前：新时空第一眼就看到「插件怎么接进来」。
    const pinned = rows.filter((r) => PINNED_NORMS.includes(r.name))
    const rest = rows.filter((r) => !PINNED_NORMS.includes(r.name))
    const ordered = [...pinned, ...rest]
    lines.push('## 规矩清单', '', '| 规矩 | 一句话 | 文件 | 最近改 |', '| --- | --- | --- | --- |')
    for (const r of ordered) {
      const gist = r.gist ? r.gist.replace(/\|/g, '\\|') : ''
      const star = PINNED_NORMS.includes(r.name) ? '⭐ ' : ''
      lines.push(`| ${star}**${r.title.replace(/\|/g, '\\|')}** | ${gist} | \`${NORMS_DIR_REL}/${r.name}\` | ${r.mtime ? bjMinute(r.mtime) : '—'} |`)
    }
    lines.push('')
  }

  lines.push(
    '## 怎么用',
    '',
    '- 开工前**只读跟这次任务有关的那几条**（重启 / 交接 / 存放 / 隐私 / 账本…），别整页背。',
    '- 规矩和现实冲突时：先按规矩做；觉得规矩错了，改手册文件并写清为什么，再在交接里记一笔。',
    '- 没有规矩覆盖的新情况：先问用户，别自己造一条然后当规矩用。',
    '',
  )
  return lines.join('\n')
}

/** 动态白板：现在谁在干什么 + 挂账 + 未接请求 + 重启广播。 */
export async function renderDynamicPage(ctx) {
  const now = Date.now()
  const projects = (await listProjects(ctx.projectsDir).catch(() => []))
    .filter((p) => p.status !== 'done' && !p.archived)
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 9
      const pb = PRIORITY_ORDER[b.priority] ?? 9
      if (pa !== pb) return pa - pb
      return String(b.updated).localeCompare(String(a.updated))
    })

  let inboxOpen = []
  try {
    const items = mergeInbox(await readInbox(ctx.inboxFile))
    inboxOpen = filterInbox(items, { status: 'open' }).filter((i) => i.to === 'any' || i.to === null || i.to === undefined)
  } catch {
    inboxOpen = []
  }

  const broadcast = pendingBroadcastSync(ctx, now)

  const issues = []
  for (const p of projects) {
    for (const issue of Array.isArray(p.issues) ? p.issues : []) {
      issues.push({ project: p.id, priority: p.priority ?? 'P2', text: String(issue.text ?? issue) })
    }
  }

  const lines = [
    '# 动态白板 · 现在谁在干什么（第二层）',
    '',
    '> 一句话：这一页只答「现在」——哪些项目在办、各自的一棒是什么、哪些坑挂着、哪些请求没人接、有没有全时空重启。',
    '> 历史与细节在项目白板 `handoff/projects/<id>.md`；本页是插件按白板 + 信箱 + 重启广播生成的，别手改。',
    `> 生成时间：${bjMinute(now)}（北京时间） · 在办项目 ${projects.length} 个 · 挂账 ${issues.length} 条`,
    '',
  ]

  if (broadcast) {
    lines.push('## ⏰ 重启广播（先看这条）', '', `- ${describeBroadcast(broadcast, now)}`, '')
  }

  if (issues.length > 0) {
    lines.push(`## ⚠ 挂账（${issues.length}）· 没解决的坑，先看这段`, '')
    for (const it of issues.slice(0, 10)) {
      lines.push(`- **${it.priority} · ${it.project}** — ${it.text}`)
    }
    lines.push('')
  }

  const groups = ['P0', 'P1', 'P2', 'P3']
  const label = { P0: 'P0 立刻做', P1: 'P1 本周', P2: 'P2 有空', P3: 'P3 以后' }
  for (const g of groups) {
    const list = projects.filter((p) => (p.priority ?? 'P2') === g)
    if (list.length === 0) continue
    lines.push(`## ${label[g]}（${list.length}）`, '')
    for (const p of list) {
      // listProjects 把「当前一棒」拆成两个字段：baton（给谁，字符串）+ batonAction（做什么）
      const rawBaton = p.baton
      const to = (typeof rawBaton === 'string' ? rawBaton : rawBaton?.to) || 'any'
      const action = p.batonAction || rawBaton?.action || '（没写当前一棒）'
      lines.push(`- **${p.id}**${p.title ? ` · ${p.title}` : ''} → 给 **${to}**：${action}`)
      const list3 = (Array.isArray(p.issues) ? p.issues : []).slice(0, MAX_ISSUES_PER_PROJECT)
      if (list3.length > 0) {
        lines.push(`  - 挂账：${list3.map((i) => String(i.text ?? i)).join('；')}`)
      }
    }
    lines.push('')
  }

  if (inboxOpen.length > 0) {
    lines.push(`## 没接的请求（${inboxOpen.length} 条 · 口径：to 是 any/null 且没关）`, '')
    for (const item of inboxOpen.slice(0, MAX_UNCLAIMED)) {
      const who = item.from ? `来自 ${item.from}` : '来自未知'
      const proj = item.project ? ` · ${item.project}` : ''
      lines.push(`- ${who}${proj}：${String(item.request ?? '').replace(/\s+/g, ' ').slice(0, 100)}（\`${item.id}\`）`)
    }
    lines.push('')
  }

  lines.push(
    '## 怎么用',
    '',
    '- 认领：先看 P0 里跟你相关的；`给 xx` 写了会话 id 或 `any`（any = 谁都能接）。',
    '- 开工/推进/收工都用 `project_upsert` 改「当前一棒」；别直接编辑本页。',
    '- 挂账修好了用 `project_upsert` 的 `resolve_issue`（关键字命中即撤），别手动删。',
    '',
  )
  return lines.join('\n')
}

/** 写完总目录之后顺手把另两层也刷新（失败只记 note，不拖垮总目录）。 */
export async function writeLayers(ctx) {
  const problems = []
  try {
    const norms = await renderNormsPage(ctx)
    await writeFileAtomic(path.join(ctx.root, NORMS_FILE), norms)
  } catch (error) {
    problems.push(`手册总览：${error?.message ?? error}`)
  }
  try {
    const dynamic = await renderDynamicPage(ctx)
    await writeFileAtomic(path.join(ctx.root, DYNAMIC_FILE), dynamic)
  } catch (error) {
    problems.push(`动态白板：${error?.message ?? error}`)
  }
  return problems
}
