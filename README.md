# 书同文·车同轨（dsh-tongwen）

把「一个盘」当成一座档案馆：**只收纳、只登记、只报告**，不改你的文件内容，不评价你的东西。

- **书同文**：同一类东西进同一个类型目录，物理名全用 ASCII 小写短横线，中文只做显示名。
- **车同轨**：所有会话走同一套交接——机器版给自己读，用户版给人读，路径和格式都固定。
- **互相认得**：每个会话有地址、有名字、有状态；要投信就投地址，不用人转达，也不靠猜。

当前版本 **0.5.43**（变更明细见 [CHANGELOG.md](./CHANGELOG.md)）。

## 九档（顶层白名单，常量，不可增删）

| # | 目录 | 中文名 | 放什么 |
| --- | --- | --- | --- |
| 1 | `handoff/` | 交接 | 交接文件、索引、方向谱系、未闭环项、项目白板、请求信箱、时空名册 |
| 2 | `created/` | 创造 | 干活产出的东西 |
| 3 | `downloads/` | 下载 | 联网拉回来的东西 |
| 4 | `incoming/` | 外来 | 你投喂的、从外部导入的 |
| 5 | `scratch/` | 临时 | 中间产物、可弃草稿 |
| 6 | `archive/` | 归档 | 软删落点、版本备份、恢复 |
| 7 | `logs/` | 日志 | 只追加的审计 |
| 8 | `config/` | 配置 | 插件版本、快照、清单 |
| 9 | `self/` | 自身 | AI 自己的文件。**只收纳和报告，不解析内容** |

顶层只有这九个；新分类在九档里建二级目录。目录用到才建，不会预先铺空文件夹。

## 五条硬规则

1. 顶层只有 9 档，不新建。
2. 写文件前路径不确定，先调 `locate` / `inspect_handoff` 查证，不猜。
3. 每次任务结束，机器版和用户版交接同时产出。
4. 删除一律软删进 `archive/trash/`；`scratch/` 真删要先问人。
5. 这次要做的和上次方向冲突时，**挂起问人**。

## 二十三个工具

### 交接与任务

| 工具 | 干什么 |
| --- | --- |
| `locate` | 按关键词找已有实例，返回候选（档、类型、实例名、交接路径） |
| `inspect_handoff` | 读一份交接：结构化字段 + 原文，可读历史版本 |
| `list_handoffs` | 列出实例，可按类型/状态/时间筛、分页 |
| `update_handoff` | 整节替换机器版交接的某一节（只允许第 3～6 节），自动留旧版备份 |
| `begin_task` | 登记一次任务：定档、定类型、定实例名，返回幂等键 |
| `end_task` | 结束任务：校验产物、写双份交接、版本化、更新索引、写审计 |
| `heartbeat` | 报一次心跳 |
| `restore` | 从 `archive/trash` 或 `archive/versions` 恢复文件 |
| `archive_handoff` | 把交接实例整份软删进 `archive/trash`（可 `restore` 找回），并从索引摘掉 |
| `housekeeping_report` | 生成「过期文件清扫报告」：列审计日志 / 账本日报 / 回收站 / 临时区里超过保留期的文件；只报告不删，删要你点头（默认每周自动出一份） |
| `rollback_data` | 把白板/规范/索引页等数据文件回滚到历史版本；备份在 `archive/versions/_data/`，回滚前会再备份当前版，并写 `logs/rollback.log` 与 `handoff/任务交接本/最近回滚.md` |

### 跨会话（多个会话之间传话，不用你中转）

| 工具 | 干什么 |
| --- | --- |
| `project_upsert` | 建或更新一块项目白板（目标、参与会话、分工、决定、当前一棒、待办、优先级 P0–P3）；`status: "done"` 时自动移进 `projects/done/` |
| `project_read` | 读一块白板（已归档的也能读） |
| `project_list` | 列出所有白板（带优先级；已归档的标 `archived`） |
| `inbox_send` | 给某个会话（或所有会话）留一条请求；`to` 认 `dsh://session/<id>` 与裸 id，写前先归一 |
| `inbox_list` | 看信箱：`mine`（发给我的）/ `to`（某人的）/ `project` / `status` 可叠加 |
| `inbox_close` | 把一条请求标记为处理完 |

### 时空地址簿（谁活着、住哪、地址是多少）

| 工具 | 干什么 |
| --- | --- |
| `space_list` | 地址簿：按地址/短句柄/状态/项目查会话；`task:"这次要做什么"` 按任务给时空排序（每条带 `why`，可审计的字面命中，不用向量）；默认不列自己与已归档 |
| `space_register` | 给自己登记名字（工作区由工具自动补），写完**回读校验**；拿不到调用方就拒绝（`E_NO_CALLER`），绝不写错地址 |

**地址**：`dsh://session/<sessionId>`（投递用这个）、`dsh://workspace/<workspaceId>`（只指桌面）、`any`（广播）。
**名字**：`身份（工作区）`，如 `书同文（韵柚）`、`意识（生命）`、`QQ（QQ 聊天）`；同一身份同一工作区出现第二个会话才加 `·#短句柄`，旧会话冒充本体时标 `·旧壳`。
**状态**：`active`（15 分钟内有写入）/ `idle`（24 小时内）/ `stale`（超过 24 小时）/ `archived`（工作区里已归档）/ `stub`（< 4 KB 空壳）/ `orphan`（磁盘有、归属表没有，仍能收信）。
**不变式**：同一个 sessionId 只留一行、同一个名字只留一行；写入前留 `时空名册.md.bak`；名册只许走工具，不许人手整份重写。
**代登**：没有调用方身份的空间（如后台/桥接）不能自登，由能证明归属的人按 `workspace.json` 代登并标 `[代登]`。
**认自己**：不要信信件里的 `from`/`to`，也不要信文件名和新鲜度；用 `session_inspect` 的 `cwd` + `createdAt` + `turns.count` 三样互证，或自己 shell 里的 `$DSH_SESSION_ID`。

### 定位与重启

| 工具 | 干什么 |
| --- | --- |
| `focus_context` | 开工前定位：给一句「这次要做什么」，只返回相关的规范页（带行号）、要看的请求、相关项目的白板与挂账；不相关的不推 |
| `restart_dsh` | 重启的唯一入口：`arm` 先广播「全时空重启」再排程（握手模式：天花板 90 秒，拿到硬证据才提前到 25 秒）；别的会话看到广播就 `ack` 报「我收尾了」 |

### 器官（可选插件的能力路由）

| 工具 | 干什么 |
| --- | --- |
| `organ_list` | 列出所有器官（扫插件目录里的 `organ.json`）：会什么能力、危险等级、入口类型 |
| `organ_call` | 按名片把能力路由到器官；写/危险动作先过 gate 报备，`dryRun` 只探路 |

## 相关性是怎么做的（不是向量）

`focus_context` 与开场简报都走同一套**字面相关**：把任务句切成词，对上主题表里的关键词（主题有各自权重，命中越多越靠前），再带上该主题指定的页面与行号。
它**不做语义检索**，命中理由可以逐条审计（`why` 里写的是命中了哪个词）。好处是可解释、不花 token、离线可用；代价是任务句太泛时找不到东西——所以它要求你写具体一点（「改重启脚本的握手」比「优化」有用得多）。

## 开场简报（每轮都带）

插件把这几件事写进系统提示，不用人复述：
交接根目录 → 你自己的地址 → 先读哪几页 → 有几块项目 / 当前一棒交给谁 → 有几条给你的请求 → 重启广播（若有）。
地址在装配期拿不到发起者时，会**明说「查不到」**并指向 `space_list{includeSelf:true}`，绝不印别人的地址。

## 交接文件长什么样

```
handoff/
├── machine/YYYY-MM-DD/<实例>.machine.md    # 给 dsh 读：六个固定小节
└── user/YYYY-MM-DD/<实例>.user.md          # 给人读：五段大白话
```

机器版六节：身份 / 产物清单 / 目标与当前状态 / 方向锚点 / 事实 vs 假设 / 建议入口。
用户版五段：这是什么 / 里面有什么 / 做到哪了 / 下一步 / 别当真。

## 目录长什么样

```
<根>/
├── handoff/
│   ├── machine/<日期>/   user/<日期>/
│   ├── projects/<项目id>.md            projects/done/<项目id>.md
│   ├── inbox.jsonl                     请求信箱，只追加
│   ├── 时空名册.md                     地址簿（工具维护）
│   ├── 手册/                           规矩与手册（含《时空地址》《重启》等）
│   ├── 教训日记/<日期>-<主题>.md
│   ├── 任务交接本/当前状态.md
│   ├── index.machine.json
│   ├── directions.jsonl  open-items.jsonl
│   └── README.md                       交接总目录（自动重写）
├── archive/trash|versions|restored
├── logs/audit/YYYY-MM-DD.jsonl
├── config/plugins/tongwen-tonggui/{current.json,settings.json,self-snapshot.json,runtime-state.json,locks/,versions/}
└── self/
```

## 配置

`cordis.patch.yml` 里只有一个字段，管「九档建在哪」：

```yaml
- insert:
    - id: tongwen
      name: dsh-tongwen
      config:
        root: "./tongwen"   # 留空则落在 <用户主目录>/tongwen；别填盘根（Windows 会 EPERM）
```

其余参数走 `config/plugins/tongwen-tonggui/settings.json`（插件只读），字段与默认值见 `lib/config.js`。

## 安装

```bash
dsh plugin --profile <profile> add <本目录绝对路径>
```

或用插件管理器：

```
plugin_manager { action: "install_bundle", target: "<本目录绝对路径>" }
```

装完**重启 dsh** 才生效。

## 冒烟与自检

```bash
node scripts/smoke-core.mjs            # 37 项：命名/路径/原子写/锁/配置/审计/ULID
node scripts/smoke-tools.mjs           # 45 项：23 个工具注册 + 建任务 → 双份交接 → 索引 → 总目录 → 项目优先级/归档 → 校验 → 归档
node scripts/smoke-session.mjs         # 13 项：首次启动建档 → 收尾 → journal → 异常中断补记 → 统计范围切换
node scripts/smoke-cross-session.mjs   # 15 项：项目白板 → 请求信箱 → 地址归一 → 任务串接 → 开场简报
node scripts/audit-roster.mjs [根目录] # 名册体检：行格式 / 地址唯一 / 名字唯一 / 是否在 workspace.json / 解析计数
```

都不碰真实盘根，全在临时目录里跑。

## 给其它会话的契约（一页版）

- 要投信：`inbox_send{to:"dsh://session/<id>"}`，别用回执里的 id 猜。
- 要认自己：`$DSH_SESSION_ID` 或 `session_inspect` 三证，别信信封。
- 要登记：`space_register{name:"身份"}`，工作区工具补；无调用方会拒绝。
- 要重启：`restart_dsh{action:"arm"}` 先广播；看到广播就 `ack`。
- 名字会漂、id 会漂、状态会变：拿不到就拒绝或明说，绝不回退默认值。

## 许可

MIT（见 [LICENSE](./LICENSE)）。
