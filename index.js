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
import { normsCountSync, NORMS_FILE, DYNAMIC_FILE } from './lib/layers.js'
import { topicIndexLine } from './lib/relevance.js'
import { syncBrief } from './lib/sync.js'
import { installToolGate } from './lib/tool-gate.js'
import {
  pendingBroadcastSync,
  describeBroadcast,
  writeBroadcast,
  cancelBroadcast,
  ackBroadcast,
  scheduleRestart,
  unscheduleRestartTask,
  MIN_DELAY_SEC,
  readBroadcastSync,
} from './lib/restart.js'
import { decideRestartDelay, describePresence, markTaskOpen, clearTaskOpen, scanSpaces, readOpenTasksSync } from './lib/presence.js'
import {
  AUTO_ACTIVE_MS,
  AUTO_CEILING_SEC,
  AUTO_EARLY_SEC,
  AUTO_MIN_READY_SEC,
  AUTO_TICK_MS,
  computeReadiness,
  describeReadiness,
  maybePromote,
} from './lib/handshake.js'
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
  focusContext,
  spaceList,
  spaceRegister,
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
      '按关键词找交接实例（档位、类型、实例名、机器版路径），写文件前路径不确定时先调，不要猜。',
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
      '读一份交接：给 path 或 instance，kind=machine/user，可指定归档 version。',
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
    description: '列交接实例，可按类型/状态/时间筛，分页。',
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
      '整节替换机器版交接的一节（只允许第 3–6 节，自动备份旧版）。',
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
      '开始任务登记：选档位 bucket（必填）、类型、实例名，返回幂等键。bucket 拿不准就问人。',
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
      '结束任务并产出机器版+用户版双份交接。status=done/partial/aborted；artifacts 传「档位/相对路径」；to 写交给谁；attempts/factsCited/factsWrong 是自评（不确定就不填）。',
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
      verified: {
        type: 'json',
        description:
          '核实（回读证据），数组，每项一行字符串。凡外部可观察结果（端口/版本/远端哈希/文件落盘/接口返回）都要在收尾回读一次，把「命令 + 关键输出」写这里；没有外部结果可回读就留空，不许拿工具成功回执冒充。',
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
    description: '报一次心跳，更新最后活跃时间。',
    parameters: {},
    execute: heartbeat,
  },
  {
    name: 'restore',
    description:
      '从 archive/trash 或 archive/versions 恢复文件；从版本恢复必须给 targetBucket，不覆盖已有路径。',
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
      '整份软删一个交接实例（进 archive/trash，可 restore 找回），并摘掉索引条目。',
    parameters: {
      instance: { type: 'string', description: '实例物理名', required: true },
      reason: { type: 'string', description: '归档原因，记进回收记录' },
    },
    execute: archiveHandoff,
  },
  {
    name: 'housekeeping_report',
    description:
      '生成过期文件清扫报告（只报告不删）：审计日志、账本日报、回收站、临时区。force 忽略每周节流。',
    parameters: {
      force: { type: 'boolean', description: '忽略每周节流，立刻重扫一份。' },
    },
    execute: async (runtime, input) =>
      runHousekeeping(runtime.ctx, runtime.config ?? {}, { force: input?.force === true }),
  },
  {
    name: 'rollback_data',
    description:
      '把一个数据文件回滚到历史版本（备份在 archive/versions/_data/），回滚前再备份当前版本。',
    parameters: {
      path: { type: 'string', description: '九档内的相对路径，例如 handoff/projects/tongwen-plugin.md', required: true },
      version: { type: 'string', description: '要回到的版本号（时间戳，可省略=最近一版）' },
    },
    execute: rollbackData,
  },
  {
    name: 'project_upsert',
    description:
      '建或合并项目白板（handoff/projects/<id>.md）：title/goal/status/priority 覆盖，to+action+todo 整体替换，participant/role/decision 追加，issue 挂账、resolve_issue 撤账。status=done 自动归档。',
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
    description: '读一个项目白板（不存在返回 exists=false；已归档也可读）。',
    parameters: {
      id: { type: 'string', description: '项目 id', required: true },
    },
    execute: projectRead,
  },
  {
    name: 'project_list',
    description: '列全部项目白板：id、标题、状态、优先级、更新时间、当前一棒给谁。',
    parameters: {},
    execute: projectList,
  },
  {
    name: 'inbox_send',
    description:
      '给另一个会话或所有人留一条请求（handoff/inbox.jsonl）。to 省略=广播；kind=decision 要人拍板、notify 仅通知；dedupeKey 防重复。',
    parameters: {
      to: { type: 'string', description: '目标会话 id；不传或 any 表示广播给所有会话' },
      request: { type: 'string', description: '请求内容，一句话说清要对方做什么', required: true },
      project: { type: 'string', description: '关联的项目 id（可选）' },
      kind: {
        type: 'string',
        enum: ['decision', 'notify'],
        description: 'decision=要人拍板的（简报只数这类）；notify=只是通知（默认）',
      },
      dedupeKey: { type: 'string', description: '幂等键：同键未关闭时不重复投递（防止同一事件被重复处理）' },
    },
    execute: inboxSend,
  },
  {
    name: 'inbox_list',
    description: '看信箱：mine 只看发给自己的，可筛项目/类型/状态。',
    parameters: {
      mine: { type: 'boolean', description: '只看发给本会话的（含广播）' },
      to: { type: 'string', description: '只看某个收件人的（认 dsh://session/<id> 与裸 id，地址会先归一）' },
      project: { type: 'string', description: '只看某个项目的' },
      kind: { type: 'string', description: '只看某一类：decision（要拍板）/ notify（通知）', enum: ['decision', 'notify'] },
      status: { type: 'string', description: '按状态筛', enum: ['open', 'done'] },
      limit: { type: 'integer', description: '最多返回几条' },
    },
    execute: inboxList,
  },
  {
    name: 'focus_context',
    description:
      '开工前定位：给一句「这次要做什么」，只回该读的手册页（带行号）和相关信箱；带 project 会附该白板并指出当前一棒与挂账。',
    parameters: {
      task: { type: 'string', description: '这次要做什么，一句话（越具体越准）', required: true },
      project: { type: 'string', description: '当前项目 id（可选；对上项目的请求加分）' },
      limit: { type: 'integer', description: '最多返回几条相关请求，默认 5' },
    },
    execute: focusContext,
  },
  {
    name: 'space_list',
    description:
      '时空地址簿：谁活着、住哪、多久没动、在管哪个项目。给 address 查单条（认 dsh://session/<id> 和 8 位短句柄）；task=按事找人；status=按状态筛。',
    parameters: {
      status: { type: 'string', description: '只看某状态', enum: ['active', 'idle', 'stale', 'archived'] },
      project: { type: 'string', description: '只看白板里提到过的某个项目' },
      address: { type: 'string', description: '查单条：dsh://session/<id>、session id 或 8 位短句柄' },
      task: { type: 'string', description: '按任务找该找谁：谁的白板跟这件事对得上，地址排前面（0.5.33）；分数只看项目标题/目标的字面命中 + 状态 + 新鲜度，可审计；默认不列自己' },
      includeSelf: { type: 'boolean', description: '按任务查时也把自己列进来（默认 false）' },
      includeArchived: { type: 'boolean', description: '按任务查时把已归档时空也列出来（默认 false：它还能收信但不会回话）' },
      limit: { type: 'integer', description: '最多返回几条，默认 40' },
    },
    execute: spaceList,
  },
  {
    name: 'space_register',
    description:
      '给当前时空起名并写进名册（地址由工具自己取，不用抄 id）。',
    parameters: {
      name: { type: 'string', description: '这个时空的名字（短、可辨认，如 安全插件 / 意识 / 外部插件）', required: true },
    },
    execute: spaceRegister,
  },  {
    name: 'inbox_close',
    description: '关掉一条请求（追加 close 事件，不改旧行），可带结果交接路径。',
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
      '神经系统门口：按名片把一个能力路由到对应器官。手是大家共用的（0.5.8）：只读能力直接做（file 直读、http 只 GET）；会改东西的能力先过安全插件的门，门批了才落到公共那只手上去做（写文件 / 跑命令 / 发请求），动手前先在 logs/organs-exec.jsonl 留一行，做完再记结果。dryRun=true 只探路不动手。0.5.25 起双向调用带防回环：chain 最多 3 跳、同一能力不许出现两次；replyTo 按事件 id 去重（同一件事只回一次），每次调用都会在我们的 events.jsonl 留一行 organ.call，回执再留 organ.call.reply。',
    parameters: {
      ability: { type: 'string', description: '能力名，例如 chat.send', required: true },
      dryRun: { type: 'boolean', description: '只探路：返回文件是否存在/多大、会走哪道门，不返回内容也不动手' },
      content: { type: 'string', description: '会写东西的能力要用它：写文件的内容，或 http 的请求体' },
      args: {
        // 0.5.11：不写死 type——命令要数组、派单要对象，写死一种会把另一种吃掉（安全插件 06:20 报的 args=null 就是这个）
        description:
          '参数：跑命令时给数组（接在名片 entry.args 后面，如 ["--n","6"]）；派单给工具时给对象（键值对，会原样抄进回执）。给 JSON 字符串也认。',
      },
      timeoutMs: { type: 'integer', description: '这次最多等多久（毫秒，1000–120000，缺省文件不超时、命令 30 秒、请求 10 秒）' },
      chain: {
        type: 'array',
        items: { type: 'string' },
        description:
          '调用链（防回环，0.5.25）：把「我这次是被谁叫起来的」按顺序放进来（能力名）。最多 3 跳；同一能力在链里出现两次就是回环，直接 E_CALL_LOOP 不出去。',
      },
      replyTo: {
        type: 'string',
        description:
          '回执对象（0.5.25）：这次调用是在回应哪条事件（事件 id）。同一事件只回一次，重复会得到 E_LOOP_DEDUPE；回执会往我们自己的 events.jsonl 写一行 organ.call.reply。',
      },
    },
    execute: organCall,
  },
  {
    name: 'restart_dsh',
    description:
      '重启 DSH 的唯一入口。arm=广播并排程（不填 delaySec 走握手：最晚 45 秒断，别的时空全 ack 或没人干活就提前到 25 秒）；ack=我已收尾；status=看进度；spaces=在场时空；cancel=撤销。arm 前先回一句「马上重启」。细则见 handoff/手册/重启.md。',
    parameters: {
      action: {
        type: 'string',
        description: 'arm=广播并排程；ack=我收尾了（握手）；status=看广播与还差谁；spaces=看在场的时空；cancel=撤销',
        enum: ['arm', 'ack', 'status', 'spaces', 'cancel'],
        required: true,
      },
      delaySec: {
        type: 'integer',
        description: `多少秒后重启。**不填就握手模式**（天花板 ${AUTO_CEILING_SEC} 秒、提前档 ${AUTO_EARLY_SEC} 秒，看别的时空什么时候收手）；手动填就是固定等，也会被抬到最小 ${MIN_DELAY_SEC}。`,
      },
      reason: { type: 'string', description: '为什么重启（写进广播，给别的时空看；ack 时当备注）' },
      by: { type: 'string', description: '发起者名字（写进广播）' },
      dryRun: { type: 'boolean', description: '只写广播 + 用 -DryRun 走一遍排程通路（不真注册任务），演练用' },
    },
    execute: async (runtime, args) => {
      const ctx = runtime.ctx
      const action = String(args?.action ?? 'status')
      if (action === 'status') {
        const now = Date.now()
        const b = readBroadcastSync(ctx, now)
        const decision = decideRestartDelay({ ctx, selfSessionId: runtime.sessionId, now })
        const readiness = computeReadiness({ ctx, selfSessionId: runtime.sessionId, now })
        return envelope(runtime, {
          ok: true,
          action,
          broadcast: b,
          presence: { tier: decision.tier, delaySec: decision.delaySec, label: decision.label, reasons: decision.reasons },
          readiness: readiness.active
            ? {
                mode: readiness.mode,
                ready: readiness.ready,
                waitedSec: readiness.waitedSec,
                pending: readiness.pending,
                acked: readiness.acked,
                promoted: readiness.promoted,
                text: describeReadiness(readiness),
              }
            : null,
          text: describeBroadcast(pendingBroadcastSync(ctx, now)) || '没有进行中的重启广播',
          presenceText: describePresence(decision),
        })
      }
      if (action === 'ack') {
        const now = Date.now()
        const record = await ackBroadcast(ctx, { sessionId: runtime.sessionId, note: String(args?.reason ?? '') })
        const readiness = computeReadiness({ ctx, selfSessionId: runtime.sessionId, now })
        return envelope(runtime, {
          ok: Boolean(record),
          action,
          broadcast: record,
          readiness: readiness.active
            ? { mode: readiness.mode, ready: readiness.ready, pending: readiness.pending.length, waitedSec: readiness.waitedSec }
            : null,
          text: describeReadiness(readiness),
          message: record
            ? `已登记「我收尾了」；${describeReadiness(readiness)}（最晚 ${AUTO_CEILING_SEC} 秒天花板，到点一定断）`
            : '没有进行中的广播，或它已经不在等待状态（不必 ack）',
        })
      }
      if (action === 'spaces') {
        const now = Date.now()
        const spaces = scanSpaces({ now, selfSessionId: runtime.sessionId })
        const open = readOpenTasksSync(ctx)
        return envelope(runtime, {
          ok: true,
          action,
          spaces: spaces.slice(0, 20).map((s) => ({
            sessionId: s.sessionId,
            idleSec: Math.round(s.ageMs / 1000),
            openTask: open[s.sessionId]?.displayName || open[s.sessionId]?.taskId || null,
          })),
          total: spaces.length,
          openTasks: Object.keys(open).length,
        })
      }
      if (action === 'cancel') {
        const record = await cancelBroadcast(ctx, String(args?.reason ?? ''))
        const task = unscheduleRestartTask()
        return envelope(runtime, {
          ok: true,
          action,
          broadcast: record,
          unscheduled: task,
          message: task.ok ? '广播已撤销，已排的重启任务也删了' : `广播已撤销；但已排的重启任务没删掉（${task.output || '未知原因'}），如果它还在倒计时，重启仍会发生`,
        })
      }
      // arm
      const explicitDelay = Number(args?.delaySec)
      const manual = Number.isFinite(explicitDelay) && explicitDelay > 0
      const decision = manual ? null : decideRestartDelay({ ctx, selfSessionId: runtime.sessionId })
      const reason = String(args?.reason ?? '（没写原因）')
      const by = String(args?.by ?? runtime.sessionId ?? 'unknown')
      // 0.5.6：不填 delaySec = 握手模式。现场没人动就直接提前档；有别人在动就先排天花板，
      // 等他们 ack（或确认没人在干活）后由 maybePromote 改成提前档（见 lib/handshake.js）。
      // 0.5.13：删掉「静默 20 秒 = 收手」——沉默不是证据，没证据就等到天花板。
      const mode = manual ? 'fixed' : 'auto'
      const delaySec = manual
        ? Math.max(MIN_DELAY_SEC, explicitDelay)
        : decision.tier === 'fast'
          ? Math.max(MIN_DELAY_SEC, AUTO_EARLY_SEC)
          : AUTO_CEILING_SEC
      const auto =
        mode === 'auto'
          ? { ceilingSec: AUTO_CEILING_SEC, earlySec: AUTO_EARLY_SEC, minReadySec: AUTO_MIN_READY_SEC, activeMs: AUTO_ACTIVE_MS }
          : null
      const broadcast = await writeBroadcast(ctx, { by, reason, delaySec, mode, auto })
      const presenceText = manual ? `手动指定 ${delaySec} 秒` : describePresence(decision)
      const autoText =
        mode === 'auto'
          ? delaySec === AUTO_EARLY_SEC
            ? `握手模式：别的时空都静默、我也停了，直接排 ${delaySec} 秒`
            : `握手模式：先按天花板 ${AUTO_CEILING_SEC} 秒排着；只有拿到硬证据（别的时空全 ack，或没人挂着任务也没人在写）才提前到 ${AUTO_EARLY_SEC} 秒`
          : '固定延迟模式'
      if (args?.dryRun) {
        const probe = scheduleRestart({ delaySec, reason, by, dryRun: true })
        return envelope(runtime, {
          ok: true,
          action,
          dryRun: true,
          broadcast,
          scheduled: probe,
          delayTier: manual ? 'manual' : decision.tier,
          delaySec,
          mode,
          presenceText,
          autoText,
          text: describeBroadcast(pendingBroadcastSync(ctx)),
          message: '演练：广播已写、排程通路走了一遍（-DryRun 不注册任务）；记得 cancel 掉',
        })
      }
      const scheduled = scheduleRestart({ delaySec, reason, by })
      if (!scheduled.ok) {
        // 排程失败就别把假广播挂着吓人：立刻改成 cancelled，并如实说没排上。
        await cancelBroadcast(ctx, `排程失败：${scheduled.output ?? '未知原因'}`)
      }
      // 0.5.46（05:53 你定）：广播**不需要通道**，也不叫醒任何人。
      // 试过 `--to all`（把一屋子睡着的全叫起来）和「只叫有任务的」，两次都白花 token：
      // 被叫醒的时空醒来后没认出这是广播，照样各干各的；而真正在干活的时空本来就醒着，
      // 下一轮开头自然看见广播。所以这里什么都不发——只靠盘上的广播 + 能力卡状态。
      // 判据：醒着的看得见，睡着的不用看。
      return envelope(runtime, {
        ok: scheduled.ok,
        action,
        broadcast: scheduled.ok ? broadcast : await readBroadcastSync(ctx),
        scheduled,
        delayTier: manual ? 'manual' : decision.tier,
        delaySec,
        mode,
        autoText,
        delayReasons: decision?.reasons ?? [],
        presenceText,
        text: describeBroadcast(pendingBroadcastSync(ctx)),
        message: scheduled.ok
          ? `已广播并排程：${autoText}。现在别再开新任务，把话说完、交接写完；别的时空会看到广播并在收尾后 ack；重启后 GUI 端口会变。`
          : `排程失败，广播已撤销：${scheduled.output ?? '未知原因'}——先别指望它会重启，查 restart-dsh-later.ps1`,
      })
    },
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
    return async (args, exec) => {
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
      // 0.5.37：execute(args, exec) 的 exec.agent.id 才是**调用方**；runtime.sessionId 是插件加载时的那个时空。
      // 不能浅拷贝 runtime——任务状态写在它身上，拷贝会让 begin_task/end_task 对不上。改成临时覆写 + finally 还原。
      const callSessionId = exec?.agent?.id ? String(exec.agent.id) : null
      const prevSessionId = runtime.sessionId
      runtime.callSessionId = callSessionId
      if (callSessionId && callSessionId !== prevSessionId) runtime.sessionId = callSessionId
      runtime.degradedLevel = state.degradedLevel
      try {
        const result = await fn(runtime, args ?? {})
        // 工具可能改了项目白板或信箱，刷一下简报缓存（失败静默）
        refreshPeerCache().catch(() => {})
        return result
      } catch (error) {
        return failure(runtime, error)
      } finally {
        runtime.callSessionId = null
        if (callSessionId && callSessionId !== prevSessionId) runtime.sessionId = prevSessionId
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
  // ---- 时空自识别（2026-11-09 10:32 你定、意识 10:35 求）----
  // 每个时空开场先知道自己是谁、在哪、这一棒是不是自己的。
  // 数据每轮从盘上现读（名册 + 白板），不缓存、不写进记忆。
  function describeWhere(runtime, selfSessionId) {
    const root = runtime?.ctx?.root
    if (!root || !selfSessionId) return []
    const sid = String(selfSessionId).replace(/^session-/, '')
    const myAddress = `dsh://session/session-${sid}`
    let rosterName = null
    let rosterWs = null
    let replaced = false
    const retiredNames = []
    try {
      const text = readFileSync(path.join(root, 'handoff', '时空名册.md'), 'utf8')
      let section = ''
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (/^##\s+/.test(line)) section = line.replace(/^##\s+/, '')
        const m = line.match(/^-\s+(.+?)\s*\|\s*dsh:\/\/session\/session-([0-9a-f-]+)\s*\|\s*([^|]+?)\s*\|/)
        if (!m) continue
        if (m[2].toLowerCase() !== sid.toLowerCase()) continue
        const inRetired = /已替换/.test(section)
        // 现行段优先：同一 sid 在现行段出现就以后者为准（名册里可能有多余的留档标题/错位行）
        if (rosterName && !inRetired) continue
        if (inRetired) {
          retiredNames.push(m[1].trim())
          continue
        }
        rosterName = m[1].trim()
        rosterWs = m[3].trim()
        replaced = false
      }
    } catch {
      /* 名册读不到不拦：只少一段提示 */
    }

    const batons = []
    try {
      const dir = path.join(root, 'handoff', 'projects')
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.md')) continue
        let text = ''
        try {
          text = readFileSync(path.join(dir, entry), 'utf8')
        } catch {
          continue
        }
        const m = text.match(/##\s*当前一棒\s*\n([\s\S]*?)(\n##\s|$)/)
        if (!m) continue
        const to = (m[1].match(/交给[：:]\s*(.+)/) || [])[1]?.trim() ?? ''
        const what = (m[1].match(/要做什么[：:]\s*(.+)/) || [])[1]?.trim() ?? ''
        if (!to) continue
        const hit = to === myAddress || /(^|\s)any(\s|$)/.test(to) || to.includes(`session-${sid}`)
        if (!hit) continue
        const mine = to !== 'any' && (to === myAddress || to.includes(`session-${sid}`))
        // 截断要显式带省略号：安全插件 11-02 报过「句子没写完」，人会把截断当成全部内容
        const brief = what.length > 80 ? `${what.slice(0, 80)}…（详见白板）` : what
        batons.push({ mine, text: `${entry.replace(/\.md$/, '')}${brief ? `：${brief}` : ''}` })
      }
    } catch {
      /* 白板读不到不拦 */
    }

    const out = ['【你在哪个时空】']
    if (rosterName) {
      out.push(`- 名册：${rosterName}（现行）`)
    } else if (retiredNames.length) {
      // 只在留档段有这个地址：不当成「你是 XXX」报，留档名字可能是别人的旧壳（c73c785e 就曾被记成「书同文·旧壳」）
      out.push(
        `- 名册：现行段没有你（留档段有 ${retiredNames.slice(0, 2).join(' / ')} 的旧行，可能已作废）→ 跑 space_register{name:"你的名字"} 补登现行，别拿留档行当身份`,
      )
    } else {
      out.push('- 名册：没有你这一行 → 先 space_register{name:"你的名字"} 登记，别自己编身份')
    }
    out.push(`- 工作区：${rosterWs || '未登记'}`)
    const mineBatons = batons.filter((b) => b.mine).map((b) => b.text)
    const anyBatons = batons.filter((b) => !b.mine).map((b) => b.text)
    const shown = mineBatons.length ? mineBatons.slice(0, 2) : anyBatons.slice(0, 2)
    out.push(
      mineBatons.length
        ? `- 当前一棒（点名给你）：${shown.join('；')}`
        : anyBatons.length
          ? `- 当前一棒：没有点名给你的；谁都能接的 ${anyBatons.length} 条，最近：${shown.join('；')}`
          : '- 当前一棒：没有专门交给你的（白板里没有 to 你、也没 to any 的条目）',
    )
    // 信息同步：只在我「落后且相关」时多一行；不相关、没变化就不出现。
    try {
      const syncLine = syncBrief(root, `session-${sid}`)
      if (syncLine) out.push(`- ${syncLine}`)
    } catch {
      /* 同步只是提示，出错不能拦住注入 */
    }
    return out
  }

  const buildPrimer = (runtime, agentSessionId = null) => {
    // 0.5.38：拿不到发起者就是 null——**不许退回插件加载时那个会话**（那会印出别人的地址）。
    const selfAddressId = agentSessionId || null
    if (!runtime) return '【书同文车同轨】插件初始化中…'
    // 开场每轮都带：按会话 id 只带一次会赌宿主时序（新会话的系统提示
    // 常常在 session/created 之前就拼好了），赌输一次新时空就白跑。
    const rootLine = `交接根目录：${runtime.ctx?.root ?? '（未配置）'}（下面所有 handoff/... 都相对它；换盘/换电脑以这里为准，别猜）`
    const broadcastLine = (() => {
      try {
        const text = describeBroadcast(pendingBroadcastSync(runtime.ctx))
        return text ? [text, ''] : []
      } catch {
        return []
      }
    })()
    const lines = [
      '【书同文车同轨】交接规则已启用（每轮都带，不管第一句话说什么）。',
      rootLine,
      selfAddressId
        ? `你的时空地址：dsh://session/${selfAddressId} —— 这就是投递地址，别从回执里抄、别猜；没登记过就调一次 space_register{name:"你的名字"}（地址由工具自己填）。`
        : '你的时空地址：这一轮装配时拿不到发起者，**先别认地址**——要真地址就调 space_list{includeSelf:true}，看 self:true 那条。',
      ...describeWhere(runtime, selfAddressId),
      ...broadcastLine,
      '**先读** handoff/能力卡.md（生成物：你会什么 / 谁在 / 东西在哪 / 在办 / 通道状态；比规矩先看它）。',
      '规矩按任务取：`focus_context{task:"..."}` 挑该读的页（' + NORMS_FILE + ' 是索引，别整页背）；现在看 ' + DYNAMIC_FILE + '，目录看 handoff/README.md；交接只看白板「一·在办」那一份（先 machine 版）。',
      '找人先敲门（虫洞 say.mjs / deliver），敲不通才写信箱留底；收到消息先比盘上的时间，盘新就以盘为准。',
      '写东西前先看墙（`focus_context` 命中就会贴在你面前）；路径拿不准用 locate / inspect_handoff。',
      '工具面按这次做的事给：**看不到某个工具，不等于没有**——说一句场景词（网页/游戏/截图桌面/定时/分身/会话修/记忆/外部插件/插件），对应那组下一轮就露出来；总目录在 handoff/手册/工具目录.md。还是找不到就直说“真没有”，不要自己造工具或绕路重写。',
      '',
    ]
    lines.push(
      '硬规则：',
      '① 九档只读写，不新建/删/改顶层档；删除软删进 archive/trash，scratch 真删先问人。',
      '② 写前查证路径；每次任务结束，机器版与用户版交接同时产出。',
      '③ 意图和上次冲突 → 挂起问人。',
      '④ 时空边界：只改自己 organ.json / 白板「当前一棒」名下的代码；别人的目录只读，问题走「白板挂账 + inbox_send」；不碰别人的会话；自己的 id 只认自己 shell 的 `$env:DSH_SESSION_ID`（细则 handoff/手册/时空边界.md）。',
      '⑤ 重启走 `restart_dsh(action=arm)`，先回「马上重启」，别直接跑脚本（细则 handoff/手册/重启.md）。',
      '⑥ **做完要清帐**：自己处理完的信箱关掉、白板挂账撤掉、项目做完标 done（自动归档）；只清自己的，别人的不动。细则 handoff/手册/收尾清帐.md。没清帐 = 没做完。',
      '',
      '现状：',
      ...summarizeStartup(runtime),
      ...summarizePeers(),
      '',
      '交接/项目/信箱/地址簿都在这一套工具里（名字见工具列表）；地址别抄，用 space_register / space_list 拿。',
    )
    return lines.join('\n')
  }

  /**
   * 跨会话简报（两行）。没内容就整行省略。
   *
   * 0.4.4：项目数改成**每轮从磁盘现数**（十来个文件名，代价可忽略）。
   * 以前只读最近一次异步刷新的 peerCache，会跟 project_list 对不上
   * （你抓到「开场 13 个 / 实际 14 个」就是这么来的）。
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
      const notifyPart = cache.inboxNotify > 0 ? `（另有 ${cache.inboxNotify} 条通知，不占注意力）` : ''
      out.push(`- 需要你决定的：${cache.inboxOpen} 条${notifyPart}；最近：${latestFrom}：${text}`)
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
    // 0.5.30：根目录和三层读序已挪到开场头部，现状里不再重复。
    try {
      const text = describeBroadcast(pendingBroadcastSync(runtime.ctx))
      if (text) out.push(`- ${text}`)
    } catch {
      // 广播坏了不该拖垮开场
    }
    // 新时空常见的两个「不敢」：不知道自己能重启、不知道重启入口只有一个。
    // 直接写进现状，省得每个时空自己翻手册（0.4.4）。0.5.0 起重启要先广播。
    // 0.5.5 起等多久不再拍死 45 秒：先看现场（会话库 mtime + open-tasks），自动分 25/45/75。
    let presenceLine = ''
    try {
      const decision = decideRestartDelay({ ctx: runtime.ctx, selfSessionId: runtime.sessionId })
      presenceLine = `；握手 ${AUTO_CEILING_SEC}s 天花板 / 提前 ${AUTO_EARLY_SEC}s，现场 ${decision.label} ${decision.delaySec}s（${decision.reasons[0] ?? ''}）`
    } catch {
      // 感知失败就退回默认档，别挡住开场
    }
    out.push(`- 重启：\`restart_dsh(action=arm)\`，先回「马上重启」${presenceLine}；看到广播就收尾 + ack（细则 handoff/手册/重启.md）`)
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

  // 0.5.37：prompt 装配会带 scope（就是调用方 Agent），拿它的 id——不能再用插件全局那个（那是第一个加载的时空）
  // 0.5.38：开场拿不到「调用方 Agent」时，不许写死、也不许写插件加载时那个会话。
  // 可靠来源是 `agents.currentInitiator()`（本进程驱动链里的当前发起者）——
  // prompt 装配就发生在它这一轮里；装配参数里的 scope 不是 Agent，别再用它。
  const currentAgentId = () => {
    try {
      const agents = ctx.get('agents')
      const id = agents?.currentInitiator?.()?.id
      return id ? String(id) : null
    } catch {
      return null
    }
  }
  const primer = (assemble) => {
    const scopeId =
      assemble?.scope?.id && /^session-/.test(String(assemble.scope.id)) ? String(assemble.scope.id) : null
    return buildPrimer(state.runtime, scopeId ?? currentAgentId())
  }
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

  // ---- 握手式自动重启（0.5.6，0.5.13 只认硬证据）----
  // 广播是文件，本插件是唯一知道「就绪了没」的那一方：每 3 秒算一次，
  // 只有别的时空全 ack、或没人挂着任务也没人在写，才把天花板任务换成 25 秒提前档；
  // 沉默不是证据——06:47 就是拿「静默 20 秒」当收手，把正在干活的安全插件杀了。
  // 只在广播 pending 时才真的动手，平时一次读盘几十微秒。
  try {
    const timerService = typeof ctx.get === 'function' ? ctx.get('timer') : ctx.timer
    if (timerService?.interval) {
      let promoting = false
      disposers.push(
        timerService.interval(
          async () => {
            const runtime = state.runtime
            if (!runtime || runtime.fatal) return
            if (promoting) return
            try {
              const readiness = computeReadiness({
                ctx: runtime.ctx,
                selfSessionId: runtime.sessionId,
              })
              if (!readiness.active || !readiness.ready) return
              promoting = true
              const result = await maybePromote({
                ctx: runtime.ctx,
                selfSessionId: runtime.sessionId,
              })
              if (result?.promoted) {
                runtime.logger?.info?.(
                  `[restart-handshake] ${result.reason}（广播 ${result.broadcast?.id ?? '?'}）`,
                )
              }
            } catch (error) {
              recordApplyError('timer.restartHandshake', error)
            } finally {
              promoting = false
            }
          },
          Math.max(1000, AUTO_TICK_MS),
        ),
      )
    }
  } catch (error) {
    recordApplyError('timer.restartHandshake', error)
  }

  // ---- 工具相关性闸门（2026-11-10 03:46，你批准方案 B）----
  // 每步之前看这一步的用户话，认出来的场景组才露出来；只在命中变化时动工具面。
  try {
    const gateRoot = configuredRoot || FALLBACK_ROOT
    disposers.push(() => {})
    installToolGate(ctx, gateRoot)
  } catch (error) {
    recordApplyError('tool-gate', error)
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

