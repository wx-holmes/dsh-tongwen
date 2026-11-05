/**
 * 书同文车同轨 —— 插件入口。
 *
 * 规格：v1.1 冻结施工基线。
 * 这个文件只做三件事：注册工具、注册系统级注入、接宿主事件。
 * 规则全在 lib/ 里，别往这里塞业务判断。
 */

import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createContext } from './lib/context.js'
import { resolveConfig } from './lib/config.js'
import { AuditWriter } from './lib/audit.js'
import { runStartup, runSessionEnd } from './lib/runtime.js'
import { generatedSessionId } from './lib/ulid.js'
import { writeRuntimeState } from './lib/runtime-state.js'
import { BUCKET_LIST } from './lib/buckets.js'
import { listProjects } from './lib/projects.js'
import { readInbox, mergeInbox } from './lib/inbox.js'
import {
  envelope,
  failure,
  locate,
  inspectHandoff,
  listHandoffs,
  updateHandoff,
  heartbeat,
  restore,
  rollbackData,
  archiveHandoff,
  beginTask,
  endTask,
  projectUpsert,
  projectRead,
  projectList,
  inboxSend,
  inboxList,
  inboxClose,
  organList,
  organCall,
} from './lib/tools.js'
import { runHousekeeping } from './lib/housekeeping.js'

export const name = 'dsh-tongwen'

export const inject = ['tools', 'systemPrompt', 'timer']

/**
 * 插件版本。current.json 里比对的就是这个。
 * 从 package.json 读 —— 手写常量就一定会忘，忘一次版本指针就永远停在旧号上。
 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

/**
 * 加载期错误记录。
 *
 * 宿主对一个加载失败的插件只会把 fiber 标成 failed，错误本身吞掉，
 * 外面看不见。这里把每一步的异常追加到 apply-error.log，
 * 同时让 apply 尽量走完——能注册几个是几个，至少别整块消失。
 */
const APPLY_LOG = fileURLToPath(new URL('./apply-error.log', import.meta.url))

function recordApplyError(step, error) {
  try {
    appendFileSync(APPLY_LOG, `${new Date().toISOString()} [${step}] ${error?.stack ?? String(error)}\n`, 'utf8')
  } catch {
    // 日志都写不了就算了，不能因此再抛
  }
}

/* ------------------------------------------------------------------ */
/* ValueSchema → JSON Schema                                          */
/* ------------------------------------------------------------------ */

/**
 * 宿主工具的 parameters 用这套简写；注册时再编译成 JSON Schema。
 * @param {Record<string, any>} spec
 */
function compileValueSchema(spec) {
  if (!spec || typeof spec !== 'object') return {}
  switch (spec.type) {
    case 'string': {
      const out = { type: 'string' }
      if (spec.description) out.description = spec.description
      if (Array.isArray(spec.enum)) out.enum = spec.enum
      if (spec.default !== undefined) out.default = spec.default
      return out
    }
    case 'integer':
    case 'number': {
      const out = { type: spec.type === 'number' ? 'number' : 'integer' }
      if (spec.description) out.description = spec.description
      if (spec.default !== undefined) out.default = spec.default
      if (spec.minimum !== undefined) out.minimum = spec.minimum
      if (spec.maximum !== undefined) out.maximum = spec.maximum
      return out
    }
    case 'boolean': {
      const out = { type: 'boolean' }
      if (spec.description) out.description = spec.description
      if (spec.default !== undefined) out.default = spec.default
      return out
    }
    case 'array': {
      const out = { type: 'array' }
      if (spec.description) out.description = spec.description
      if (spec.items) out.items = compileValueSchema(spec.items)
      return out
    }
    case 'object': {
       const out = { type: 'object' }
      if (spec.description) out.description = spec.description
      if (spec.properties) {
        const inner = compileParameters(spec.properties)
        out.properties = inner.properties
        if (Array.isArray(inner.required) && inner.required.length) out.required = inner.required
        out.additionalProperties = false
      }
      if (Array.isArray(spec.required)) out.required = spec.required
      return out
    }
    case 'json':
    default:
      return {}
  }
}

/**
 * @param {Record<string, any>} properties
 */
function compileParameters(properties) {
  const schema = { type: 'object', properties: {}, additionalProperties: false }
  const required = []
  for (const [key, spec] of Object.entries(properties ?? {})) {
    schema.properties[key] = compileValueSchema(spec)
    if (spec?.required) required.push(key)
  }
  if (required.length > 0) schema.required = required
  return schema
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

const TOOL_SPECS = [
  {
    name: 'locate',
    description:
      '按关键词查找已有的交接实例，返回候选列表（含档位、类型、实例名、机器版交接路径）。写文件前路径不确定时先调用它，不要猜。',
    parameters: {
      query: { type: 'string', description: '关键词，可以是实例名、显示名或类型名的一部分', required: true },
      bucket: { type: 'string', description: '只在某个档里找（handoff/created/downloads/incoming/scratch/archive/logs/config/self）' },
      typeSlug: { type: 'string', description: '只在某个类型下找' },
      limit: { type: 'integer', description: '最多返回几条，默认按配置' },
    },
    execute: locate,
  },
  {
    name: 'inspect_handoff',
    description:
      '读一份交接文件。可以给 path（handoff/ 或 archive/versions/ 下的相对路径），也可以给 instance 名。返回结构化内容与原文。',
    parameters: {
      path: { type: 'string', description: '交接文件相对路径，优先于 instance' },
      instance: { type: 'string', description: '实例物理名' },
      kind: { type: 'string', description: '读机器版还是用户版', enum: ['machine', 'user'] },
      version: { type: 'integer', description: '读归档的某一版（不传则读最新）' },
    },
    execute: inspectHandoff,
  },
  {
    name: 'list_handoffs',
    description: '列出交接实例，可按类型、状态、更新时间筛选，分页返回。',
    parameters: {
      typeSlug: { type: 'string', description: '类型短名' },
      status: { type: 'string', description: '实例状态', enum: ['active', 'done', 'abandoned', 'lost'] },
      from: { type: 'string', description: '最后更新时间不早于该时间（ISO 字符串）' },
      to: { type: 'string', description: '最后更新时间不晚于该时间（ISO 字符串）' },
      limit: { type: 'integer', description: '每页条数' },
      offset: { type: 'integer', description: '跳过条数' },
    },
    execute: listHandoffs,
  },
  {
    name: 'update_handoff',
    description:
      '整节替换机器版交接里的某一节。只允许改第 3 节（目标与当前状态）、第 4 节（方向锚点）、第 5 节（事实 vs 假设）、第 6 节（建议入口）。会自动保留旧版备份。',
    parameters: {
      instance: { type: 'string', description: '实例物理名', required: true },
      section: {
        type: 'string',
        description: '要替换的节标题',
        required: true,
        enum: ['3. 目标与当前状态', '4. 方向锚点', '5. 事实 vs 假设', '6. 建议入口'],
      },
      content: { type: 'string', description: '这一节的完整新内容（不含标题行）', required: true },
    },
    execute: updateHandoff,
  },
  {
    name: 'begin_task',
    description:
      '开始一次任务登记：确定档位、类型和实例名，返回幂等键。宿主没有任务概念，所以任务边界要显式声明。bucket 必须自己判断，拿不准就问人。',
    parameters: {
      bucket: {
        type: 'string',
        description: '产物归属的档（九档之一）。必须明确给出，不会默认填 created',
        required: true,
        enum: ['handoff', 'created', 'downloads', 'incoming', 'scratch', 'archive', 'logs', 'config', 'self'],
      },
      taskId: { type: 'string', description: '任务 ID，不传则自动生成（幂等性会弱）' },
      taskIdScope: { type: 'string', description: '任务 ID 的作用域', enum: ['global', 'session', 'unknown'] },
      typeDisplayName: { type: 'string', description: '类型显示名（中文优先）' },
      instance: { type: 'string', description: '想要使用的实例物理名' },
      displayName: { type: 'string', description: '实例显示名' },
      purpose: { type: 'string', description: '这次任务要做什么，一句话' },
      project: {
        type: 'string',
        description:
          '关联的项目白板 id（可选，小写字母数字连字符）。填了之后这次任务会登记进 handoff/projects/<id>.md，别的会话能看到。',
      },
    },
    execute: beginTask,
  },
  {
    name: 'end_task',
    description:
      '结束任务并把产物登记成机器版 + 用户版双份交接。产物路径必须是 <bucket>/<相对路径> 形式。旧版会自动备份。交接头会写清「属于哪个项目、交给谁」，新时空按项目就能找到自己那一份。',
    parameters: {
      status: { type: 'string', description: '任务结果', required: true, enum: ['done', 'partial', 'aborted'] },
      // 数组型参数统一用 json：宿主对嵌套数组 schema 的校验会拒绝，
      // 这里退成无 schema 的 JSON 值，结构写在 description 里。
      artifacts: {
        type: 'json',
        description:
          '产物清单，数组。每项是对象：{"path":"<bucket>/<相对路径>","type":"file|dir|symlink|other","note":"备注"}。path 必填，必须是 bucket/相对路径 形式。',
      },
      goal: { type: 'string', description: '这次任务的目标' },
      project: {
        type: 'string',
        description:
          '这份交接属于哪个项目（项目 id）。不填就沿用 begin_task 的 project；都没有就记「未归项目」——新时空按项目找不到它，尽量填。',
      },
      to: {
        type: 'string',
        description: '交给谁接：会话 id、项目 id，或 any（谁接都行，默认）。写清了下一位能直接认出这是给它留的。',
      },
      // 0.4.7 自评三件：账本算 A（准确率）要知道真实返工与引用情况，只有干活的时空自己知道。
      // 不填不报错（账本自动采样给 weak 样本），但不许拿默认值冒充事实。
      attempts: {
        type: 'number',
        description: '自评：这个任务真实返工了几次（第一次就成的写 1）。账本用它算「一次过率」；不知道就别填，不要编。',
      },
      factsCited: {
        type: 'number',
        description: '自评：交接「已确认事实」里后来真被引用、且引用对了的条数。和 factsWrong 一起算引用掌控率；不知道就别填。',
      },
      factsWrong: {
        type: 'number',
        description: '自评：交接里写错、或后来被推翻的「已确认事实」条数；确认为 0 就写 0。',
      },
      done: { type: 'json', description: '已完成的事项，字符串数组，例如 ["扫了 A 盘","写了报告"]' },
      blocked: { type: 'json', description: '未完成或阻塞的事项，字符串数组' },
      lastStop: { type: 'string', description: '上次停在哪' },
      direction: { type: 'string', description: '这次的方向，一句话' },
      directionReason: { type: 'string', description: '为什么是这个方向' },
      facts: {
        type: 'json',
        description: '已确认的事实，数组。每项是对象：{"text":"事实","source":"来源或路径"}',
      },
      assumptions: { type: 'json', description: '未验证的假设，字符串数组（只写句子）' },
      readFirst: { type: 'json', description: '建议先看什么，字符串数组' },
      avoid: { type: 'json', description: '建议不要做什么，字符串数组' },
      next: {
        type: 'json',
        description:
          '给别的会话留的请求，数组（可选）。每项是对象：{"to":"<会话ID>"|"any","request":"要对方做什么","project":"项目id"}。to 写 any 是广播。',
      },
    },
    execute: endTask,
  },
  {
    name: 'heartbeat',
    description: '报一次心跳，更新运行时状态里的最后活跃时间。',
    parameters: {},
    execute: heartbeat,
  },
  {
    name: 'restore',
    description:
      '从 archive/trash 或 archive/versions 恢复一份文件。从版本备份恢复时必须显式指定 targetBucket。恢复不会覆盖已存在的路径。',
    parameters: {
      originalPath: { type: 'string', description: '回收记录里的来源路径', required: true },
      targetBucket: {
        type: 'string',
        description: '恢复到哪个档（从 versions 恢复时必填）',
        enum: ['created', 'incoming', 'scratch', 'downloads', 'handoff'],
      },
    },
    execute: restore,
  },
  {
    name: 'archive_handoff',
    description:
      '把一个交接实例整份软删：机器版与用户版移进 archive/trash（可用 restore 找回），再从索引摘掉条目。用于清理看完的旧实例和自测残留。',
    parameters: {
      instance: { type: 'string', description: '实例物理名', required: true },
      reason: { type: 'string', description: '归档原因，记进回收记录' },
    },
    execute: archiveHandoff,
  },
  {
    name: 'housekeeping_report',
    description:
      '生成或重看「过期文件清扫报告」：列出超过保留期的审计日志、账本日报、回收站、临时区文件；只报告不删除，删要主人点头。',
    parameters: {
      force: { type: 'boolean', description: '忽略每周节流，立刻重扫一份。' },
    },
    execute: async (runtime, input) =>
      runHousekeeping(runtime.ctx, runtime.config ?? {}, { force: input?.force === true }),
  },
  {
    name: 'rollback_data',
    description:
      '把九档里的一个数据文件（白板、规范、索引页、当前状态等）回滚到某个历史版本。备份在 archive/versions/_data/ 下；回滚前会先把当前内容再备份一份，所以回滚也能再滚回去。回滚会留通知：logs/rollback.log 与 handoff/任务交接本/最近回滚.md。',
    parameters: {
      path: { type: 'string', description: '九档内的相对路径，例如 handoff/projects/tongwen-plugin.md', required: true },
      version: { type: 'string', description: '要回到的版本号（时间戳，可省略=最近一版）' },
    },
    execute: rollbackData,
  },
  {
    name: 'project_upsert',
    description:
      '建或合并一个项目白板（handoff/projects/<id>.md）。不存在则建，存在则合并：title/goal/status/priority 覆盖，to/action（当前一棒）与 todo 整体替换，participants/roles/decisions 追加，issue 挂账、resolve_issue 撤账。status=done 时白板自动移进 handoff/projects/done/，总目录里只剩一行「已归档」。跨会话共享「这个项目到哪了」。',
    parameters: {
      id: { type: 'string', description: '项目 id，小写字母/数字/连字符（中文名放 title 里）', required: true },
      title: { type: 'string', description: '项目标题（可中文）' },
      goal: { type: 'string', description: '一句话目标' },
      status: { type: 'string', description: '项目状态；done = 做完归档', enum: ['active', 'paused', 'done'] },
      priority: {
        type: 'string',
        description: '优先级：P0 立刻做 / P1 本周 / P2 有空 / P3 以后（默认 P2）',
        enum: ['P0', 'P1', 'P2', 'P3'],
      },
      to: { type: 'string', description: '当前一棒交给谁：会话 id，或 any 表示谁都能接' },
      action: { type: 'string', description: '当前一棒要做什么，一句话' },
      todo: { type: 'json', description: '待办清单，字符串数组；传了就整体替换' },
      issue: { type: 'string', description: '挂一笔坑（错误/卡点），追加到白板「挂账」节，交接时必看' },
      resolve_issue: { type: 'string', description: '撤掉一笔挂账：给关键字，命中即移除（修好后用）' },
      participant: { type: 'string', description: '参与会话一行（不传则自动登记本会话）' },
      role: { type: 'string', description: '分工一行，如「改 lib/、跑冒烟」' },
      decision: { type: 'string', description: '追加一条决定（只追加，不覆盖旧的）' },
      decisionReason: { type: 'string', description: '这条决定的理由' },
    },
    execute: projectUpsert,
  },
  {
    name: 'project_read',
    description: '读一个项目白板，返回解析后的字段与原文。项目不存在时 exists=false，不报错；已归档的项目也能读（archived=true）。',
    parameters: {
      id: { type: 'string', description: '项目 id', required: true },
    },
    execute: projectRead,
  },
  {
    name: 'project_list',
    description: '列出全部项目白板的 id、标题、状态、优先级、更新时间和当前一棒交给谁；已归档的带 archived=true。',
    parameters: {},
    execute: projectList,
  },
  {
    name: 'inbox_send',
    description:
      '给另一个会话（或所有人）留一条请求，写进 handoff/inbox.jsonl。这是会话之间唯一的托付方式——没有消息总线，对方下次开场会在简报里看到。',
    parameters: {
      to: { type: 'string', description: '目标会话 id；不传或 any 表示广播给所有会话' },
      request: { type: 'string', description: '请求内容，一句话说清要对方做什么', required: true },
      project: { type: 'string', description: '关联的项目 id（可选）' },
    },
    execute: inboxSend,
  },
  {
    name: 'inbox_list',
    description: '看信箱里的请求，可按「发给我的」「某个项目」「未处理/已完成」筛选。',
    parameters: {
      mine: { type: 'boolean', description: '只看发给本会话的（含广播）' },
      project: { type: 'string', description: '只看某个项目的' },
      status: { type: 'string', description: '按状态筛', enum: ['open', 'done'] },
      limit: { type: 'integer', description: '最多返回几条' },
    },
    execute: inboxList,
  },
  {
    name: 'inbox_close',
    description: '关掉一条请求（追加一条 close 事件，不修改已有行）。可以带一个结果交接的路径。',
    parameters: {
      id: { type: 'string', description: '请求 id（ib_ 开头）', required: true },
      resultRef: { type: 'string', description: '结果交接的路径（可选）' },
    },
    execute: inboxClose,
  },
  {
    name: 'organ_list',
    description:
      '列出已登记的器官（扫插件目录里的 organ.json）：每个器官会什么能力、危险等级、入口类型。器官信息只给需要的人看，不塞进总目录。',
    parameters: {},
    execute: organList,
  },
  {
    name: 'organ_call',
    description:
      '神经系统门口：按名片把一个能力路由到对应器官。entry.type=file 且 sideEffect=read 的能力直读；write/danger 先写 gate 报备给安全插件、拿裁决（超时=拒绝），v0.4 只回裁决、执行器还没接。dryRun=true 时只探路不读文件。',
    parameters: {
      ability: { type: 'string', description: '能力名，例如 chat.send', required: true },
      dryRun: { type: 'boolean', description: '只探路：返回文件是否存在/多大，不返回内容' },
    },
    execute: organCall,
  },
]

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const disposers = []
  const state = {
    runtime: null,
    booting: null,
    sessionId: null,
    sessionIdSource: 'generated',
    degradedLevel: 'normal',
    // 跨会话简报缓存：primer 是同步的，不能在里面读盘。
    // 由 refreshPeerCache() 异步刷新，primer 只读内存。
    peerCache: { projects: [], inboxOpen: 0, latestInbox: null, at: 0 },
  }

  const configIn = { ...(rawConfig ?? {}) }
  const configuredRoot = String(configIn.root ?? '').trim()
  delete configIn.root

  // root 不是 settings.json 的字段（§15.1 的 33 项里没有它）——
  // 它属于「装在哪儿」，由安装位置的 patch 提供，安装器写。
  const FALLBACK_ROOT = path.join(os.homedir(), 'tongwen')

  /**
   * 确保目录存在。
   *
   * 不能无脑 mkdir：Windows 上对盘根（`C:\`）调 mkdir recursive 会报 EPERM，
   * 于是一个本来就存在的盘根被当成「建不出来」，插件白白降级到 C 盘。
   * 先 stat，只有确实不存在才建。
   */
  async function ensureDirectory(target) {
    try {
      const stat = await fsp.stat(target)
      if (!stat.isDirectory()) throw new Error(`不是目录：${target}`)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await fsp.mkdir(target, { recursive: true })
  }

  /**
   * 定档根：配置了就用配置的；没配、或配置的路径根本建不出来
   * （比如别人机器上没有 A 盘），就落到 <主目录>/tongwen。
   * 宁可换个地方建，也不让人装完加载即崩。
   */
  async function resolveUsableRoot() {
    const candidate = configuredRoot || FALLBACK_ROOT
    try {
      await ensureDirectory(candidate)
      return { root: candidate, fallbackFrom: null, defaulted: !configuredRoot }
    } catch (error) {
      if (candidate === FALLBACK_ROOT) throw error
      await ensureDirectory(FALLBACK_ROOT)
      return { root: FALLBACK_ROOT, fallbackFrom: candidate, defaulted: true, cause: error?.message }
    }
  }

  /**
   * 建运行时。失败一次就不再重试，工具会拿到同一份错误。
   * @param {string|null} sessionId
   * @param {'host'|'generated'} sessionIdSource
   */
  async function bootstrap(sessionId, sessionIdSource) {
    const rootChoice = await resolveUsableRoot()
    const pluginCtx = createContext(rootChoice.root)

    // settings.json 只读、启动读一次（§11.4）
    let settings = {}
    try {
      settings = JSON.parse(await fsp.readFile(pluginCtx.settingsFile, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') settings = {}
    }
    const merged = { ...settings, ...configIn }
    const { values, issues } = resolveConfig(merged)

    const writer = new AuditWriter({ root: pluginCtx.root, config: values })

    for (const issue of issues) {
      if (issue.kind === 'unknownField') {
        await writer.write({ op: 'config.unknownField', target: issue.field, result: 'warn' })
      } else {
        await writer.write({ op: 'config.invalid', target: issue.field ?? 'settings.json', result: 'warn', note: issue.reason })
      }
    }

    const effectiveSessionId = sessionId || generatedSessionId()
    const startup = await runStartup({
      ctx: pluginCtx,
      writer,
      config: values,
      pluginVersion: PLUGIN_VERSION,
      sessionId: effectiveSessionId,
      sessionIdSource: sessionId ? sessionIdSource : 'generated',
    })

    if (rootChoice.defaulted && startup.ok) {
      const why = rootChoice.fallbackFrom
        ? `配置的 root 建不出来（${rootChoice.fallbackFrom}${rootChoice.cause ? '：' + rootChoice.cause : ''}），`
        : '没有配置 root，'
      startup.warnings = [
        ...(startup.warnings ?? []),
        `${why}九档建在了 ${pluginCtx.root}。要换地方，改 cordis.patch.yml 里的 root。`,
      ]
    }

    if (!startup.ok) {      return {
        ctx: pluginCtx,
        writer,
        config: values,
        configIssues: issues,
        runtimeState: null,
        index: null,
        sessionId: effectiveSessionId,
        sessionIdSource: sessionId ? sessionIdSource : 'generated',
        degradedLevel: writer.level,
        currentTask: null,
        startup,
        fatal: true,
      }
    }

    state.degradedLevel = writer.level
    return {
      ctx: pluginCtx,
      writer,
      config: values,
      configIssues: issues,
      runtimeState: startup.runtimeState,
      index: startup.index,
      sessionId: effectiveSessionId,
      sessionIdSource: sessionId ? sessionIdSource : 'generated',
      degradedLevel: writer.level,
      // 同一会话异常重启时，任务上下文会从 runtime-state 里带回来，end_task 才接得上。
      currentTask: startup.runtimeState?.currentTask ?? null,
      startup,
      fatal: false,
    }
  }

  /**
   * 懒初始化：工具可能在 session 事件前后被调用，统一走这里。
   */
  function ensureRuntime() {
    if (state.runtime) return Promise.resolve(state.runtime)
    if (!state.booting) {
      state.booting = bootstrap(state.sessionId, state.sessionIdSource)
        .then((runtime) => {
          state.runtime = runtime
          // 首次把跨会话简报缓存填上（失败静默，简报少两行不算事故）
          refreshPeerCache().catch(() => {})
          return runtime
        })
        .catch((error) => {
          state.booting = null
          throw error
        })
    }
    return state.booting
  }

  /**
   * 工具执行的外壳：保证 runtime 已就绪，并把异常折成统一返回。
   * @param {(runtime: object, args: object) => Promise<object>} fn
   */
  function wrap(fn) {
    return async (args) => {
      let runtime
      try {
        runtime = await ensureRuntime()
      } catch (error) {
        return {
          ok: false,
          sessionId: state.sessionId ?? null,
          effectiveTaskKey: null,
          idempotency: 'unavailable',
          degradedLevel: 'L2',
          errorCode: 'E_IO',
          message: String(error?.message ?? error),
        }
      }
      if (runtime.fatal) {
        return envelope(runtime, {
          ok: false,
          errorCode: 'E_VALIDATION_BLOCKING',
          message: `插件未能正常启动：${runtime.startup?.notes?.join('；') ?? '未知原因'}`,
        })
      }
      runtime.degradedLevel = state.degradedLevel
      try {
        const result = await fn(runtime, args ?? {})
        // 工具可能改了项目白板或信箱，刷一下简报缓存（失败静默）
        refreshPeerCache().catch(() => {})
        return result
      } catch (error) {
        return failure(runtime, error)
      }
    }
  }

  // 工具注册
  for (const spec of TOOL_SPECS) {
    try {
      ctx.tools.register({
        name: spec.name,
         description: Array.isArray(spec.description)
          ? spec.description.join('\n')
          : String(spec.description ?? ''),
        parameters: compileParameters(spec.parameters),
        output: {
          schema: {},
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        timeoutMs: 60000,
        execute: wrap(spec.execute),
      })
    } catch (error) {
      recordApplyError(`tools.register:${spec.name}`, error)
    }
  }

  // ---- 系统级注入（§12）：不作普通 user 消息 ----
  const buildPrimer = (runtime) => {
    if (!runtime) return '【书同文车同轨】插件初始化中…'
    // 开场每轮都带：按会话 id 只带一次会赌宿主时序（新会话的系统提示
    // 常常在 session/created 之前就拼好了），赌输一次新时空就白跑。
    const rootLine = `交接根目录：${runtime.ctx?.root ?? '（未配置）'}（下面所有 handoff/... 都相对它；换盘/换电脑以这里为准，别猜）`
    const lines = [
      '【书同文车同轨】本会话已启用统一收纳与交接规则。',
      '',
      '开场（每轮都带；先做完这几步，再回用户第一句）：',
      '不是等用户提起才生效——不管用户第一句话说什么，本插件和这套交接规则都在这。',
      rootLine,
      '⓪ 先看 handoff/README.md 顶部的「⚠ 挂账」段和 handoff/项目总览.md 的挂账列——有坑先认领，别等踩到才发现；',
      '① 再读 handoff/README.md（总目录按权重排：⚠挂账 → 一·文件 二·插件 三·工具 四·A盘 五·在办 六·清单）；接活前再读 handoff/项目总览.md（几个项目、各自到哪一步、最近加了什么）；细则在 handoff/索引/ 下四页（文件/插件/工具/A盘目录），按需再点；',
      '② 交接按**项目**找，不要一份份翻：看 handoff/README.md「五 · 在办」——每个项目下面有一行「当前交接：<文件>」。用用户的话或任务名对出自己接哪个项目，**只读那一份**（先 machine 版；头两行就写着「项目」「交给」，对不上就不是给你的）；对不出来就直接问用户「我是来接哪个项目的？」，别猜。要查更旧的再看 handoff/索引/交接索引.md（顶部「按项目看」一节）；其它交接知道存在就行，不要逐个打开；',
      '③ 白板在 handoff/projects/，只读「当前一棒」相关的项目；做完了再从总目录看还要不要接别的；',
      '④ 路径不确定就 locate / inspect_handoff，别猜；只在上面那个根目录里找，别在别处翻旧交接（比如工作区根上的旧 HANDOFF.md）；',
      '⑤ 要写教训就写 handoff/教训日记/<日期>-<主题>.md；要更新这台电脑的状态就改 handoff/任务交接本/当前状态.md；',
      '⑥ 不确定自己会不会某件事（Office、文档、绘图、浏览器自动化等），先看 handoff/能力目录.md 里有没有现成技能；里面没有的再用 market_search 现找现装；',
      '⑦ 收尾前写一份日档 self/日档/<日期>-<时空名>.md（五段：触点/我的想/变/我的回/回声）；QQ 聊天时空写 self/diary/ 日记，不写日档。',
      '',
    ]
    lines.push(
      '硬规则：',
      '① 顶层只有 9 档（handoff / created / downloads / incoming / scratch / archive / logs / config / self），不新建档，不删除、移动、改名、改权限顶层档本身。',
      '② 写文件前路径不确定，先调 locate 或 inspect_handoff 查证，不要猜。',
      '③ 每次任务结束，机器版与用户版交接同时产出。',
      '④ 删除一律软删进 archive/trash；scratch 真删要先问人。',
      '⑤ 这次意图和上次方向冲突时，挂起问人，不自己选。',
      '',
      '现状：',
      ...summarizeStartup(runtime),
      ...summarizePeers(),
      '',
      '可用工具：locate / inspect_handoff / list_handoffs / update_handoff / begin_task / end_task / heartbeat / restore / archive_handoff / rollback_data / housekeeping_report / project_upsert / project_read / project_list / inbox_send / inbox_list / inbox_close',
    )
    return lines.join('\n')
  }

  /**
   * 跨会话简报（两行）。没内容就整行省略。
   *
   * 0.4.4：项目数改成**每轮从磁盘现数**（十来个文件名，代价可忽略）。
   * 以前只读最近一次异步刷新的 peerCache，会跟 project_list 对不上
   * （主人抓到「开场 13 个 / 实际 14 个」就是这么来的）。
   *
   * @returns {string[]}
   */
  function summarizePeers() {
    const cache = state.peerCache
    const out = []
    const fresh = freshProjects()
    if (fresh.length > 0) {
      const latest = fresh[0]
      const known = cache.projects.find((item) => item.id === latest.id)
      const stateText = known?.status ? ` · ${known.status}` : ''
      const baton = known?.baton ? ` · 当前一棒给 ${known.baton}` : ''
      out.push(`- 项目：${fresh.length} 个（最近：${latest.id}${stateText}${baton}）`)
    } else if (cache.projects.length > 0) {
      const latest = cache.projects[0]
      const baton = latest.baton ? ` · 当前一棒给 ${latest.baton}` : ''
      out.push(`- 项目：${cache.projects.length} 个（最近：${latest.id} · ${latest.status}${baton}）`)
    }
    if (cache.inboxOpen > 0) {
      const latestFrom =
        cache.latestInbox?.from?.instance || cache.latestInbox?.from?.sessionId || '某个会话'
      const text = String(cache.latestInbox?.request ?? '').replace(/\s+/g, ' ').slice(0, 60)
      out.push(`- 给你的请求：${cache.inboxOpen} 条；最近：${latestFrom}：${text}`)
    }
    return out
  }

  /**
   * 从磁盘现数在办项目（`handoff/projects/` 顶层 .md，不含 done/）。
   * 读不到就返回空，让调用方退回缓存——简报少一行不算事故。
   *
   * @returns {Array<{id: string, mtime: number}>}
   */
  function freshProjects() {
    const dir = state.runtime?.ctx?.projectsDir
    if (!dir) return []
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => ({ id: name.slice(0, -3), mtime: statSync(path.join(dir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    } catch {
      return []
    }
  }

  /**
   * 刷新跨会话简报缓存。失败静默（简报少两行不算事故，不能因为读不到就崩）。
   */
  async function refreshPeerCache() {
    const runtime = state.runtime
    if (!runtime || runtime.fatal) return
    try {
      const projects = await listProjects(runtime.ctx.projectsDir)
      const { records } = await readInbox(runtime.ctx.inboxFile)
      const { items } = mergeInbox(records)
      const open = [...items.values()]
        .filter((item) => item.status === 'open' && (item.to === runtime.sessionId || item.to === 'any'))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      state.peerCache = {
        projects: projects.filter((p) => p.status !== 'done'),
        inboxOpen: open.length,
        latestInbox: open[0] ?? null,
        at: Date.now(),
      }
    } catch {
      // 静默
    }
  }

  /** @param {object} runtime */
  function summarizeStartup(runtime) {
    if (runtime.fatal) return [`- 启动失败：${runtime.startup?.notes?.join('；') ?? '未知原因'}`]
    const out = []
    if (runtime.ctx?.root) out.push(`- 交接根目录：${runtime.ctx.root}`)
    // 新时空常见的两个「不敢」：不知道自己能重启、不知道重启入口只有一个。
    // 直接写进现状，省得每个时空自己翻手册（0.4.4）。
    out.push('- 你自己会的事：按 `handoff/规范/重启.md` 可以发起一次延时重启——先回一句「马上重启」，再执行本机约定的延时重启脚本（不同机器不一样，别直接杀进程、也别用 Start-Process/WMI 起延时脚本）；重启后 GUI 端口会变')
    const presence = runtime.startup?.presence
    if (presence) {
      out.push(`- 九档：${presence.present?.length ?? 0} 档在位${presence.missing?.length ? `，缺失 ${presence.missing.join('、')}` : ''}${presence.notWritable?.length ? `，不可写 ${presence.notWritable.join('、')}` : ''}`)
    }
    const index = runtime.startup?.index
    if (index) out.push(`- 索引：${index.entries?.length ?? 0} 条记录，${index.types?.length ?? 0} 个类型`)
    const openItems = runtime.startup?.openItems
    if (openItems) {
      out.push(`- 未闭环项：${openItems.total ?? 0} 项`)
    }
    if (runtime.startup?.version?.status && runtime.startup.version.status !== 'ok') {
      out.push(`- 版本：${runtime.startup.version.status}（${runtime.startup.version.note ?? ''}）`)
    }
    if (runtime.startup?.warnings?.length) {
      out.push(`- 提示：${runtime.startup.warnings.slice(0, 3).join('；')}`)
    }
    return out.length > 0 ? out : ['- 一切正常']
  }

  const primer = () => buildPrimer(state.runtime)
  try {
    disposers.push(
      ctx.systemPrompt.context({
        name: 'tongwen-tonggui-contract',
        order: 900,
        text: primer,
      }),
    )
  } catch (error) {
    recordApplyError('systemPrompt.context', error)
    try {
      disposers.push(
        ctx.systemPrompt.section({
          name: 'tongwen-tonggui-contract',
          order: 900,
          text: primer,
        }),
      )
    } catch (fallbackError) {
      recordApplyError('systemPrompt.section', fallbackError)
    }
  }

  // ---- 宿主动作 ----
  try {
    disposers.push(
      ctx.on('session/created', async (session) => {
        const id = typeof session?.id === 'string' ? session.id : session?.id != null ? String(session.id) : null
        if (!id) return
        state.sessionId = id
        state.sessionIdSource = 'host'
        await ensureRuntime().catch(() => {})
      }),
    )
  } catch (error) {
    recordApplyError('on:session/created', error)
  }

  try {
    disposers.push(
      ctx.on('session/disposed', async () => {
        const runtime = state.runtime
        if (!runtime || runtime.fatal) return
        try {
          await runSessionEnd({
            ctx: runtime.ctx,
            writer: runtime.writer,
            config: runtime.config,
            runtimeState: runtime.runtimeState,
            index: runtime.index,
          })
        } catch {
          // 收尾失败不抛给宿主
        }
      }),
    )
  } catch (error) {
    recordApplyError('on:session/disposed', error)
  }

  // ---- 心跳 ----
  try {
    const timerService = typeof ctx.get === 'function' ? ctx.get('timer') : ctx.timer
    if (timerService?.interval) {
      const interval = Number(rawConfig?.['heartbeat.intervalMs'] ?? 60000)
      disposers.push(
        timerService.interval(async () => {
          const runtime = state.runtime
          if (!runtime || runtime.fatal) return
          runtime.runtimeState.lastHeartbeatAt = new Date().toISOString()
          // 心跳必须落盘：进程被硬杀时，补记只能靠文件里的 lastHeartbeatAt 推算
          // 窗口终点。只跳在内存里，重启后看到的心跳永远停在 startedAt，补记窗口
          // 就会塌成「（无记录）」。写失败静默（§4.9 heartbeat 归类为静默）。
          writeRuntimeState(runtime.ctx.runtimeStateFile, runtime.runtimeState).catch(() => {})
          // 顺带刷新跨会话简报（别的会话可能刚写了白板或信箱）
          refreshPeerCache().catch(() => {})
        }, Math.max(5000, interval)),
      )
    }
  } catch (error) {
    recordApplyError('timer.interval', error)
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.()
      } catch {
        // 忽略
      }
    }
  }
}

