# 书同文·车同轨（dsh-tongwen）

把「一个盘」当成一座档案馆：**只收纳、只登记、只报告**，不改你的文件内容，不评价你的东西。

- **书同文**：同一类东西进同一个类型目录，物理名全用 ASCII 小写短横线，中文只做显示名。
- **车同轨**：所有会话走同一套交接——机器版给自己读，用户版给人读，路径和格式都固定。

## 九档（顶层白名单，常量，不可增删）

| # | 目录 | 中文名 | 放什么 |
| --- | --- | --- | --- |
| 1 | `handoff/` | 交接 | 交接文件、索引、方向谱系、未闭环项、项目白板、请求信箱 |
| 2 | `created/` | 创造 | dsh 干活产出的东西 |
| 3 | `downloads/` | 下载 | 联网拉回来的东西 |
| 4 | `incoming/` | 外来 | 你投喂的、从外部导入的 |
| 5 | `scratch/` | 临时 | 中间产物、可弃草稿 |
| 6 | `archive/` | 归档 | 软删落点、版本备份、恢复 |
| 7 | `logs/` | 日志 | 只追加的审计 |
| 8 | `config/` | 配置 | 插件版本、快照、清单 |
| 9 | `self/` | 自身 | AI 自己的文件。**只收纳和报告，不解析内容** |

顶层只有这九个。需要新分类就在九档里建二级目录，不新增第十档。
九个顶层目录本身不会被删除、移动、改名、改权限；空着也不删。
目录都是**用到才建**，不会预先铺一堆空文件夹。

## 五条硬规则

1. 顶层只有 9 档，不新建。
2. 写文件前路径不确定，先调 `locate` / `inspect_handoff` 查证，不猜。
3. 每次任务结束，机器版和用户版交接同时产出。
4. 删除一律软删进 `archive/trash/`；`scratch/` 真删要先问你。
5. 这次要做的和上次方向冲突时，**挂起问你**，不自己选。

## 十九个工具

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
| `housekeeping_report` | 生成「过期文件清扫报告」：列审计日志 / 账本日报 / 回收站 / 临时区里超过保留期的文件；只报告不删，删要主人点头（默认每周自动出一份） |
| `organ_list` | 列出所有器官（扫插件目录里的 `organ.json`）：会什么能力、危险等级、入口类型；器官信息不进总目录。 |
| `organ_call` | 神经系统门口：按名片把能力路由到器官。file+read 直读；write/danger 先写 gate 报备给安全插件、拿裁决（超时=拒绝），执行器未接前只回裁决；`dryRun` 只探路。 |
| `rollback_data` | 把白板/规范/索引页等数据文件回滚到历史版本；备份在 `archive/versions/_data/`，回滚前会再备份当前版，并写 `logs/rollback.log` 与 `handoff/任务交接本/最近回滚.md` |

### 跨会话（多个会话之间传话，不用你中转）

| 工具 | 干什么 |
| --- | --- |
| `project_upsert` | 建或更新一块项目白板（目标、参与会话、分工、决定、当前一棒、待办、优先级 P0–P3）；`status: "done"` 时自动移进 `projects/done/` |
| `project_read` | 读一块白板（已归档的也能读） |
| `project_list` | 列出所有白板（带优先级；已归档的标 `archived`） |
| `inbox_send` | 给某个会话（或所有会话）留一条请求 |
| `inbox_list` | 看自己的信箱（默认只看还没处理的） |
| `inbox_close` | 把一条请求标记为处理完 |

## 交接文件长什么样

每个实例两份，永远用固定名，按日期分目录，旧版只进 `archive/versions/`：

```
handoff/
├── machine/YYYY-MM-DD/<实例>.machine.md    # 给 dsh 读：六个固定小节
└── user/YYYY-MM-DD/<实例>.user.md          # 给你读：五段大白话
```

机器版六节：身份 / 产物清单 / 目标与当前状态 / 方向锚点 / 事实 vs 假设 / 建议入口。
产物清单每行都带类型、存在性（`yes`/`no`/`unknown`）和 `hashStatus`，缺失的只告警不阻断。

用户版五段：这是什么 / 里面有什么 / 做到哪了 / 下一步 / 别当真。
用户版里不会出现字段名、哈希、ID 或路径；「别当真」那段一定在。

## 跨会话怎么用

**一个会话干活，另一个会话接着干**，靠三样东西：

1. **项目白板** `handoff/projects/<项目id>.md` —— 一块白板记一个项目。谁干的、干到哪、下一步交给谁、做了哪些决定，都写在上面。`project_upsert` 写，`project_read` 读。每块白板都有优先级：`P0` 立刻做 / `P1` 本周 / `P2` 有空 / `P3` 以后（不填默认 `P2`），总目录的「当前一棒」按 P 级排序。项目做完就 `status: "done"`：白板自动搬进 `handoff/projects/done/`，总目录里只剩一行「已归档项目」，新人不会再把做完的事当成在办。
2. **请求信箱** `handoff/inbox.jsonl` —— 只追加，不改旧行。`inbox_send` 投一条请求（`to` 填会话 ID，或填 `any` 广播），对方 `inbox_list` 就能看到，处理完 `inbox_close`。
3. **开场简报** —— 每轮都带：插件把「交接根目录、先读总目录、只读当前一棒、有几块项目、当前一棒交给谁、有几条给你的请求」写进系统提示，不用你复述。

`begin_task` 加 `project: "<项目id>"` 把任务挂到白板上；`end_task` 加 `next: [{to:"any", request:"..."}]` 顺手把下一棒排出去。

## 目录长什么样

```
<根>/
├── handoff/
│   ├── machine/<日期>/<实例>.machine.md
│   ├── user/<日期>/<实例>.user.md
│   ├── projects/<项目id>.md          项目白板（带优先级 P0–P3）
│   ├── projects/done/<项目id>.md     做完归档的白板（status=done 自动移入）
│   ├── inbox.jsonl                   请求信箱，只追加
│   ├── self/            journals/（会话变更日记）、README.md
│   ├── 索引/           文件目录.md、插件目录.md、工具目录.md、A盘目录.md（手写，插件只链不覆盖）
│   ├── 教训日记/<日期>-<主题>.md
│   ├── 任务交接本/当前状态.md
│   ├── 能力目录.md     技能清单（build-catalog.mjs 生成）
│   ├── 时间交接/<项目id>/
│   ├── index.machine.json
│   ├── directions.jsonl      只追加
│   ├── open-items.jsonl      只追加
│   └── README.md      交接总目录（按权重排，启动/归档时自动刷新）
├── archive/
│   ├── trash/<时间戳>/from-<档>/<相对路径>
│   ├── trash/recovery-log.jsonl   只追加，永久保留
│   ├── versions/<实例>/<文件名>.<n>
│   └── restored/<时间戳>/from-<档>/...
├── logs/audit/YYYY-MM-DD.jsonl
├── config/plugins/tongwen-tonggui/{current.json, settings.json, self-snapshot.json, runtime-state.json, locks/, versions/}
└── self/                完全留白，一个子目录都不预设
```

## 配置

`cordis.patch.yml` 里只有一个字段，管的是「九个档建在哪」：

```yaml
- insert:
    - id: tongwen
      name: dsh-tongwen
      config:
        # 改成你自己的目录。留空（""）则落在 <用户主目录>/tongwen。
        # 填的路径建不出来时也会自动回退到 <用户主目录>/tongwen，并在简报里说一句。
        root: "C:\\tongwen"
```

**别直接填盘根**（`"C:\\"`）：Windows 上对盘根做创建会报 EPERM，白填。用一个子目录就行。

**装到别的机器上，第一件事就是改这一行。**

其余 34 个运行参数走 `config/plugins/tongwen-tonggui/settings.json`（这个文件插件只读，由你或安装器写）。字段名、默认值和合法范围都在 `lib/config.js` 里，与规格 §15.1 一致。

`handoff/README.md` 是**交接总目录**，启动和每次归档后自动重写。它按权重分七段：**一·文件（100）→ 二·插件（90）→ 三·工具（80）→ 四·A盘（70）→ 五·在办（60，当前一棒）→ 六·清单（50，最近交接）→ 七·已归档（40）**。每一段只放「位置 + 一句话」，细则在 `handoff/索引/` 四页里（那四页是手写的，插件只链不覆盖）。新会话只先读这一页，被派到哪个交接才去读哪个文件，不把全部交接读一遍。

其中 `selfScan.scope` 决定变更笔记统计哪个目录：`handoff`（默认，整个交接区）或 `self`（只统计日记区）。切换的那一轮会自动重建基线、不比对差异，并在笔记里注明。

## 安装

在本目录执行：

```bash
dsh plugin --profile <profile> add <本目录绝对路径>
```

或者用插件管理器：

```
plugin_manager { action: "install_bundle", target: "<本目录绝对路径>" }
```

装完**重启 dsh** 才会生效。

## 冒烟

```bash
node scripts/smoke-core.mjs            # 37 项：命名/路径/原子写/锁/配置/审计/ULID
node scripts/smoke-tools.mjs           # 27 项：注册工具（含清扫报告、器官名片/门口） → 建任务 → 双份交接 → 索引 → 总目录 → 项目优先级/归档 → 校验 → 归档
node scripts/smoke-session.mjs         # 13 项：首次启动建档 → 收尾 → journal → 异常中断补记 → 统计范围切换
node scripts/smoke-cross-session.mjs   # 15 项：项目白板 → 请求信箱 → 任务串接 → 开场简报（每轮都带）
```

四个都不碰真实盘根，全在临时目录里跑。

