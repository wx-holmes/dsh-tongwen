/**
 * 工具相关性闸门（2026-11-10 03:45，你批准方案 B）
 *
 * 做法：每轮第一步之前看「这一步要处理的用户话」，按关键词认这次是什么活；
 * 认出来的组才让它的工具露在工具面上，其余的用 tools.restrict 挡掉。
 * 只在命中组与上一轮不同时才动工具面（方案 B：变了才算），避免每步都改提示缓存。
 *
 * 安全底线：
 *   - 任何异常都吞掉，绝不影响正常对话（宁可全露，不可崩）。
 *   - 有开关文件 state/relevance-off：存在就整个不生效。
 *   - 只挡「场景组」，核心工具（文件/壳/交接/信箱/触手/感官/搜索）永远不挡。
 */
import { appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/** 场景组：id -> { 关键词, 工具名前缀/全名 } */
const GROUPS = [
  {
    id: 'browser',
    kw: ['网页', '浏览器', '打开网站', '搜索一下', '搜一下', '查一下', '查资料', '找资料', '百度', '谷歌', '必应', '页面', '链接', 'http', '网址', 'url', 'b站', '视频', '在线看', '访问', '下载文件', '这个网站'],
    names: ['dsh_browser_'],
  },
  {
    id: 'game',
    kw: ['游戏', '回合', '关卡', 'boss', '攻略', '存档', '盘面', '出招', '打怪', '战棋', '这步怎么走', '该出什么', '道具', '技能', '血量', '读档'],
    names: ['coach_', 'game_coach_', 'rules_', 'flow_', 'guard_', 'cv_'],
  },
  {
    id: 'session',
    kw: ['会话坏了', '会话修复', '修会话', '会话文件', '归档会话', '扫描会话', 'session_repair', '会话打不开', '会话丢了', '恢复会话'],
    names: ['session_'],
  },
  {
    id: 'schedule',
    kw: ['定时', '日程', '每天', '每周', '每月', '提醒我', '叫我', '闹钟', 'cron', '排程', '到时候', '过一会儿', '明天早上', '明天晚上'],
    names: ['schedule_'],
  },
  {
    id: 'delegate',
    kw: ['分身', '子代理', '并行', '批量审', '开一堆', '多个代理', 'workflow', '编排', '同时看', '分头'],
    names: ['subagent', 'workflow', 'list_agents', 'interrupt_agent', 'send_message', 'list_subagent_models'],
  },
  {
    id: 'goal',
    kw: ['长期目标', '目标系统', '里程碑', 'goal', '这个目标', '推进目标'],
    names: ['create_goal', 'get_goal', 'update_goal'],
  },
  {
    id: 'memory',
    kw: ['记忆', '回忆', '想不起来', '忘', '记得', '好感', '日记', '图库', '潜意识', '以前说过', '上次说的', '想起来'],
    names: ['consciousness_'],
  },
  {
    id: 'blackhole',
    kw: ['外部插件', '压缩原文', '块库', 'bh_', '原文呢', '把原文存起来'],
    names: ['bh_'],
  },
  {
    id: 'job',
    kw: ['后台跑', '长任务', '后台任务', '跑着', '挂后台', '慢慢跑', '跑完告诉我'],
    names: ['job_'],
  },
  {
    id: 'plugin',
    kw: ['插件', '安装', '卸载', 'profile', '配置项', 'provider', '挂上', '摘掉'],
    names: ['plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query', 'organ_list', 'organ_call'],
  },
  {
    id: 'sense',
    kw: ['看屏幕', '屏幕变化', '盯着屏幕', '自动看', '看着屏幕'],
    names: ['sense_'],
  },
]

/** 永不挡（防误伤核心） */
const NEVER = ['mcp__tentacle__', 'mcp__sensory__', 'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager', 'skill', 'ask_user_question', 'read', 'write', 'edit', 'grep', 'glob', 'pwsh', 'todo_write', 'present', 'web_search', 'web_fetch', 'working_directory']

function textOfMessage(m) {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join(' ')
  }
  return ''
}

function matchGroups(text) {
  const hit = new Set()
  for (const g of GROUPS) {
    if (g.kw.some((k) => text.includes(k))) hit.add(g.id)
  }
  return hit
}

/** 由当前可见定义算出「该挡哪些」 */
function denyListFor(definitions, matched) {
  const keepPrefixes = []
  for (const g of GROUPS) if (matched.has(g.id)) keepPrefixes.push(...g.names)
  const deny = []
  for (const d of definitions) {
    const name = String(d?.name ?? '')
    if (!name) continue
    if (NEVER.some((n) => name === n || name.startsWith(n))) continue
    const inAnyGroup = GROUPS.some((g) => g.names.some((n) => name === n || name.startsWith(n)))
    if (!inAnyGroup) continue
    const kept = keepPrefixes.some((n) => name === n || name.startsWith(n))
    if (!kept) deny.push(name)
  }
  return deny
}

export function installToolGate(ctx, root) {
  const offFile = path.join(root, 'state', 'relevance-off')
  const logFile = path.join(root, 'logs', 'relevance.log')
  const off = () => { try { return existsSync(offFile) } catch { return true } }
  const log = (line) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8') } catch {} }

  /** agent -> { sig, dispose }（用 Map 按 agent 对象内存保持） */
  const held = new WeakMap()

  const handle = async (agent, messages, where) => {
    // 开关一建，先把已经挂上的限制撤干净，再退出（否则「关了闸门」仍然看不见工具）
    if (off()) {
      const prev = agent ? held.get(agent) : null
      try { prev?.dispose?.() } catch {}
      if (agent) held.delete(agent)
      return
    }
    const tools = ctx.tools
    if (!tools || typeof tools.restrict !== 'function') return
    const text = (messages ?? []).map(textOfMessage).join(' ')
    if (!text.trim()) return
    const matched = matchGroups(text)
    const sig = [...matched].sort().join(',') || 'core'
    const prev = held.get(agent)
    if (prev && prev.sig === sig) return
    // restrict 必须在「这个 agent 的 scoped ctx」上调用，否则会被拒（宿主原话：
    // a context-global restriction would mask every agent）。所以优先拿 agent.ctx.tools。
    const scopedTools = agent?.ctx?.tools ?? null
    let definitions = []
    try { definitions = scopedTools?.definitions?.(agent) ?? tools.definitions?.(agent) ?? [] } catch { definitions = [] }
    const deny = denyListFor(definitions, matched)
    try { prev?.dispose?.() } catch {}
    let dispose = null
    try {
      if (deny.length) {
        if (!scopedTools) throw new Error('agent.ctx.tools 不可用')
        dispose = scopedTools.restrict({ deny })
      }
    } catch (e) { log(`restrict failed: ${e?.message ?? e}`) }
    held.set(agent, { sig, dispose })
    log(`${where} agent=${String(agent?.id ?? '?').slice(0, 18)} groups=${sig} deny=${deny.length}${dispose ? '' : ' (no-dispose)'}`)
  }

  // 每步之前：看这一步的用户消息，算一次；只在命中变化时动工具面。
  ctx.on('agent/pre-step', async function (payload, next) {
    try { await handle(payload?.agent ?? this?.agent, payload?.messages, 'pre-step') } catch {}
    return next()
  })

  log('tool-gate installed')
  return { off, log }
}
