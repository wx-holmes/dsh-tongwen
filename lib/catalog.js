/**
 * handoff/README.md —— 交接总目录（人读的第一页）。
 *
 * 顺序按权重（2026-11-06 v3，0.5.2）：一·在办 100 / 二·清单 90 / 三·文件 80 /
 * 四·插件 70 / 五·工具 60 / 六·A盘 50 / 七·已归档 10。
 * 为什么把「在办」提到第一：新时空最先要知道的是「我现在该接哪件事、上一棒到哪了」，
 * 「东西放哪」是被派到具体活之后才需要的。v2 的旧顺序是 文件/插件/工具/A盘 在前。
 * 这一页只放「位置 + 一句话」；细则在 handoff/索引/ 六页里（那六页是手写的，插件不覆盖：
 * 文件 / 插件 / 工具 / A盘 / 交接 / 教训）。
 *
 * 插件在启动与每次归档后刷新；要改这一页的说明，改本文件的生成逻辑。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.js'
import { listProjects, readBaton, readProject, PRIORITY_ORDER } from './projects.js'
import { writeLayers, NORMS_FILE, DYNAMIC_FILE } from './layers.js'

const MAX_ROWS = 20
const USAGE_SCAN_FILES = 30

/** 排行榜候选：总目录里真正会被点开的东西。 */
const USAGE_CANDIDATES = [
  'handoff/索引/文件目录.md',
  'handoff/索引/插件目录.md',
  'handoff/索引/工具目录.md',
  'handoff/索引/A盘目录.md',
  'handoff/索引/教训索引.md',
  'handoff/手册/交接规范.md',
  'handoff/能力目录.md',
  'handoff/plugins/README.md',
  'handoff/任务交接本/当前状态.md',
  'logs/账本/README.md',
  'logs/账本/记录规范.md',
  'handoff/时间交接/',
]

/** A 盘目录最近一次扫描（由 disk-scan 脚本 写 logs/disk-scan/last-scan.json）。 */
async function aDriveScanLine(ctx) {
  try {
    const file = `${ctx.root}/logs/disk-scan/last-scan.json`
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (!data?.generatedAt) return null
    const gb = (data.totalBytes / 1024 ** 3).toFixed(1)
    return `- 最近扫描：${data.generatedAt} —— ${(data.dirs ?? []).length} 个目录 / ${gb} GB / ${(data.totalFiles ?? 0).toLocaleString('en-US')} 个文件（脚本 \`disk-scan 脚本\`，计划任务 tongwen-disk-scan）`
  } catch {
    return null
  }
}


/** 使用排行：最近 30 份机器版交接里，哪些文件被提到得最多（谁常用谁排前面）。 */
async function usageRanking(ctx) {
  const machineDir = path.join(ctx.root, 'handoff', 'machine')
  let dates = []
  try {
    dates = (await readdir(machineDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 6)
  } catch {
    return []
  }
  const files = []
  for (const date of dates) {
    const dir = path.join(machineDir, date)
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const full = path.join(dir, name)
      try {
        const info = await stat(full)
        files.push({ full, mtime: info.mtimeMs })
      } catch {
        /* 忽略单个文件 */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const picked = files.slice(0, USAGE_SCAN_FILES)
  let text = ''
  for (const file of picked) {
    try {
      text += await readFile(file.full, 'utf8')
    } catch {
      /* 忽略 */
    }
  }
  const counted = USAGE_CANDIDATES.map((candidate) => {
    const hits = text.split(candidate).length - 1
    return { candidate, hits }
  })
    .filter((row) => row.hits > 0)
    .sort((a, b) => b.hits - a.hits)
  return counted.slice(0, 8)
}
export const BUCKET_LINES = [
  ['handoff', '交接与项目白板（这一页说的都在这）'],
  ['created', '产出的成品文件'],
  ['downloads', '从网上下载的东西'],
  ['incoming', '别人/别的会话送进来的东西'],
  ['scratch', '临时草稿（真删要先问人）'],
  ['archive', '回收站与版本备份（trash / versions）'],
  ['logs', '日志、审计、验收记录'],
  ['config', '配置与安装器写的东西'],
  ['self', '关于我自己的抽屉：persona、记忆、日记与自我记录（不是给用户看的报告；给你的报告在 handoff/user/）'],
]

/** 放置规则：完整表在 handoff/索引/文件目录.md；这里只留一份供程序/测试引用。 */
export const PLACEMENT_ROWS = [
  ['机器版交接', 'handoff/machine/<日期>/<实例>.machine.md', 'end_task 自动'],
  ['用户版交接', 'handoff/user/<日期>/<实例>.user.md', 'end_task 自动'],
  ['教训 / 踩过的坑', 'handoff/教训日记/<日期>-<主题>.md', '手写（只追加）'],
  ['教训索引（一行一条）', 'handoff/索引/教训索引.md', '手写；新写教训顺手加一行'],
  ['插件现状卡', 'handoff/plugins/<插件名>/README.md', '手写（入口/版本/坑）'],
  ['这台电脑现在什么样', 'handoff/任务交接本/当前状态.md', '手写（覆盖更新）'],
  ['跨会话项目', 'handoff/projects/<项目id>.md', 'project_upsert'],
  ['已完成的项目', 'handoff/projects/done/<项目id>.md', 'project_upsert（status=done 自动移入）'],
  ['会话变更日记', 'handoff/self/journals/<时间>.md', '自动'],
  ['能力目录（会什么技能）', 'handoff/能力目录.md', '能力目录脚本 生成'],
  ['过期文件清扫报告', 'logs/清扫报告.md', '插件每周生成（housekeeping_report 可立刻重扫），只报告不删'],
  ['交接规范（怎么写/放哪）', 'handoff/手册/交接规范.md', '手写；模板在 handoff/手册/模板/'],
  ['重启 DSH 的正确姿势', 'handoff/手册/重启.md', '必读：只走 外部重启脚本（safety-kit/bin/restart-dsh-later.ps1），先说再排 30 秒'],
  ['上传仓库前的隐私清洗', 'handoff/手册/上传仓库前的隐私清洗.md', '必读：活目录有 pre-push 保险丝，公开仓库只从 scratch/publish 副本推'],
  ['账本记录（一行一条）', 'logs/账本/data/records.jsonl', 'ledger 工具的 record.mjs 追加'],
  ['时间交接（多时空接力）', 'handoff/时间交接/<项目id>/', '按协议写'],
  ['日档（每天一份）', 'self/日档/<日期>-<时空名>.md', '每个时空收尾手写（聊天类时空写 self/diary/ 日记）'],
  ['未闭环请求', 'handoff/inbox.jsonl', 'inbox_send'],
  ['交接索引（机器读）', 'handoff/index.machine.json', '自动'],
]

/** 索引页（手写，插件只链不覆盖）。 */
const INDEX_PAGES = [
  ['文件目录', 'handoff/索引/文件目录.md', '九档、handoff 各区、self 档、关键路径、写入规矩'],
  ['插件目录', 'handoff/索引/插件目录.md', '装了什么插件、在哪、怎么加载、改动规矩'],
  ['工具目录', 'handoff/索引/工具目录.md', '运行时、抓页面、站点、本机脚本、踩过的坑'],
  ['A盘目录', 'handoff/索引/A盘目录.md', 'A 盘 17 个目录的大小/用途/能不能动'],
  ['教训索引', 'handoff/索引/教训索引.md', '一行一条：日期 / 主题 / 一句话 / 路径'],
  ['交接索引', 'handoff/索引/交接索引.md', '全量交接一览：时间 / 内容总结 / 状态 / 路径（文件名即总结）'],
]

/**
 * 扫 handoff/machine（不含 archive），按文件名里的时间倒序，给总目录用。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {number} [limit]
 * @returns {Promise<Array<{date: string, hm: string, summary: string, rel: string}>>}
 */
async function listHandoffFiles(ctx, limit = MAX_ROWS) {
  const base = path.join(ctx.root, 'handoff', 'machine')
  const out = []
  async function walk(dir) {
    let items = []
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of items) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name !== 'archive') await walk(p)
        continue
      }
      if (!ent.name.endsWith('.machine.md')) continue
      const m = ent.name.match(/^(\d{4}-\d{2}-\d{2})-(\d{4})-(.+)\.machine\.md$/)
      if (m) {
        out.push({
          date: m[1],
          hm: m[2],
          summary: m[3],
          rel: path.relative(ctx.root, p).split(path.sep).join('/'),
        })
        continue
      }
      // 0.4.4：旧命名（如 release-0-3-23.machine.md）也别漏——按文件时间补日期/时分，
      // 文件名去掉后缀当总结。索引要的是「一份不少」，不是「格式漂亮」。
      let when = null
      try {
        when = (await stat(p)).mtime
      } catch {
        when = null
      }
      if (!when) continue
      const bj = new Date(when.getTime() + 8 * 3600 * 1000).toISOString()
      out.push({
        date: bj.slice(0, 10),
        hm: `${bj.slice(11, 13)}${bj.slice(14, 16)}`,
        summary: `${ent.name.replace(/\.machine\.md$/, '')}（旧命名，时间取文件修改时间）`,
        rel: path.relative(ctx.root, p).split(path.sep).join('/'),
      })
    }
  }
  await walk(base)
  // 0.4.8：同一份交接常常有「新命名 + 旧命名」两份文件（迁移期留下的），
  // 不去重就会在总目录、交接索引里各出现两次，看起来像两份不同的交接。
  // 去重口径：同一天 + 同主题只留一份，优先新命名（文件名里带日期-时分）。
  const OLD_SUFFIX = /（旧命名，时间取文件修改时间）$/
  const deduped = new Map()
  for (const item of out) {
    const key = `${item.date}|${item.summary.replace(OLD_SUFFIX, '').replace(/\s+/g, ' ').trim()}`
    const isCanonical = !OLD_SUFFIX.test(item.summary)
    const prev = deduped.get(key)
    if (!prev || (isCanonical && OLD_SUFFIX.test(prev.summary))) deduped.set(key, item)
  }
  const list = [...deduped.values()]
  list.sort((a, b) => (b.date + b.hm).localeCompare(a.date + a.hm))
  return list.slice(0, limit)
}

/**
 * 生成总目录的文本。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {object} index
 * @returns {Promise<string>}
 */
export async function renderCatalog(ctx, index) {
  // 挂账放最前面：新会话第一眼就该知道哪儿在漏，别等踩到才想起来。
  // 必须先算出来，顶部权重行和下面小节用的是同一个数字（0.4.4 修：之前顶部写死 0）。
  let openIssues = []
  try {
    const all = await listProjects(ctx.projectsDir)
    for (const p of all) {
      if (p.status === 'done') continue
      const r = await readProject(ctx.projectsDir, p.id)
      for (const issue of r?.model?.issues ?? []) {
        openIssues.push({ project: p.title || p.id, id: p.id, text: issue })
      }
    }
  } catch {
    openIssues = []
  }

  const lines = []
  lines.push('# 交接总目录（第三层：找东西）')
  lines.push('')
  // 0.5.0 三层：规矩 → 动态 → 目录。谁来都得先知道「有什么不能破」和「现在在干什么」。
  lines.push('> **三层信息，按重要程度读**：① 规矩 `' + NORMS_FILE + '` → ② 现在 `' + DYNAMIC_FILE + '` → ③ 本页（目录）。')
  lines.push(`> 按权重排：**⚠ 挂账（${openIssues.length}）→ 一·在办 100 → 二·清单 90 → 三·文件 80 → 四·插件 70 → 五·工具 60 → 六·A盘 50 → 七·已归档 10**。`)
  lines.push('> 新时空先看「一 · 在办」认领活，再往下找东西；只想看现在发生什么，看 `handoff/动态白板.md`。')
  lines.push('> 新会话只先读这一页；被派到哪个交接，才去读哪个文件——**别把全部交接读完**。')
  lines.push('')
  lines.push(`## ⚠ 挂账（${openIssues.length}）· 没解决的坑，先看这段`)
  lines.push('')
  if (!openIssues.length) {
    lines.push('- 没有挂账。')
  } else {
    for (const it of openIssues.slice(0, 10)) lines.push(`- **${it.project}**：${it.text}`)
    if (openIssues.length > 10) lines.push(`- ……还有 ${openIssues.length - 10} 条，见 \`handoff/项目总览.md\``)
    lines.push('')
    lines.push('- 修好一条就 `project_upsert` 传 `resolve_issue` 撤掉；别让坑一直躺着。')
  }
  lines.push('')

  // 0.5.2：权重重排（你开新时空要能一眼看出「我现在该接哪件事」）。
  // 新顺序：挂账 → 在办 → 清单 → 文件 → 插件 → 工具 → A盘 → 已归档。
  // 理由：新时空最先要的是「有什么活、上一棒到哪了」，其次才是「东西放哪」。
  let projects = []
  try {
    projects = await listProjects(ctx.projectsDir)
  } catch {
    projects = []
  }
  const priorityOf = (project) => PRIORITY_ORDER[project.priority] ?? 9
  const active = projects
    .filter((item) => item.status !== 'done' && !item.archived)
    .sort(
      (a, b) =>
        priorityOf(a) - priorityOf(b) || String(b.updated).localeCompare(String(a.updated)),
    )

  lines.push('## 一 · 在办（100）· 当前一棒')
  lines.push('')
  lines.push('> 按优先级排：**P0 立刻做 · P1 本周 · P2 有空 · P3 以后**。做完的不会出现在这里（在「七 · 已归档」）。')
  lines.push('> 活干到哪、最近加了什么：看 `handoff/项目总览.md`（第二张对齐图）。')
  lines.push('')
  if (active.length === 0) {
    lines.push('（暂无进行中的项目）')
  } else {
    // 0.4.5：每个项目挂上「当前交接」——新时空认领项目后，只看那一份就够。
    const allEntries = entriesOf(index)
    for (const project of active) {
      const baton = await readBaton(ctx.projectsDir, project.id).catch(() => null)
      const action = baton?.action || '（还没排下一棒）'
      const to = baton?.to || 'any'
      lines.push(
        `- **[${project.priority ?? 'P2'}] ${project.title || project.id}**（\`${project.id}\`）→ 交给 \`${to}\`：${action}`,
      )
      const picked = latestHandoffFor(allEntries, project.id)
      if (picked) {
        const mark = picked.archived ? '（已归档）' : ''
        lines.push(
          `  - 当前交接${mark}：\`${picked.entry.machineHandoff}\` —— ${shorten(picked.entry.displayName ?? '', 30)}（${whenText(picked.entry.lastUpdated)}）`,
        )
      } else {
        lines.push('  - 当前交接：（这个项目还没有挂项目的交接；历史按内容在「二 · 清单」里找）')
      }
    }
  }
  lines.push('')

  lines.push('## 二 · 清单（90）· 最近交接')
  lines.push('')
  lines.push('查旧交接先扫 `handoff/索引/交接索引.md`（全量、按时间倒序，文件名就是内容总结）；下面是最近的：')
  lines.push('')
  const handoffFiles = await listHandoffFiles(ctx)
  if (handoffFiles.length === 0) {
    lines.push('（还没有交接）')
  } else {
    const entryByPath = new Map()
    for (const entry of entriesOf(index)) {
      if (entry.machineHandoff) entryByPath.set(entry.machineHandoff, entry)
    }
    lines.push('| 时间 | 内容总结 | 项目 | 状态 | 路径 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const file of handoffFiles) {
      const entry = entryByPath.get(file.rel)
      // 0.5.3：旧命名副本没进索引时，以前一律算「在办」，看上去像还有活没接完（幽灵条目）。
      const oldDup = !entry && /（旧命名，时间取文件修改时间）$/.test(file.summary)
      const status = entry?.status ?? (oldDup ? '历史·旧命名副本' : '在办')
      const t = `${file.date.slice(5)} ${file.hm.slice(0, 2)}:${file.hm.slice(2)}`
      const summary = file.summary.replace(/（旧命名，时间取文件修改时间）$/, '').replace(/\|/g, '｜').slice(0, 40)
      const projectCell = entry?.project ? `\`${entry.project}\`` : oldDup ? '—' : '未归项目'
      lines.push(`| ${t} | ${summary} | ${projectCell} | ${status} | \`${file.rel}\` |`)
    }
  }
  lines.push('')

  lines.push('## 三 · 文件（80）· 东西放哪')
  lines.push('')
  lines.push('> 细则（完整放置表 + 写入规矩）：`handoff/索引/文件目录.md`')
  lines.push('')
  for (const [bucket, note] of BUCKET_LINES) lines.push(`- \`${bucket}/\`：${note}`)
  lines.push('')
  lines.push('- 过期文件清单（只报告，不删）：`logs/清扫报告.md`（保留期：审计 90 天 / 账本 180 天 / 回收站 90 天 / 临时区 14 天）')
  lines.push('- 交接都在 `handoff/`：`machine/` 机器版 · `user/` 用户版 · `projects/` 白板（`done/` 是做完的）· `教训日记/` · `任务交接本/` · `索引/` · `时间交接/` · `plugins/` 插件卡 · `能力目录.md` · `inbox.jsonl`')
  lines.push('- 要写教训：`handoff/教训日记/<日期>-<主题>.md`，并到 `handoff/索引/教训索引.md` 加一行；要更新电脑现状：`handoff/任务交接本/当前状态.md`')
  lines.push('- 交接怎么写、放哪、什么格式：`handoff/手册/交接规范.md`（五种交接 + 五套模板，照抄即可）；不按这个写就来找这一页')
  lines.push('- **要重启 DSH**：只走 `外部重启脚本（safety-kit/bin/restart-dsh-later.ps1）`（先说「马上重启」再排，30 秒后动手；别直接跑 restart-dsh.ps1、别用 Start-Process/WMI），规则 `handoff/手册/重启.md`')
  lines.push('- **要往公开仓库传代码**：先读 `handoff/手册/上传仓库前的隐私清洗.md`；活目录 `插件目录\\<插件名>` 装了 pre-push 保险丝，公开仓库只从 `scratch/publish/` 的干净副本推，白板/交接/日档一律不进仓库')
  lines.push('- 插件现状卡：`handoff/plugins/<插件名>/README.md`（入口/版本/怎么调起/坑）；总览 `handoff/plugins/README.md`')
  lines.push('- 机器读的：`handoff/index.machine.json`（结构化索引）· `directions.jsonl`（方向谱系）· `open-items.jsonl`（未闭环）')
  lines.push('- 账本：日报 `logs/账本/README.md`（脚本 `ledger 工具的 ledger.mjs`，计划任务 tongwen-ledger）；记录规范 `logs/账本/记录规范.md`，用 `ledger 工具的 record.mjs` 追加；只看不改')
  lines.push('- 收工前写**日档**：`self/日档/<日期>-<时空名>.md`（五段：触点/我的想/变/我的回/回声，规则 `self/日档/README.md`）；聊天类时空写 `self/diary/` 日记，不写日档')
  lines.push('')

  lines.push('## 四 · 插件（70）')
  lines.push('')
  lines.push('> 细则（装在哪个 path、怎么加载、改动规矩）：`handoff/索引/插件目录.md`；每个插件一张现状卡在 `handoff/plugins/`，总览 `handoff/plugins/README.md`（16 张卡）')
  lines.push('')
  lines.push('- `dsh-tongwen`：书同文——交接、索引、这一页的生成者（`插件目录\\dsh-tongwen`）')
  lines.push('- `dsh-self-persona`：人格卡、记忆卡、好感度、日记')
  lines.push('- `bridge-kit`：聊天与站点桥接（`bridge-kit`）')
  lines.push('- `safety-kit`：安全插件（施工中，`safety-kit`）')
  lines.push('')

  lines.push('## 五 · 工具（60）')
  lines.push('')
  lines.push('> 细则（版本、路径、踩坑）：`handoff/索引/工具目录.md`')
  lines.push('')
  lines.push('- 运行时：node / pnpm / python 在 `<DSH_HOME>\\dsh-runtimes\\dsh-primary-runtime\\dependencies`')
  lines.push('- 媒体：ffmpeg（外部依赖，按系统 PATH 找）')
  lines.push('- 浏览器：内置无头浏览器（profile 由宿主管理）')
  lines.push('- 自写脚本：能力目录脚本 · ledger 工具（信息账本）· bridge-kit 的 bili 命令（站点桥接）')
  lines.push('')

  lines.push('## 六 · A 盘（50）')
  lines.push('')
  lines.push('> 细则（17 个目录的大小/用途/能不能动）：`handoff/索引/A盘目录.md`（自动扫描生成）')
  lines.push('')
  const scanLine = await aDriveScanLine(ctx)
  if (scanLine) lines.push(scanLine)
  lines.push('- 大头：模型缓存、DSH 的家（会话与运行时）、工具目录、DSH 程序本体')
  lines.push('- 往 A 盘存东西前先想一句：该不该进九档？别把交接散到根目录')
  lines.push('')

  lines.push('## 七 · 已归档（10）')
  lines.push('')
  const done = projects
    .filter((item) => item.status === 'done' || item.archived)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
  if (done.length === 0) {
    lines.push('（还没有）')
  } else {
    for (const project of done.slice(0, 10)) {
      const when = String(project.updated ?? '').replace('T', ' ').slice(0, 10)
      lines.push(`- ~~${project.title || project.id}~~（\`${project.id}\`）· ${when} 完成`)
    }
    if (done.length > 10) lines.push(`- 还有 ${done.length - 10} 个更早的，在 \`handoff/projects/done/\` 里`)
  }
  lines.push('')

  lines.push('## 使用排行（最近 30 份机器交接里的引用次数）')
  lines.push('')
  const ranking = await usageRanking(ctx)
  if (ranking.length === 0) {
    lines.push('（还没有足够样本；写几份交接后自动出现）')
  } else {
    for (const row of ranking) {
      lines.push(`- \`${row.candidate}\` —— 被提到 ${row.hits} 次`)
    }
    lines.push('')
    lines.push('> 权重决定先看哪一段；这一栏告诉你「最近大家都在点哪几页」，两者不冲突。')
  }
  lines.push('')

  lines.push('## 索引页（手写，插件只链不覆盖）')
  lines.push('')
  for (const [name, file, note] of INDEX_PAGES) lines.push(`- ${name}：\`${file}\` —— ${note}`)
  lines.push('')

  return lines.join('\n')
}

/**
 * 刷新 handoff/README.md。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {object} index
 */
export async function updateHandoffReadme(ctx, index) {
  const text = await renderCatalog(ctx, index)
  await writeFileAtomic(ctx.readmeFile, `${text}\n`)
  // 0.4.4：交接索引以前是“一次性脚本”生成的，插件不管它，一停就旧（33 份 vs 58 份）。
  // 现在跟总目录一起刷新；这页坏了不该拖垮总目录，所以失败静默。
  try {
    await writeHandoffIndex(ctx, index)
  } catch {
    // 静默：总目录已经写成功了
  }
  // 0.5.0 三层：顺手把「手册总览」「动态白板」也刷新。同样失败静默——
  // 少一页不该让总目录写不出去。
  try {
    await writeLayers(ctx)
  } catch {
    // 静默：另两层的错由它们自己记日志
  }
}

/**
 * 索引有两种形状：运行时传入的 `runtime.index` 是裸索引，
 * `ensureIndex()` 返回的却是 `{ index, action, problems }` 包装。
 * 两处都要能吃（0.4.4 修：包装形态进不来，导致「最近一次交接」一直显示「（还没有）」）。
 *
 * @param {object|null|undefined} index
 * @returns {Array<object>}
 */
function entriesOf(index) {
  if (Array.isArray(index?.entries)) return index.entries
  if (Array.isArray(index?.index?.entries)) return index.index.entries
  return []
}

/**
 * 某个项目「现在该读的那一份交接」。
 *
 * 优先级：在办（不是 done、也不在 archive/）里最新的 → 实在没有才退回最新归档那份。
 * 0.4.5 修：以前只看 lastUpdated，会把已归档的旧交接当成「当前交接」推到新时空面前。
 *
 * @param {Array<object>} entries
 * @param {string} projectId
 * @returns {{entry: object, archived: boolean}|null}
 */
function latestHandoffFor(entries, projectId) {
  const candidates = entries
    .filter((entry) => entry.project === projectId && entry.machineHandoff)
    .sort((a, b) => String(b.lastUpdated).localeCompare(String(a.lastUpdated)))
  // 「交接 status 是 done」只表示那次任务收尾了，不代表不能读；只有真被移进 archive/ 的才算旧记录。
  const live = candidates.filter((entry) => !String(entry.machineHandoff).includes('/archive/'))
  if (live.length > 0) return { entry: live[0], archived: false }
  if (candidates.length > 0) return { entry: candidates[0], archived: true }
  return null
}

/**
 * 重写 `handoff/索引/交接索引.md`：在办交接全量一览（时间/内容总结/状态/路径）。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {object} index
 */
export async function writeHandoffIndex(ctx, index) {
  const files = await listHandoffFiles(ctx, 1000)
  const physical = await countMachineFiles(ctx)
  const entries = entriesOf(index)
  const byPath = new Map(entries.map((e) => [e.machineHandoff, e]))
  const archivedCount = await countArchivedMachineFiles(ctx)
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const stamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`

  const lines = []
  lines.push('# 交接索引（先扫这一页，再点开）')
  lines.push('')
  lines.push('> 文件名就是内容总结：`<日期>-<时分>-<一句话>.machine.md`。查东西先看这张表，别一份份翻。')
  lines.push('> 做完的交接会被移到 `handoff/machine/archive/<日期>/`，清单里只留还在用的。')
  lines.push('')
  lines.push(`- 在用的交接：${files.length} 份（已按内容去重；磁盘上实际 ${physical} 份，其中 ${physical - files.length} 份是迁移期留下的旧命名重复副本）`)
  lines.push(`- 已归档：${archivedCount} 份（在 \`handoff/machine/archive/\`）`)
  lines.push(`- 生成时间：${stamp}（北京时间；插件每次启动/归档后自动重写，别手改）`)
  lines.push('')

  // ── 按项目看（0.4.5）：认领项目只读这一节，不用扫下面几十行 ──
  lines.push('## 按项目看（先认领项目，再点开它下面那一份）')
  lines.push('')
  const byProject = new Map()
  const projectIds = new Set(
    entriesOf(index)
      .filter((entry) => entry.project && entry.machineHandoff)
      .map((entry) => entry.project),
  )
  for (const projectId of projectIds) {
    const picked = latestHandoffFor(entriesOf(index), projectId)
    if (picked) byProject.set(projectId, picked)
  }
  if (byProject.size === 0) {
    lines.push('（还没有挂项目的交接；新交接写 `project` 后会自动出现在这里）')
  } else {
    for (const [projectId, picked] of [...byProject.entries()].sort((a, b) =>
      String(b[1].entry.lastUpdated).localeCompare(String(a[1].entry.lastUpdated)),
    )) {
      const mark = picked.archived ? '（已归档）' : ''
      lines.push(
        `- **\`${projectId}\`** → 最近一份${mark}：\`${picked.entry.machineHandoff}\` —— ${picked.entry.displayName ?? ''}（${whenText(picked.entry.lastUpdated)}）`,
      )
    }
  }
  lines.push('')
  lines.push('> 你被派去接哪个项目，就读它「最近一份」；归属不明时看下面的总表，或直接问人「我是接哪个项目的」。')
  lines.push('')
  lines.push('## 全部在办（按时间倒序）')
  lines.push('')
  lines.push('| 时间 | 内容总结 | 项目 | 交给 | 状态 | 路径 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const file of files) {
    const hit = byPath.get(file.rel)
    const oldDup = !hit && /（旧命名，时间取文件修改时间）$/.test(file.summary)
    // 0.5.3：旧命名副本没进索引时标「历史·旧命名副本」，别再冒充「在办」。
    const status = hit?.status === 'done' ? 'done' : oldDup ? '历史·旧命名副本' : '在办'
    const hm = `${file.date.slice(5)} ${file.hm}`
    const projectCell = hit?.project ? `\`${hit.project}\`` : oldDup ? '—' : '未归项目'
    const toCell = hit?.to ?? 'any'
    const summary = file.summary.replace(/（旧命名，时间取文件修改时间）$/, '')
    lines.push(`| ${hm} | ${summary} | ${projectCell} | ${toCell} | ${status} | \`${file.rel}\` |`)
  }
  lines.push('')
  lines.push('## 用法')
  lines.push('')
  lines.push('- 找活：看「状态」和日期，最近的在前；`done` 的只作背景。')
  lines.push('- 新写交接：`end_task` 会自动按命名规则起名并重写这一页，不用手抄。')
  lines.push('- 做完的交接：`end_task` 时 status=done，再由插件搬进 `archive/<日期>/`。')
  lines.push('')

  const target = path.join(ctx.root, 'handoff', '索引', '交接索引.md')
  await writeFileAtomic(target, lines.join('\n'))
  try {
    await syncLessonIndex(ctx)
  } catch {
    /* 教训索引补登失败不该拖垮总目录 */
  }
}

/** 从正文里摘一句「这个文件讲什么」：先找 `> 一句话：`，再找第一条引用，最后取第一段正文。 */
function lessonGist(text) {
  const quoted = text.match(/^>\s*一句话[:：]\s*(.+)$/m)
  if (quoted) return quoted[1].trim()
  const quote = text.match(/^>\s*(.+)$/m)
  if (quote) return quote[1].trim()
  const para = text
    .split(/\r?\n\r?\n/)
    .map((p) => p.replace(/^#.*$/gm, '').trim())
    .find((p) => p && !p.startsWith('|') && !p.startsWith('-'))
  return (para ?? '').replace(/\s+/g, ' ').slice(0, 120)
}

/**
 * 教训索引自动补登（0.5.3）。
 *
 * 为什么要自动：规矩是「新写一条教训，顺手在索引加一行」，但手写的那一行会忘——
 * 实测 19 篇教训、索引只有 13 行，差 6 篇，谁按索引找就会以为没有。
 * 现在每次重写总目录时顺手扫一遍 `handoff/教训日记/*.md`，缺的补上；
 * 已经有的行（手写的那句更用心）不动，只补缺。
 */
async function syncLessonIndex(ctx) {
  const base = path.join(ctx.root, 'handoff', '教训日记')
  const target = path.join(ctx.root, 'handoff', '索引', '教训索引.md')
  let names = []
  try {
    names = (await readdir(base)).filter((n) => n.endsWith('.md') && n !== 'README.md')
  } catch {
    return 0
  }
  let text = ''
  try {
    text = await readFile(target, 'utf8')
  } catch {
    return 0
  }
  if (!text.trim()) return 0
  const missing = []
  for (const name of names.sort()) {
    const rel = `handoff/教训日记/${name}`
    if (text.includes(rel)) continue
    const matched = name.match(/^(\d{4}-\d{2}-\d{2})-(.+?)\.md$/)
    const date = matched?.[1] ?? ''
    const topic = (matched?.[2] ?? name.replace(/\.md$/, '')).replace(/\s+/g, ' ').trim()
    let body = ''
    try {
      body = await readFile(path.join(base, name), 'utf8')
    } catch {
      /* 读不到就只写标题 */
    }
    const gist = (lessonGist(body) || '（还没写一句话）').replace(/\|/g, '\\|')
    missing.push(`| ${date} | ${topic} | ${gist} | \`${rel}\` |`)
  }
  if (missing.length === 0) return 0
  const block = `${missing.join('\n')}\n`
  const marker = '\n## 用法'
  const next = text.includes(marker)
    ? text.replace(marker, `\n${block}${marker}`)
    : `${text.replace(/\s*$/, '')}\n${block}`
  await writeFileAtomic(target, next)
  return missing.length
}

/**
 * 数一下磁盘上「还在用」的交接文件（`handoff/machine/<日期>/` 下，不含 archive）。
 *
 * 0.5.3：为什么要单独数——`listHandoffFiles` 会把新旧两种命名的同一份交接合并成一条，
 * 于是「索引说 87 份、磁盘 93 份」，看着像丢了 6 份。两个数都对，只是口径不同：
 * 合并后的「几条」和磁盘上的「几份文件」。索引里两个都写清楚，别再自己跟自己打架。
 */
async function countMachineFiles(ctx) {
  const base = path.join(ctx.root, 'handoff', 'machine')
  let days = []
  try {
    days = await readdir(base)
  } catch {
    return 0
  }
  let total = 0
  for (const day of days) {
    if (day === 'archive') continue
    try {
      const names = await readdir(path.join(base, day))
      total += names.filter((n) => n.endsWith('.machine.md')).length
    } catch {
      /* 不是目录就跳过 */
    }
  }
  return total
}

/** 数一下 `handoff/machine/archive/` 下有多少份交接。 */
async function countArchivedMachineFiles(ctx) {
  let count = 0
  async function walk(dir) {
    let items = []
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of items) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) await walk(p)
      else if (ent.name.endsWith('.machine.md')) count += 1
    }
  }
  await walk(path.join(ctx.root, 'handoff', 'machine', 'archive'))
  return count
}

/** 项目总览文件（第二张对齐图）。 */
const OVERVIEW_FILE = 'handoff/项目总览.md'
const OVERVIEW_MAX_TODO = 6
const OVERVIEW_MAX_DECISIONS = 3

const shorten = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 把白板里的一条（可能是字符串，也可能是对象）取成一句人话。
 *
 * 0.5.3：黑板的待办段出现过 5 行 `[object Object]`——`project_upsert` 收的是对象，
 * 渲染时直接 `String(item)` 就写成了这样，数据一坏整段没法读。现在统一走这里取字段，
 * 取不到才退化成 JSON，至少还看得见内容。
 */
const itemText = (item) => {
  if (item == null) return ''
  if (typeof item === 'string') return item
  if (typeof item === 'number' || typeof item === 'boolean') return String(item)
  const picked = item.text ?? item.action ?? item.what ?? item.note ?? item.title ?? item.summary ?? item.task ?? ''
  if (typeof picked === 'string' && picked.trim()) return picked
  try {
    return JSON.stringify(item)
  } catch {
    return String(item)
  }
}

/** 行首连着两个日期时去掉第一个（`project_upsert` 自己加时间戳，老数据里又手写了日期）。 */
const DECISION_LEAD_DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?\s+(?=\d{4}-\d{2}-\d{2})/
const progressText = (item) => {
  const text = itemText(item).replace(/\s+/g, ' ').trim()
  return text.replace(DECISION_LEAD_DATE, '')
}

// 索引里存的是 UTC ISO（…Z），交接文件名用的是北京时间。
// 直接截字符串会显示成 UTC（比本地慢 8 小时），你看到的「停在 11-04 21:16」就是这么来的（0.4.4 修）。
const whenText = (value) => {
  if (!value) return ''
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(ms)) return String(value).replace('T', ' ').slice(0, 16)
  const bj = new Date(ms + 8 * 3600 * 1000).toISOString()
  return `${bj.slice(0, 10)} ${bj.slice(11, 16)}`
}

/**
 * 生成 `handoff/项目总览.md`：项目有多少、各自到哪一步、最近加了什么。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {object} index
 * @returns {Promise<string>}
 */
export async function renderProjectOverview(ctx, index = null) {
  const lines = []
  lines.push('# 项目总览（第二张对齐图）')
  lines.push('')
  lines.push('> 总目录说「东西在哪」，这一页说「活干到哪」。开工先扫一眼：项目几个、各自到哪一步、上次加了什么。')
  lines.push('> 插件在启动与每次 `project_upsert` 后刷新；要改说法改本文件的生成逻辑，不要手改这一页。')
  lines.push('')

  let projects = []
  try {
    projects = await listProjects(ctx.projectsDir)
  } catch {
    projects = []
  }
  const priorityOf = (project) => PRIORITY_ORDER[project.priority] ?? 9
  const byWeight = (a, b) =>
    priorityOf(a) - priorityOf(b) || String(b.updated).localeCompare(String(a.updated))
  const active = projects.filter((item) => item.status !== 'done' && !item.archived).sort(byWeight)
  const finished = projects
    .filter((item) => item.status === 'done' || item.archived)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))

  const counts = { active: 0, paused: 0, done: 0 }
  for (const project of projects) counts[project.status] = (counts[project.status] ?? 0) + 1
  const priorityCounts = { P0: 0, P1: 0, P2: 0, P3: 0 }
  for (const project of active) priorityCounts[project.priority ?? 'P2'] += 1
  const latest = projects.map((item) => item.updated).sort().reverse()[0]

  lines.push('## 总览')
  lines.push('')
  lines.push(
    `- 项目 ${projects.length} 个：**active ${counts.active}** · paused ${counts.paused} · done ${counts.done}`,
  )
  lines.push(
    `- 在办的优先级：P0 ${priorityCounts.P0} · P1 ${priorityCounts.P1} · P2 ${priorityCounts.P2} · P3 ${priorityCounts.P3}`,
  )
  lines.push(`- 最近一次更新：${latest ? whenText(latest) : '（还没有项目）'}（白板自己的时间，可能比交接旧）`)
  const lastHandoff = entriesOf(index)
    .map((item) => item.lastUpdated)
    .filter(Boolean)
    .sort()
    .reverse()[0]
  lines.push(`- 最近一次交接：${lastHandoff ? whenText(lastHandoff) : '（还没有）'}（以这条为准）`)
  lines.push('')

  lines.push('## 排行榜（权重优先，同权重按最近更新）')
  lines.push('')
  if (active.length === 0) {
    lines.push('（暂无进行中的项目）')
  } else {
    lines.push('| 权重 | 项目 | 状态 | 待办 | 挂账 | 到哪一步 | 白板更新 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const project of active) {
      const model = await readProject(ctx.projectsDir, project.id).catch(() => null)
      const todoCount = model?.model?.todo?.length ?? 0
      const issueCount = model?.model?.issues?.length ?? 0
      const baton = await readBaton(ctx.projectsDir, project.id).catch(() => null)
      const step = shorten(baton?.action || '（还没排下一棒）', 40).replace(/\|/g, '｜')
      lines.push(
        `| ${project.priority ?? 'P2'} | ${shorten(project.title || project.id, 24).replace(/\|/g, '｜')}（\`${project.id}\`） | ${project.status} | ${todoCount} 条 | ${issueCount ? `**${issueCount} 条**` : '—'} | ${step} | ${whenText(project.updated)} |`,
      )
    }
  }
  lines.push('')

  lines.push('## 逐个看')
  lines.push('')
  if (active.length === 0) lines.push('（暂无进行中的项目）')
  for (const project of active) {
    const loaded = await readProject(ctx.projectsDir, project.id).catch(() => null)
    const model = loaded?.model ?? null
    const baton = await readBaton(ctx.projectsDir, project.id).catch(() => null)
    lines.push(
      `### [${project.priority ?? 'P2'}] ${project.title || project.id}（\`${project.id}\`）`,
    )
    lines.push('')
    lines.push(
      `- 状态：${project.status} · 待办 ${model?.todo?.length ?? 0} 条 · 挂账 ${model?.issues?.length ?? 0} 条 · 更新 ${whenText(project.updated)}`,
    )
    if (model?.goal) lines.push(`- 目标：${shorten(model.goal, 120)}`)
    lines.push(
      `- 当前一棒：交给 \`${baton?.to || project.baton?.to || 'any'}\` —— ${shorten(baton?.action || '（还没排下一棒）', 120)}`,
    )
    const decisions = (model?.decisions ?? []).slice(-OVERVIEW_MAX_DECISIONS).reverse()
    if (decisions.length) {
      lines.push('- 最近进展：')
      for (const decision of decisions) lines.push(`  - ${shorten(progressText(decision), 120)}`)
    }
    const issues = (model?.issues ?? []).slice(0, OVERVIEW_MAX_TODO)
    if (issues.length) {
      lines.push('- 挂账（有坑没解决，交接必看）：')
      for (const item of issues) lines.push(`  - ⚠ ${shorten(itemText(item), 100)}`)
    }
    const todo = (model?.todo ?? []).slice(0, OVERVIEW_MAX_TODO)
    if (todo.length) {
      lines.push('- 待办：')
      for (const item of todo) lines.push(`  - ${shorten(itemText(item), 100)}`)
      if ((model?.todo?.length ?? 0) > OVERVIEW_MAX_TODO) {
        lines.push(`  - ……还有 ${model.todo.length - OVERVIEW_MAX_TODO} 条，见 \`handoff/projects/${project.id}.md\``)
      }
    }
    lines.push('')
  }

  lines.push('## 已归档（做完了的）')
  lines.push('')
  if (finished.length === 0) {
    lines.push('（还没有）')
  } else {
    for (const project of finished.slice(0, 12)) {
      lines.push(`- ~~${project.title || project.id}~~（\`${project.id}\`）· ${whenText(project.updated)}`)
    }
    if (finished.length > 12) lines.push(`- 还有 ${finished.length - 12} 个，在 \`handoff/projects/done/\``)
  }
  lines.push('')
  lines.push('> 怎么改：`project_upsert` 改白板；这一页会自动重排。别手动改这一页。')
  lines.push('')

  return lines.join('\n')
}

/**
 * 刷新 `handoff/项目总览.md`。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {object} index
 */
export async function updateProjectOverview(ctx, index) {
  const text = await renderProjectOverview(ctx, index)
  await writeFileAtomic(path.join(ctx.root, OVERVIEW_FILE), `${text}\n`)
}
