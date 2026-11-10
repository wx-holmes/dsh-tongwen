// 聊天 桥接安全硬边界：只允许 聊天 MCP 工具与少量无害模型侧工具。
//
// 本文件是 bridge-kit bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

// ──────────────────────────────────────────────────────────────────────────
// 2026-11-03 你拍板（m00590）：聊天 侧要有和本地 GUI 会话一样的动手能力，
// 他要能在上班时从 聊天 直接接手项目。所以本文件的两道限制**临时关闭**。
//
// 安全边界没有撤销，只是换了落点：
//   · 桥接层工具级白名单（本文件）—— 关
//   · 系统层（安全插件 safety-kit：记忆区哨兵 / 白名单漂移检测 / 审计 /
//     看门狗兜底）—— 继续负责
//
// 恢复原状：把 FULL_ACCESS 改回 false 即可（restrict 隐藏 + guard 拒绝两道门
// 都会回来）。注意光改这里不够——qq-chat / qq-chat-v2 两个 preset 还必须挂着
// @deepseek-ai/dsh-tool-* 工具行，否则工具压根没注册，放开也没用。
// ──────────────────────────────────────────────────────────────────────────
export const FULL_ACCESS = true

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 聊天 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，聊天 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，聊天 preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__external-bridge__',
  'mcp__external-bridge-host__',
  'mcp__web-search-safe__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
//
// 上下文管理工具（billion-context 注入）：compress / decompress / search_context /
// acp_status / acp_cache / acp_read_original_image 只读写**本会话**的压缩摘要与
// 统计，不碰文件、进程、网络。聊天 长会话必然触发压缩——宿主会主动要求 `compress`，
// 若守卫拒绝，会话就会陷入「宿主要求 → 守卫拒绝 → 再要求」的死循环（2026-10-30
// 实测：一次会话里连续 50+ 次 compress 被拒，把回合拖死）。所以这几个必须放行。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  'compress',
  'decompress',
  'search_context',
  'acp_status',
  'acp_cache',
  'acp_read_original_image',
  // 书同文·车同轨（dsh-tongwen）：只扫描目录、建空文件夹、读写交接 Markdown，
  // 不移动/删除已有文件；你私聊里用来整理硬盘。
  'tongwen_scan',
  'tongwen_handoff_read',
  'tongwen_handoff_write',
  'tongwen_topic_create',
  'tongwen_claim',
  // 2026-11-03：书同文 0.3.13 起工具名从 tongwen_* 换成了下面这组语义名，
  // 旧名单没跟着换 → 你私聊里 locate / project_list / inbox_list 全被这里拒掉
  // （报「不在 聊天 桥接白名单内」）。这 15 个名字是从
  // 插件目录\dsh-tongwen\index.js 里 grep 实际注册的 ctx.tools.register
  // 逐个核对出来的，不是凭印象补的；上面 5 个旧名保留（老版本还在用）。
  // 边界：这些只会读写 ./tongwen 交接区，不碰系统目录、不 spawn 进程。
  'locate',
  'inspect_handoff',
  'list_handoffs',
  'update_handoff',
  'begin_task',
  'end_task',
  'heartbeat',
  'restore',
  'archive_handoff',
  'project_upsert',
  'project_read',
  'project_list',
  'inbox_send',
  'inbox_list',
  'inbox_close',
])

export function apply(ctx) {
  // 2026-11-03：全放开模式（见文件顶部 FULL_ACCESS 说明）。
  // 早退之前不做任何 restrict / guard，等于本插件空转。
  if (FULL_ACCESS) {
    console.error(
      '[qq-tool-restrict] FULL_ACCESS=true —— 不再隐藏或拦截任何工具；' +
        '安全边界由安全插件（safety-kit）接管。改回 false 即恢复两道门。',
    )
    return
  }

  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 聊天 preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  // 名字不存在时跳过（执行期白名单仍然兜底），但**只汇总一行**：
  // 以前每个工具打一行，DSH 启动时刷几百行日志，把真实告警淹没（2026-10-28 用户反馈）。
  const skipped = []
  for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      skipped.push(name)
      if (skipped.length === 1) {
        // 只在第一次失败时记一条细节，便于排查"某个名字失效"
        console.error(`[qq-tool-restrict] restrict 跳过（示例）：${name} — ${error?.message ?? error}`)
      }
    }
  }
  if (skipped.length) {
    const list = skipped.length > 8 ? `${skipped.slice(0, 8).join(', ')} 等` : skipped.join(', ')
    console.error(`[qq-tool-restrict] 跳过 ${skipped.length}/${KNOWN_DANGEROUS_GLOBAL_TOOLS.length} 个当前版本不存在的工具名：${list}（执行期白名单仍生效）`)

    // 2026-11-03（借鉴上游 0.8.x 的「晚注册工具也补限制」）：
    // 上面那轮 restrict 只覆盖启动那一刻已注册的全局工具；插件热加载、注入器
    // 后起的 `dev_*` 之类会在启动**之后**才出现，于是漏在 schema 外面。
    // 这里每 20 秒把当初"还不存在"的名字重试一次，装上就移出待办，清空即停表。
    // 只碰已知危险名单，不扫描未知工具，误伤面为零。
    const pending = new Set(skipped)
    const timer = setInterval(() => {
      for (const name of [...pending]) {
        try {
          ctx.tools.restrict({ deny: [name] })
          pending.delete(name)
        } catch {
          // 还没出现，下一轮再试
        }
      }
      if (pending.size === 0) {
        clearInterval(timer)
        console.error('[qq-tool-restrict] 晚注册的危险工具已全部补上限制（名单已清空）')
      }
    }, 20_000)
    // 不阻止进程退出
    if (typeof timer.unref === 'function') timer.unref()
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (SAFE_EXACT.has(name)) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 聊天 桥接白名单内，已拒绝（仅允许 聊天 MCP 工具与无害模型侧工具）`
  })
}
