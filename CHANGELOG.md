# 变更日志
## 0.5.28（2026-11-07，账本日报进相关性：任务提到账本/花费就推最近两天）

### 背景
`ledger` 主题原来只带《记录规范》：要看「今天花了多少、按时空怎么拆」还得自己去 `logs/账本/` 找日报。正好这轮抓到一次账本洞（会话文件是空壳、日报里看不见那个时空），顺手把日报做成动态预读——下次时空问到账本，直接拿到最近两天。

### 变更
- `ledger` 关键词补 花费 / 花销。
- `DYNAMIC_DIRS` 新增 `ledger`：扫 `logs/账本/`，只收 `YYYY-MM-DD.md`（`README.md` 和规范页不进动态），`latest` 取最近 2 天；不设 auto，只有任务命中账本主题才推。
- `resolveDynamic()` 支持 `filter`（正则过滤目录内文件名），其它动态来源不受影响。
- 手册《相关性路由》动态表补 ledger 行，标题改为 0.5.28。
- 新增冒烟 0.5.28：提到账本要带最近两天日报、README 不推、不相关不带。

### 口径
- 记录规范照旧必带；日报只补「最近的数」，看完要口径回 `logs/账本/记录规范.md`。
- 日报是生成物，别手改；要改口径改 `ledger 工具\` 的脚本。

## 0.5.27（2026-11-06，项目白板进主题表：任务提到项目就自动预读，接错棒比不接更贵）

### 背景
0.5.26 解决了「点名才带白板」，但接手的时空经常说不清是哪个项目；靠人先查总览再点名，等于多绕一步。这一步把项目白板做成第 16 个主题（priority 92），并按任务自动预读。

### 变更
- 主题表新增 `project`（priority 92，插在 `handoff` 94 与 `plugin` 90 之间）：关键词 项目 / 白板 / 当前一棒 / 棒次 / 挂账 / 接手 / 进度 / 收个尾 / 项目总览；文档 `handoff/项目总览.md` + `handoff/索引/交接索引.md`。
- `DYNAMIC_DIRS` 新增 `project`：扫 `handoff/projects/`，按**标题（×2）+「当前一棒 / 挂账」小节正文**的两字词重合度打分（文件名是英文 id，只算弱信号），≥5 分收，最多 2 篇，命中带 `auto`。
- `routeFocus()` 的自动预读从「只做教训」改成通用循环：凡 `DYNAMIC_DIRS` 里 `auto:true` 的来源（lessons / project），任务没点名也会跑一遍；命中就以 `<主题>(auto)` 追加。
- `resolveDynamic()` 支持 `sections`：按小节取正文打分，读出来的文档带 `sections`，`inspectDoc()` 再把小节标题与行号补进 `headings`。
- 修 `inspectDoc` 之后 auto 标记丢失：`routeFocus` 拼 `read` 时显式带上 `doc.auto`。
- 手册《相关性路由》更新：16 个主题 + 兜底、project 行与动态表都补上。

### 口径
- 项目白板只推「标题/当前一棒/挂账」匹配得上的，最多 2 篇；不相关不推（任务「今天天气」仍然只读兜底一页）。
- 自动预读只加分不抢主线：`<主题>(auto)` 排在正文后面，分数为 0。
- 点名的项目（0.5.26 的 `project` 参数）仍然优先、必带，即使任务没提到它。

### 测试
四套 **109 全过**：core 37 / tools 44（新增项目白板自动预读用例）/ session 13 / cross-session 15。

## 0.5.26（2026-11-06，focus_context 点名项目就带项目白板：当前一棒/挂账给行号）

### 背景
继续把「相关性」从手册页扩到项目白板：接手一个项目时，最该先看的是它的「当前一棒」和「挂账」，而这两节通常挂在长白板的中后段，靠人翻容易漏。

### 变更
- `routeFocus({project})`：点名项目时自动带上 `handoff/projects/<project>.md`（只这一页，不扫整个 projects 目录）；文件不存在就安静跳过，不报错。
- `inspectDoc()` 新增 `sections` 支持：按给定小节名（当前一棒 / 挂账 / ⚠ 挂账）把小节标题与行号补进 `headings`，长白板也能一眼跳到该读的位置。
- `focus_context` 描述与开场注升到 0.5.26；项目白板作为 `handoff` 主题下的文档出现，`why` 写明「当前一棒 / 挂账看 headings 行号」。
- 冒烟新增：造一块「当前一棒埋在后段」的假白板，断言点名后 headings 能指到「当前一棒」「挂账」；不点名时 read 里不出现 `handoff/projects/`。

### 口径
- 只在调用方点名（或上层明确 project）时推白板；不点名不推——宁可让人多问一句，也不把 15 个项目的白板全塞进来。
- 白板正文不截断、不摘要，只给行号；读哪几段由接手的时空自己决定。

### 测试
四套 **108 全过**：core 37 / tools 43（新增项目白板用例）/ session 13 / cross-session 15。

## 0.5.25（2026-11-06，器官间双向调用：链上防回环、回执按事件 id 去重、我们自己的脚印写进 events）

### 背景
你 23:04：「两个都上，另外把之前的尾巴处理一下，比如旧路径旧文书之类的」——把「双向各调一次」从验收话变成能跑的东西：别的器官能调我们的只读能力，我们调它们时也要留脚印；同时不许 A→B→A 打转。

### 变更
- `organ_call` 新增两个参数：`chain`（调用链，能力名数组）与 `replyTo`（回执对象，事件 id）。
- 防回环三条硬约束（`lib/organs.js`）：链最多 `MAX_CALL_HOPS = 3` 跳；同一能力在同一条链里出现两次直接 `E_CALL_LOOP`；`replyTo` 按事件 id 去重，同一件事第二次回 `E_LOOP_DEDUPE`（只留最近 200 条回执记录）。
- 每次调用成功后往我们自己的 `logs/organ-events.jsonl` 追一行 `organ.call`（organ / ability / sideEffect / who / chain）；带 `replyTo` 的再追一行 `organ.call.reply`。事件 id 形如 `evt-tongwen-<毫秒base36>-<6 位序号>`，同文件内不重复；留痕失败不阻断调用。
- `KNOWN_EVENT_TYPES` 加 `organ.call.reply`；`organ_call` 工具描述与参数说明同步（含 dryRun 不发事件）。
- 冒烟扩写：链里已有自己 → `E_CALL_LOOP`（message 含「回环」）、3 跳以上 → `E_CALL_LOOP`（含「3 跳」）、同一 `replyTo` 第二次 → `E_LOOP_DEDUPE`；自家 events 里两个事件都在且 id 全不重复。

### 口径
- 「双向」= 我们能调别人的只读能力、别人也能调我们的（名片 `organ.json` 本来就登记了 4 项只读 + 1 项写），两条方向都靠同一道 `organ_call` 门。
- 防的是「无终止回环」，不是正常来回：一次问答（A 调 B、B 回一条事件、A 据此再调一次）允许；第三跳以后停手。
- 回执去重认事件 id，不认内容：对方重放同一件事不会让我们把同一回两遍。

### 测试
四套 **107 全过**：core 37 / tools 42（新增 4 条回环/回执断言）/ session 13 / cross-session 15。

## 0.5.24（2026-11-06，相关性覆盖九档：self 推自己、教训日记按相关度自动预读）

### 背景
你 22:53：「九档都可以加上相关性，self是你自己的所有东西，所以关于你自己的记忆人格之类的都可以推，然后就是教训日记的相关性，可以排一下，比如一个时空正在做教训日记相关的事情就可以把之前的教训日记推给她，这样她就不会犯同一次错误率。」

### 变更
- 主题表从 7 个扩到 15 个 + 兜底 = 16 类，九档全认：新增 `self`（吸收原 `memory`：人格 / 记忆 / 日档）、`lessons`、`logs`、`created`、`incoming`、`downloads`、`config`、`scratch`、`archive`；priority 唯一：handoff 94 / plugin 90 / publish 87 / lessons 85 / self 80 / files 74 / restart 68 / logs 62 / ledger 56 / created 48 / incoming 44 / downloads 40 / config 36 / scratch 30 / archive 26 / general 0。
- 新增动态文档 `DYNAMIC_DIRS`：`lessons` 按任务 bigram 匹配 `handoff/教训日记` 下的文件名（×2）与正文，≥4 分才收、最多 3 篇；`self` 取 `self/日档` 最近 2 篇（按文件名倒序）。
- 任务没提「教训」也会跑一遍教训匹配（auto 预读），命中就作为 `lessons(auto)` 主题追加；read 里带 `matched`（原文行号 + 文本，截 160 字）。
- `TOPIC_SCHEMA_VERSION` 升到 2；`validateTopics()` 扩成能校验动态目录（目录必须在九档内、max 1-5、mode latest/match、主题必须存在）；`topicTable()` 每行带 `dynamic`。
- 手册页 `handoff/手册/相关性路由.md` 整页重写：16 类目录表、动态预读规则、加主题/加动态目录的步骤。
- 冒烟把 0.5.23 用例扩写：16 行与顺序、九档全覆盖、dynamic 标志、自动预读真跑（临时 root 造一篇假教训并断言 `matched`）、self 推日档、dup 表被拦。

### 口径
- 推的是「可能踩到的那几行」，不是整篇教训；没命中就不推，宁缺勿滥。
- `self` 只读自己档（日档 / README / 记忆卡来源），不把人格卡正文塞进上下文——遵守 `self/README.md` 的约定（插件只扫描不解析）。
- 动态来源只限九档内；加新来源走 `DYNAMIC_DIRS`，不散落在代码里。

### 测试
四套 **107 全过**：core 37 / tools 42（相关性用例扩写）/ session 13 / cross-session 15。

## 0.5.23（2026-11-06，相关性维护：清点 8 大类、按优先级排序、给升级留位）

### 背景
你 22:46：「正好你这边做一下相关性的维护，看一下目前有几大类，然后按相关性排序一下，也要给后续升级留空间。」——0.5.20 只做了「按任务挑页」，主题是平铺的：谁先定义谁排前面，加主题只能往后追，也说不出「为什么这页比那页更该先看」。

### 变更
- `lib/relevance.js` 每个主题加 `tier`（core / frequent / occasional）+ 唯一 `priority` + `why`（为什么排这儿）；排序口径 = 出现频率 × 出错代价。
- 优先级定稿（高→低）：`handoff` 90（core，每件事都以交接收口）→ `plugin` 85（core，当前主线）→ `publish` 80（core，对外不可逆）→ `files` 70 → `memory` 65 → `restart` 60 → `ledger` 50；兜底 `general` 0。
- `detectTopics()` 同分时按 priority 再按 id 排；`topicIndexLine()` 也按 priority 降序，开场注里的索引顺序跟着变。
- 新增 `TOPIC_SCHEMA_VERSION = 1`、`TIER_LABEL`、`topicTable()`（8 行总表，带档位与 why）、`validateTopics()`（查 id/priority 重复、priority 越界、tier 不认识、缺关键词、docs 缺 path/why；路径越界只 warning）、`topicById()`。
- 冒烟加一条：表长 8、顺序与 priority 严格递减、`validateTopics().ok`、能报出重复 id / 重复 priority。
- 手册新增 `handoff/手册/相关性路由.md` 整页（8 大类目录表、排序规则、三条边界、加主题五步、升级空间）。

### 口径
- 相关性是**过滤器**不是删除器：主题没命中就给兜底总览，不推无关请求。
- `priority` 必须唯一——两件事一样重要就该合并成一个主题；这是「留升级空间」的硬约束。
- 加主题先跑 `validateTopics()`，红了不许合。

### 测试
四套 **107 全过**：core 37 / tools 42（新增相关性主题表用例）/ session 13 / cross-session 15。

## 0.5.22（2026-11-06，重启提速：提前档前先杀掉旧定时器，不再被自己补刀）

### 背景
你 22:35：「弄完之后我感觉还是要优化一下重启，太慢了。」——实测一次重启从断到恢复要 ~180 秒。现场（`restart-request.log` 与 `watchdog.log`）看到 22:32:13 和 22:32:53 **两次杀进程**：握手式提前档把 90 秒换成了 25 秒，但原来那个 90 秒的临时脚本还在睡着，到点又杀了一次刚被看门狗拉起来的 DSH。

### 根因
`restart-dsh-later.ps1` 每次写一个 `%TEMP%\dsh-restart-delay-<guid>.ps1`（`Start-Sleep` 到点才杀），然后重新注册计划任务。脚本里的 `Unregister-ScheduledTask` 只删任务注册，**杀不掉已经在跑的那个 pwsh**。`lib/handshake.js` 的 `maybePromote()` 调 `schedule()` 换提前档时，旧定时器就成了「补刀侠」。

### 变更
- `lib/restart.js` 新增 `killRestartTimers()`：按命令行匹配 `dsh-restart-delay-<32位hex>.ps1` 找出还睡着的定时 pwsh 并 `Stop-Process`，返回被杀的 pid。
- `scheduleRestart()` 在真正排程之前先调用它（`dryRun` 不杀）；`unscheduleRestartTask()` 取消时也调用——cancel 之后不该还留一颗定时炸弹。
- 冒烟加一条：`TONGWEN_NO_SCHTASKS=1` 时它必须返回 `skipped` 且 `killed: []`，冒烟绝不杀机器上的进程。
- 机器上实测：起一个假定时器（`Start-Sleep 300`）→ 调 `killRestartTimers()` → 返回 `killed:[26196]`，进程确实没了，`%TEMP%` 里无残留。

### 口径
- 预排的重启计划只有**最后一份**有效：排新的之前先撤旧的，不只是撤任务注册。
- 杀进程只认文件名模式与 pwsh 进程，不碰 DSH 自身；冒烟环境一律跳过。

### 测试
四套 **106 全过**：core 37 / tools 41（新增一条 killRestartTimers 跳过用例）/ session 13 / cross-session 15。

## 0.5.21（2026-11-06，同类项合并：插件的手册合成一页《插件的自我管理》，相关性直指这一页）

### 背景
你 22:24：「那把插件相关的合成一个吧，名字就叫插件的自我管理，不然一大堆散的到处都是，这正好是你要做的相关性，整合同类项，精准推送，退相干。」——原来插件相关的四页（契约、联动、接入清单、自校验回路）各说一段，找一条规矩要翻四个文件；这正是相关性路由要解决的问题的另一半：不只按任务挑页，还要把同类项先合成一页。

### 变更
- 新增 `handoff/手册/插件的自我管理.md`（约 300 行，十节）：§〇 大白话与四插头、§一 三条规矩（独立性 / 联动性 / 不合体只跑自己）、§二 吸收不是照抄、§三 名片与 effector 例外（可不带手，但要写 `_为什么不带手`，现状表记「—」）、§四 头手脚心（事件 id 唯一、心跳每轮无条件重写、ttl 600000）、§五 合体与 gate v2、§六 退化矩阵、§七 五问与验收、§八 现状表、§九 边界、§十 写规范的规矩。
- `插件接口与合体契约.md` / `联动契约.md` / `合体接入清单.md` 改成指路短页（主题 → 新页 §X），正文不再维护。
- `lib/relevance.js` 的 plugin 主题只指向《插件的自我管理》与《断言契约》；`lib/layers.js` 的 `PINNED_NORMS` 改成新页名，手册总览里「接入契约」段与正文引用同步改新。
- 冒烟的假手册、pin 顺序断言、focus_context 用例（插件→《插件的自我管理》、上传任务不该推插件手册）全部同步。

### 口径
- **退相干**：一页只讲一件事，讲完就收束；同类项不散落在四个文件里。
- 旧页留指路，不删——已经记住旧路径的时空不会 404，但读到的第一句就是「去新页」。
- 相关性路由是**入口**，合并手册是**库存**：入口只给一页，库存里这一页要能一站读完。

### 测试
四套 **106 全过**：core 37 / tools 41 / session 13 / cross-session 15；`node --check` 7 个改动文件全过。

## 0.5.20（2026-11-06，相关性路由：按任务只给该读的页，不一股脑推）

### 背景
你 22:13：「通知堆在一起，既浪费时间也消耗信息密度带来的任务准确度……如果上传就需要定位到隐私手册，如果是做插件就需要定位到联动契约……我正在处理一个问题，告诉我的事情就是跟我相关的，而不是一股脑全部推送给你。」

### 变更
- 新增 `lib/relevance.js`：主题表 `TOPICS`（publish / plugin / restart / handoff / files / ledger / memory + 兜底 general），每个主题映射到该读的手册页；`detectTopics(task)` 按关键词打分（同一关键词封顶 3 次），`collectDocs` 去重保序，`inspectDoc` 给出页大小、行数与最多 3 个相关小节，`scoreRequest` 给收件箱请求打分（同项目 +4、点名 +3、广播 +1、关键词命中 +最多 4），`routeFocus` 只保留分数 ≥ 2 的请求。
- 新工具 `focus_context{task, project?, limit?}`：一次返回「该读哪几页（含小节）+ 哪些请求跟你有关（带 why）+ 其它先放着」，并写审计。
- 开场注加一行主题索引与「开工前先定位」提示；「手册总览」页新增《开工前先定位》一段。
- 新增手册页 `handoff/手册/相关性路由.md`：用法、主题表、三条边界（宁可漏不乱推 / 不删只降级 / 打分要带理由）。

### 口径
- 相关性是**过滤器**不是**删除器**：低分请求只是这次不推，仍留在信箱里；任务变了再调一次就会浮出来。
- 主题与文档的对照写死在 `TOPICS`，改表要连冒烟一起改。

### 测试
四套 **106 全过**：core 37 / tools 41（新增一条相关性路由用例）/ session 13 / cross-session 15。

## 0.5.19（2026-11-06，对外交付卫生 + 契约文书三条规矩）

### 背景
你 21:48：「上传的隐私暴露太多了」+「升级一下契约文书，告诉别的插件负责人：1 独立性、2 联动性、3 不合体只跑自己」。

### 变更
- 发布副本第二轮清洗：对外 CHANGELOG 整份重写成功能摘要（不再带引语 / 事故经过 / 工单号）；`lib/catalog.js` 的 A 盘「大头」清单、工具绝对路径改成可移植写法；`lib/presence.js`、`lib/task.js`、`bin/organ-call.mjs` 注释里的本机路径改成 `<DSH_HOME>` 一类；称呼「你」→「你」，真机插件名换通用名。
- 手册《插件接口与合体契约》新增 §〇之二「三条规矩（给每一位插件负责人）」：独立性 / 联动性 / 不合体只跑自己，各带自检动作；《联动契约》§1 同步加第 4 条。
- 《上传仓库前的隐私清洗》补「第二轮：叙事、主机清单、私人称呼」一节，并记两道坑（PowerShell 批量替换会连带改坏字符；改文案要同步改冒烟断言）。

### 测试
发布副本四套冒烟 105 全过（core 37 / tools 40 / session 13 / cross 15）；`node --check` 13 个文件全过；残留复扫 0 条。



## 0.5.18（2026-11-06，四条账：next 不再静默丢 / blocked 不再甩给你 / 编码与配对写进手册）

### 背景
你转来四条账：① 重启脚本要存 UTF-8 BOM 或纯 ASCII（PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，直接报 `Missing )`）；② `a2cca55` 还没推上去；③ 机器版 93 份、用户版 92 份，差一份「书同文→神经系统：口径修订」；④ `end_task` 的 next 字段没渲染，两份交接都丢了，用户版第 4 段还把 blocked 写成「需要你决定」。

核查结果：② 和 ③ 已经不成立——`a2cca55` 早在 `origin/main`（真正欠推的是后面 22 个提交），live 计数 machine 128 / user 128 且那份「口径修订」用户版在。真正要修的是 ④（还有一个真 bug），以及把 ① 的写法写进手册。

### 变更
- `lib/task.js` 新增 `normalizeNext(raw)`：`next` 现在接受对象数组 / 字符串数组 / 单对象 / 单字符串 / JSON 字符串；JSON 解析失败按换行或分号拆；对象取 `request`→`task`→`text`；`to` 默认 `any`。**以前只认 `{request}` 对象，字符串一律静默丢光**——这就是「next 字段没渲染、两份交接都丢了」的根因。
- 被纠正的形式会随归档结果返回 `warnings`（不再一声不响地丢）。
- `lib/handoff.js` 用户版第 4 段：blocked 文案从「需要你决定怎么处理，不然下次还会停在这里」改成「这些不用你现在决定，下一棒会带着它们继续做」+「要是你想先动哪一件…跟我说一声就按你的来」。blocked 是干活撞上的坎，不是等你拍板的事。
- 冒烟加一条：`next` 用字符串、以及用 JSON 字符串，两种写法都要真落进交接正文。

### 口径
- 交接里的 next 四种写法都收（对象数组 / 字符串数组 / JSON 字符串 / 单条），但**字符串项不补「（交给谁）」**——没写交给谁就是没写，不替作者编。
- ②③ 在账上销掉；① 落成手册铁律（重启脚本编码）；④ 落成手册写法（next 四种写法 + 为什么不再静默丢）。

### 测试
四套 **105 全过**：core 37 / tools 40 / session 13 / cross-session 15（0.5.17 是 104，多的是这一条新用例）。

## 0.5.17（2026-11-06，跟安全插件 08:41 的实装对齐：契约放到 payload 顶层）

### 背景
DSH 从 0.2.1-rc.5 升到 0.2.2-rc.1 后跑验收，tools 冒烟掉到 37/39：两条 verify 用例都报 `ENOENT … logs/verify-verdicts.jsonl`。查下来不是升级弄坏的——是**安全插件在 08:41（我们 08:40 交付 0.5.16 之后一分钟）把 `safety-kit 的 bin/verify.mjs` 收紧了**：新加的 `normalizeContract(payload)` 在**顶层**读 `payload.by` / `payload.until` / `payload.maxRounds` / `payload.stopOnPass`，缺 by 或缺终止条件就**整单拒收**（exit 1、一条都不跑、也不落 learned），回执写「缺 by：这单是谁派的…」「缺终止条件：…三选一」。
我们 0.5.16 把契约放在 `payload.contract{complete,unbounded}` 和每条 claim 的 owner 里，顶层没有 by/终止条件——于是每次派单都被拒，`judged.verdict` 不是 allow 也不是 deny，task.js 走了「没给裁决」那条分支，裁决文件根本没写。

### 变更
- `lib/task.js`：payload 顶层补 `by: defaultBy`（不靠环境变量兜底）与 `dispatcher`；终止条件从断言里透传（第一条有的 `until` / `maxRounds`），都没有就 `stopOnPass: true`（一次归档只验一轮，不会循环派单）。`env.VERIFY_BY` 继续带，双保险。
- 注释写清两边的口径差异：字段名是我们 0.5.16 定的，安全插件按这个收，但她读的是**顶层**——以后改字段先看她那边的 `normalizeContract`。

### 口径
- **契约只有一份，位置以收件方为准**：字段名由派单方定，放在哪一层由收件方定。
- 被拒收不算「验过」：这次是冒烟替我们抓住了，真机上一旦被拒，裁决文件不会写，别把「没有裁决」当成「通过」。

### 测试
四套冒烟 **104 全过**（core 37 / tools 39 / session 13 / cross-session 15）；修前 tools 37/39。

## 0.5.16（2026-11-06，断言契约：verify 必须写清「谁派的、什么时候停」）

### 背景
安全插件 04:14→07:03 被 37 条无主断言写崩：rules/learned.jsonl 里全是同一句 `verify: port 31181`，taskId 每轮都变、不带 by、也没有终止条件，每失败一次就落一行账。新时空 08:30 交接了「断言不再无主」三件事——by 必填、终止条件三选一、收件人默认等于 by；字段名由我们定，安全插件按我们定的收。

### 变更
- `lib/task.js`：`verify:` 行解析升级——行尾 `by=tongwen/x`、`by: tongwen/x`（空格分隔）和下一行缩进子字段都认（`cmd` 类型不吃行尾：命令里本来就可能带等号和冒号）；每条断言新增 `by` / `to` / `until` / `maxRounds` / `stopOnPass` / `bounded` / `contract`；缺字段只在 warnings 里记一句，**不拦归档**。
- 派单兜底：断言没写 `by` 的用 `tongwen/end_task:<entryId>`，默认 `stopOnPass`（一次归档只验一轮，不会循环派单）。
- 送安全插件时 `spawnSync` 带 `env: { VERIFY_BY: 派单方 }`，她记录里的 `by` 不再永远是 unknown；返回体 `verifyVerdict.by` 同步带上。
- payload 新增 `dispatcher` 与 `contract: { complete, unbounded }`（安全插件忽略不认识的字段，加字段安全）。
- 新增手册页 `handoff/手册/断言契约.md`：人话版 + 三种写法 + 终止条件三选一 + 缺了会怎样（只记不拦）+ 安全插件侧现状 + 自查三问 + 证据路径。
- `scripts/smoke-tools.mjs` 新增用例「0.5.16 断言契约」：缩进子字段、行尾 key=value、缺字段只警告、裁决回执带 by。

### 口径
- **先记后拦**：这一版只记账不拦人，等大家写顺了再考虑硬拒（与「别把自己写死」的四条铁律同源）。
- **不替作者编 by**：稿子上没写就记「缺 by」，不猜、不补。
- **cmd 不吃行尾字段**：命令里本来就可能带等号和冒号，写了会被当成命令的一部分。

### 测试
四套冒烟 **104 全过**（core 37 / tools 39 / session 13 / cross-session 15）。

## 0.5.15（2026-11-06，规矩改叫手册 + 一页「别把自己写死」）

### 背景
安全插件 07:0x 给自己写崩了：safety-kit\rules\learned.jsonl 全灭同一句 verify: port 31181（37 行 / 7,067 B、20~60 秒一条、taskId 每次不同），safety-kit\state\tools-baseline.json 07:18 被重写后判 local plugin removed 抬到 4 档「战」，watchdog.cjs 的封顶 07:19 就写好了但进程跑到 07:33 才重启。三刀里两刀是「写」没有上限、一刀是「改了不重启」。你要求：写进手册，防止下一个时空又给自己写死；顺手把「规范」改叫「手册」（更好听，也更好理解）。

### 变更
- 目录：handoff/规范/ → **handoff/手册/**，生成物 handoff/规范总览.md → **handoff/手册总览.md**（旧的已软删进 rchive/trash/）。
- 新增手册页 **handoff/手册/别把自己写死.md**：一、事故经过（两条链 + 改了没生效，带体量数字）；二、四条铁律（去重按内容签名 / 测试数据不进基线 / 改了不重启=没改 / 先量增长率再翻日志）；三、两条护栏（写要有上限、失败不要派生新任务）；四、按顺序查（4 步）；五、书同文自己也适用（organs-exec.jsonl、账本、organs-state.json）；六、证据路径。
- 代码：lib/layers.js 常量 NORMS_DIR_REL='handoff/手册'、NORMS_FILE='handoff/手册总览.md'、标题改「# 手册总览 · 定死的规矩（第一层）」；lib/catalog.js、lib/organs.js、lib/task.js、index.js、scripts/check-organs.mjs、scripts/smoke-tools.mjs、scripts/smoke-cross-session.mjs、organ.json 的路径与文案同步改；ledger 工具的 ledger.mjs、record.mjs 注释同步。
- 文档：handoff/手册/*.md、handoff/索引/*.md、handoff/projects/*.md、handoff/plugins/README.md、handoff/README.md、handoff/项目总览.md 内的旧路径批量改写（14 个文件）；历史交接（machine/user/archive）与 release 日志不动。

### 口径
- **改路径是「搬家」，不是「换规矩」**：手册里每一条铁律一条没删，只是目录名和生成物名变了。
- 生成物永远由插件重排；改名后第一次重启前，开场可能短暂显示「0 条」——那是旧进程扫空目录写的空页，重启后恢复。
- 手册页只写「为什么会这样 + 怎么防」，不复述安全插件的代码细节（细节留在 logs/release-* 与交接里）。

### 测试
四套冒烟全跑：core 37/37、tools 38/38、session 13/13、cross-session 15/15（合计 103）；
ode --check 所有改动过的 js/mjs 通过；\regen-0-4-5.mjs 重排三层。
## 0.5.14（2026-11-06，能力的对外执行入口：别的时空也能够得着我们）

### 背景
0.5.8 起「手」是公共那一双，但只有书同文自己能伸手——别的器官、别的时空想读我们的东西、想写一条备忘，都得先开一个 DSH 会话去点 `organ_call`。合体的另一半是「双向」：它们也得够得着我们。

### 变更
- 新增 **`bin/organ-call.mjs`**：`node bin\organ-call.mjs --ability <名> [--content …] [--args <JSON>] [--who …] [--timeout …] [--root …] [--dry-run]`——同一道门口搬到命令行，名片 → 安全插件的门 → 公共那只手 → 回执；`--who` 写进痕迹与派单回执；输出一行 JSON，退出码 0/1。
- `package.json` 加 `bin.tongwen-organ-call`，`files` 收 `bin`；版本 0.5.14。

### 现场自测（07:03）
- `blackhole.index.read --dry-run` → `exists:true, size:6641`（读到外部插件写进我们 self/context 的索引）。
- `tongwen.note.append` 真跑 → 门 `allow`（reason「write 类：记账放行（v2 口径）」）→ 写进 `logs/organ-notes.md`（256B）→ `logs/organs-exec.jsonl` 两行 prepare / done 都带 `who:"cli-selftest"`。
- 未知能力 → `NO_ORGAN`，并列出全部 25 个已知能力名。

### 口径
- 入口只是「多一个够得着的门」，判定权没变：还是安全插件说批不批；留痕还是那两处（`logs/organs-exec.jsonl` + 账本）。
- 命令行里没有会话，`who` 由调用方自己报（`--who`），报什么写什么，不猜。
- 谁都能跑 ≠ 谁都能写：`write`/`danger` 照样过门，只有 `read` 直做。

## 0.5.13（2026-11-06，握手只认硬证据：删掉「静默 20 秒算收手」）

### 背景
06:45 那轮握手把安全插件杀了：它当时正在跑一条三十秒的脚本，三十秒里不写会话文件，旧规则「静默 20 秒 = 收手」就把它判成收手，天花板从 120 提前到 25，一刀切下去。它没有闲，只是没说话。你 06:53 拍了：「可以」——改成只认硬证据。

### 变更
- **`lib/handshake.js`**：`AUTO_CEILING_SEC` 120 → **90**；删掉 `AUTO_GRACE_MS`，换 `AUTO_ACTIVE_MS = 10 * 1000`（最近 10 秒动过 = 醒着；一直没动 ≠ 闲着）。`computeReadiness` 只认两种证据：`all-acked`（别的时空全 ack）或 `quiet`（没有任何未完成的 open-task，且没人 10 秒内动过）；`pending` 每项带 `working` / `idleSec`，`openTasks` 列出别人挂着的活；`describeReadiness` 把「沉默不算证据」说清楚。
- **`index.js`**：`restart_dsh` 的 spec 描述、arm 注释、`auto.activeMs`、`autoText`、开场「你自己会的事」那句、每 3 秒定时器注释，全部改成硬证据口径（开场会直说「沉默不算证据」）。
- **`lib/restart.js`**：156 行注释同步（只认硬证据）。
- **`scripts/smoke-tools.mjs`**：握手用例标题改「只认硬证据（0.5.13：沉默不算证据）」；新增两段回归——挂着未完成任务时静默到 10 分钟也**不许**提前（`evidence:null`），把任务清掉后才 `evidence:"quiet"` 提前。
- **`./tongwen\handoff\规范\重启.md`**：整节重写成 0.5.13 口径（事故经过、两种证据、90 秒天花板、边界「没动不能证明闲着」、历史段标注 0.5.6–0.5.12 已废）。

### 口径
- 沉默不是证据：没在说话不等于没在干活；提前只看 ack 和 open-tasks。
- 拿不到证据就等 90 秒天花板——不会永远等，也不会误杀。
- 治本两条：**攒批发版**（别连发五次重启）、arm 前先读各项目白板「当前一棒」看谁在干。

### 测试
- core 37 / tools 37 / session 13 / cross-session 15 = **102 全通过**。

## 0.5.12（2026-11-06，派单回执带 who、外部插件事件按 id 去重、心跳踩坑写进规矩）

### 变更
- **派单回执带 `who`**：`organ_call` 现在把调用方会话 id（`runtime.sessionId`，老调用方挂在 `ctx.sessionId` 上也能兜住）写进回执、`logs/organs-exec.jsonl` 的 prepare/done/delegated 三行、以及账本两条记录。安全插件 baton 点的：「门批了得知道是谁请求的」。
- **器官事件按 id 幂等入库**：`ingestOrganEvents` 给每个器官在 `logs/organs-state.json` 里存 `seenIds`（最多 500 条），同 id 的事件跳过；record 里多带 `eventId` 与 `owner`（取 `payload.owner`）。外部插件那边 id 形如 `evt-external-plugin-<毫秒base36><4位计数器>`，只追加不复用，正好能用。
- **`payload.owner` 入库**：外部插件按「整份 profile 归谁」给，默认 null；书同文原样记进账本，供反查项目用。

### 口径
- `who` 只是「谁请求的」，不是权限：门还是安全插件判 write/danger，who 只用于追责与对账。
- 去重只按 `id`，没有 `id` 的事件照旧入账（老器官不强制升级）。
- 心跳文件必须是**每轮无条件重写**的文件：锁文件（`watchdog.pid`）只在启动写一次、`remote-watchdog.state` 只在状态变化时写，两个都会误报「停跳」。safety-kit 已改指 `state/STATUS.json`（watchdog 慢循环每 ~5 分钟重写），ttl 900000。

## 0.5.11（2026-11-06，派单的 args 不再丢）

### 修复
- `organ_call` 的参数 `args` 原来写死 `type:'array'`（那是给命令用的），但 `tool` 类派单要的是**对象**（工具参数键值对）——传对象时会被 schema 吃掉，回执里 `exec.args` 变成 `null`。安全插件 06:20 合体验收时撞上并报了过来。
- 改法：`args` 不再写死类型，描述里写明「命令给数组、派单给对象、JSON 字符串也认」；`lib/organs.js` 新增 `normalizeDelegateArgs()`：对象原样、JSON 字符串试解析、数组仍留给命令。冒烟补一条字符串参数的派单断言。

## 0.5.10（2026-11-06，心真去量脉搏、手能查「做成过没有」）

### 变更
- 以前「心」只是名片上写着一条路径（`health.path` + ttlMs），从没真去碰过——器官停了也显示「接上了」。现在 `organList` / `check-organs.mjs` 会**真的 stat 那个文件**：最近刷过 = 活着，超过 ttl 没刷 = 停跳，文件没了 = 报「文件没了」。
- 新增 `probeHeart(card, now, dir)`：相对路径按器官目录解析（修：以前相对路径会落到进程 cwd，被误判成「文件没了」）；无 `health` 的返回 `{present:false}`。
- 新增 `lastExecOf(ctx)`：读 `logs/organs-exec.jsonl`，按器官汇总最近一条动作。`integration` 多三样：`handUsed`（`phase:"done"` 且 ok —— 真做成过事）、`handDelegated`（只派过单、还没真按下去）、`staleHeart`（心登记了但停跳/文件没了）。
- `scripts/check-organs.mjs` 矩阵加「脉搏」「手用过」两列，末尾单独报一行停跳名单；`--json` 输出带 `staleHeart`。
- 修 safety-kit 名片的心跳指向：原来指 `state\watchdog.pid`（启锁文件，只在进程启动时写一次 → 必然误报停跳），改指 `remote-watchdog.state`（`remote-watchdog.ps1` 每 ~20 秒刷一次）。名片在 `bridge-kit\plugins\safety-kit\organ.json`。

### 现场验证（0.5.10 代码 / 0.5.9 进程）
- `check-organs.mjs`：头 5 / 手 2 / 脚 5 / 心 5；`✓ 所有器官都至少接了头 + 脚`；`✓ 登记了 health 的器官脉搏都在 ttl 内`。
- 脉搏：blackhole 2 秒前、persona 58 秒前、tongwen 21 秒前、safety-kit 2 分前（修好前是「停跳 2 小时」）、bridge-kit 2 分前。
- 手迹：tongwen 最后一条 `tongwen.note.append`（done，真写成过）；bridge-kit 最后一条 `bridge-kit.chat.send`（delegated，挂着等模型按）。

### 测试
四套冒烟 **102 项全过**（core 37 / tools 37 / session 13 / cross 15）；`tools` 新增「脉搏与手迹」用例：health 新写→活、删文件→没了、2 小时前→停跳；`organs-exec.jsonl` 里 done → `handUsed`，delegated → `handDelegated`。

## 0.5.9（2026-11-06，tool 类手接成「派单」）

### 变更
- 背景：`entry.type=tool` 那只手是**模型自己手里的工具**（`mcp__external-bridge__qq_send_message`、`mcp__external-bridge__qq_bili` 等）。查过 DSH 打包代码（`app.asar`）：插件侧只有 `ctx.tools.register`，`executeToolCalls` 属于 agent 循环内部函数、不对插件暴露——插件按不动别人手里的工具。
- 所以 `tool` 不假装执行，改成**派单**：门（安全插件）照常批、`logs/organs-exec.jsonl` 照常留 `prepare`；门批了以后回执写明「按哪个工具、带什么参数」，由调用方（模型）真按下去。exec 日志记 `phase:"delegated"`，账本记 `organ.call(delegate:ok)`。
- `lib/organs.js`：新增 `delegateTool(entry, input)`；`organCall` 的 write/danger 分支区分「派单」（`executed === false`）与真执行，回执多带 `needsActor:true` 与一句大白话说明。
- 冒烟新增：`echo.tool` 走真门 → `exec.mode==="delegated"`、`exec.executed===false`、`exec.tool` 与 `args` 原样回执、`logs/organs-exec.jsonl` 有 `"phase":"delegated"`。
- 契约页 §六 边界改成「`tool` 类=派单，不是插件替你按」，§五 现状同步。

### 测试
四套冒烟 101 项全过（core 37 / tools 36 / session 13 / cross 15）；`tools` 里新增了 `echo.tool` 的派单断言。

## 0.5.8（2026-11-06，手接上公共执行通路）

### 变更
- 你 06:04：「手你们通用啊，不用在另外写代码」→ 对齐成：**手是大家共用的那一双**，插件不各写一只手，只在名片上声明「用公共的手做什么」；缺的一直是**公共执行通路**：名片 → 门（安全插件）→ 公共的手 → 回执。06:05 你拍板：「门交给安全插件」「留痕」。
- `lib/organs.js` 的 `organCall` 接上执行器（**一份代码，所有器官共用**）：
  - `entry.type=file`：只读直读（不变）；`write`/`danger` 时用 `input.content` 落盘，`entry.mode:"append"` 追加。
  - `entry.type=cli`：`entry.command` + `entry.args` + 调用时追加的 `args`，`cwd` 缺省插件目录，超时 30 秒（`timeoutMs` 夹在 1–120 秒），stdout/stderr 回执。
  - `entry.type=http`：只认 http(s)，`method` 缺省 GET，AbortController 超时，body 截断 32KB。
  - `entry.type=tool`：还没接，如实回 `UNSUPPORTED_ENTRY`，不假装。
  - 只读能力只认 `file` / `http`（GET）——**只读不许跑命令**，要跑必须声明 `write`/`danger` 先过门。
- **留痕**：`write`/`danger` 每次动手前先往 `logs/organs-exec.jsonl` 写一行 `phase:"prepare"`，门拒了记 `denied`，做完记 `done` + ok + ms；账本同时记 `organ.call(gate:…)` 与 `organ.call(exec:ok|fail)` 两条。
- `organ_call` 工具描述改大白话，新增 `content` / `args` / `timeoutMs` 三个参数。
- 契约页 `handoff/规范/插件接口与合体契约.md`：删掉「手还举在半空」的说法，改成「手是共用的那一双 + 四步通路 + 先留痕再动手」，§一 补三类 entry 的执行语义，§五 现状与欠账同步；`lib/layers.js` 的「接入契约」块同步成人话。

### 测试
- 器官用例扩展：门批后真写文件（内容落盘）、cli 真跑命令（stdout 回执）、`logs/organs-exec.jsonl` 有 prepare/done、只读+cli 明确拒绝、danger 无回执仍 `GATE_DENIED`。
- `package.json` / `organ.json` 升 0.5.8。

## 0.5.7（2026-11-06，规范必须带大白话）

### 变更
- 你 05:52：「你要解释一下手，不对，你应该把通俗的话写进规范里面，不然我每次都要说一遍我不好理解。」→ **规矩页从此必须带大白话**。
- `handoff/规范/插件接口与合体契约.md` 新增「## 〇、大白话版」：四个插头用日常话重讲（头=猫眼、手=能干活但可能打碎碗、脚=雪地脚印、心=摸脉搏），并单列「为什么一直说手还只是名片」和「你需要知道的三件事」；页尾新增「## 七、写规范的规矩」。
- `handoff/规范/信息分层.md` 新增第十三节：任何一页规范开头必须先讲人话、术语第一次出现要跟一句解释、已有的契约页按此改过。
- `lib/layers.js` 的「接入契约」块从字段名改成大白话，并补一句「手还举在半空、没真拧过螺丝」与「规矩要写大白话」的提醒（生成物每次重排都会带上）。

### 测试
- 四套冒烟 **101 项**全过（core 37 / tools 36 / session 13 / cross 15）。

## 0.5.6（2026-11-06，握手式自动重启）

### 变更
- **重启从「等固定秒数」改成「等大家收手」**（你 05:41：「你忘了广播吗，广播加上痕迹追踪我觉得完全可以实现自动重启而不破坏别的时空」）：`restart_dsh(action="arm")` 不填 `delaySec` 时不只算档位——
  - 现场只有我在动 → 直接排 25 秒；
  - 有别的时空在动 → 先按**天花板 120 秒**排一个一次性任务（保底一定会断），广播记 `mode:"auto"`；
  - 别的时空收完自己那轮调 **`restart_dsh(action="ack")`** 报「我收尾了」；没 ack 的按会话库 mtime **静默 20 秒**同样算停手；
  - 新增 `lib/handshake.js`：插件每 3 秒算一次就绪（公告满 20 秒 + 没人还在 20 秒内动过），就绪就撤掉天花板任务、改排 **25 秒**，并把广播 `etaAt` 改早（`promotedAt` / `promotedDelaySec` 防重复提前）；
  - 天花板到点无论如何断——不会「大家都不 ack 就永远不重启」。
- **`restart_dsh` 新增 `action="ack"`**：握手回执；`status` 多给 `readiness`（还差谁、谁已 ack、是否已提前）。
- 广播新增字段 `mode` / `auto{ceilingSec,earlySec,minReadySec,graceMs}` / `acks` / `promotedAt` / `promotedDelaySec`；开场广播文案会提示「收完就 ack，别人都收手会提前断」。
- `handoff/规范/重启.md` 新增「0.5.6 起：握手式自动重启」一节（四步链路、回执怎么读、边界）。

### 测试
- 四套冒烟 **101 项**（core 37 / tools 36 / session 13 / cross 15）：新增「握手式自动重启：ack/静默后天花板提前到 25 秒」用例（peer 3 秒前还在动 → 不提前；ack 后注入 25 秒 → ready；`maybePromote` 换成 25 秒并把 eta 改早；再跑一次不重复提前；cancel 后 inactive）。

## 0.5.5（2026-11-06，重启分档）

### 变更
- **重启等多久不再拍脑袋**（你 05:22：「如果我在电脑前，一分钟还是太久了，不过要考虑别的时空停手」）：新增 `lib/presence.js`，`restart_dsh(action="arm")` 不填 `delaySec` 时按现场自动分三档——只有我在动 **25 秒** / 有别的时空 2 分钟内动过 **45 秒** / 有别的时空开着任务没收尾 **75 秒**。依据是会话库 `<DSH_HOME>/sessions/**/session-*/*.jsonl` 的最新 mtime（每次工具调用都会追加，秒级）+ 新文件 `logs/state/open-tasks.json`（`begin_task` 记一笔、`end_task` 划掉）。回执带 `delayTier` / `delayReasons` / `presenceText`。
- **`restart_dsh` 新增 `action="spaces"`**：列出最近活动过的时空、空闲多少秒、开着什么任务，用来确认「现在有没有别人在干活」。
- **开场现状**里那句「你自己会的事」不再写死 45 秒，改成当场算出来的这一档（例如「现在这一档是快档（25 秒：别的 28 个时空都静默超过 5 分钟）」）。
- `handoff/规范/重启.md` 补「0.5.5 起：等多久按现场自动分档」一节：三档表、判据来源、边界（mtime 只说明「最近动过」，不保证此刻不在写盘）、实测重启固有代价 13–26 秒。

### 修复
- **`scheduleRestart` 假成功**（0.5.1/0.5.2 两次现场失败，node 侧 `taskReady:false` 且子进程报错被吞）：`spawn(detached)+unref` 改成 `spawnSync` 前台等脚本跑完，stdout/stderr 原样带回，退出码非 0 直接报错；`dryRun:true` 会传脚本的 `-DryRun`（只打印不注册），用来安全验证通路，不必真重启。

### 测试
- 四套冒烟 **100 项**（core 37 / tools 35 / session 13 / cross 15）：新增「重启分档：按现场自动选 25/45/75 秒」用例（假会话库造 10 分钟前/5 秒前两档、开了 open-task 进慢档、划掉回常档、自己不参与判断、arm 不填 delaySec 的回执带档位、`action="spaces"` 回 total）。


## 0.5.4（2026-11-06，长期维护第一班）

### 变更
- **开场加两条规矩**（复测时空 05:14 提的）：①「① ② ③ + `handoff/项目总览.md` + 两个索引都是**生成物**，要改就改源头，手改下次重排就没了」；②「开场为了看清局面先截图、看屏幕，不算翻别的地方；但别顺手读别的文件、别翻旧交接」。同两条写进 `handoff/规范/信息分层.md` §十二。
- **`end_task` 的 `next` 写进交接正文**：以前它只发信箱和白板，机器版第 6 段、用户版第 4 段都读不到「下一步交给谁」。现在机器版 §6 末尾有「**下一步（交给谁）**」，用户版 §4 有「接下来是这些（每条后面都写着交给谁）」。
- **用户版第 3 段改口径**：那行原来写「下次可能要做什么」却塞的是 blocked；现在写「卡住的地方」，下一步归第 4 段。

### 修复
- **决策行日期用北京时间**：`lib/projects.js` 原来直接截 UTC 日期，北京 0–8 点写的决策全记成前一天（04:54 做的 0.5.3 在总览里显示 2026-11-05，被两个时空各提过一次）。历史数据里能证明是 11-06 凌晨的 43 行也一并改回（备份在 `archive/trash/projects-before-datefix-20261106/`）。
- **驾驶舱待办里的账本路径**：`handoff/projects/cockpit-plugin.md` 第 22 行 `handoff\账本` → `logs\账本`（项目总览第 205 行那条挂账的源头）。
- **补齐 `2026-11-05-0032-书同文 → 神经系统：口径修订` 的用户版**：机器版当时有、用户版漏了，按机器版补写（内容不增减）。

### 测试
- 四套冒烟 99 项（core 37 / tools 34 / session 13 / cross 15）：新增「next 字段写进两份交接」用例（机器版 §6 与用户版 §4 都要出现「交给 any」，用户版第 3 段不许再出现「下次可能要做什么」）。


## 0.5.3（2026-11-06）

### 变更
- **三块板块的读序写死**（你 04:49 实测反馈：新时空第一件事没读规范、先去翻别的板块）：开场注入删掉「⓪ 先看 README 挂账」，改成 ① 规范总览（第一层，规矩）→ ② 动态白板（第二层，现在）→ ③ README（第三层，目录），并明写权重 **规矩 100 ＞ 现在 90 ＞ 目录 80** 与「没读 ① 之前不要打开 ②③」。`handoff/规范总览.md` 顶部同步加「## 先读哪一块（权重写死，读序不许倒）」。
- **九档复原**：重启广播从 `state/restart-broadcast.json` 挪到 `logs/state/restart-broadcast.json`，顶层 `state/` 目录软删进 `archive/trash/state-20261106/`——以前它让顶层变成十档，与硬规则冲突。
- **索引双口径**：`handoff/索引/交接索引.md` 抬头改成「在用的交接 N 份（已按内容去重；磁盘上实际 M 份，其中 M−N 份是旧命名重复副本）」，以前写「87 份」却和实际 93 对不上。
- **教训索引自动补登**：`writeHandoffIndex` 写完顺手扫 `handoff/教训日记/*.md`，索引里缺的自动补行（本次补了 6 篇）。

### 修复
- **广播重启后磁盘一直 pending**：`readBroadcastSync` 派生 completed 时把 `status:'completed' + completedAt` 写回文件，内存与磁盘一致。
- **项目总览渲染出 `[object Object]`**：decisions / issues / todo 统一走 `itemText()`（字符串原样，对象取 text/action/what/note/title），不再 `String(obj)`。
- **行首双日期**：`project_upsert` 自己会加时间戳，历史数据里文本又带日期，渲染时用 `progressText()` 去掉重复的前导日期。
- **README 三条幽灵条目**：只有旧命名、又没进索引的交接以前一律标「在办」，现在标「历史·旧命名副本」、项目列 `—`，不再冒充新活。
- `handoff/projects/blackhole-plugin.md` 的 5 行 `[object Object]` 待办按 03:37 备份补回。

### 测试
- 四套冒烟 98 项（core 37 / tools 33 / session 13 / cross 15）：新增读序断言（① 必须先于 ②③、不许再让 README 抢第一步）、幽灵条目断言（旧命名副本标「历史·旧命名副本」）、规范总览「先读哪一块」断言。


## 0.5.2（2026-11-06）

### 变更
- **总目录权重重排**（你 04:28 要求，为开新时空测试）：`handoff/README.md` 从「挂账 → 文件/插件/工具/A盘 → 在办/清单 → 已归档」改成 **挂账 → 一·在办 100 → 二·清单 90 → 三·文件 80 → 四·插件 70 → 五·工具 60 → 六·A盘 50 → 七·已归档 10**。理由：新时空第一眼看的是「我现在该接哪件事、上一棒到哪了」，找东西是被派活之后才需要的。顶部权重行、开场注入里的段落提示、`lib/catalog.js` 头注释同步改。

### 修复
- **重启广播不复位**（别的时空 04:30 报的可复现 bug，inbox `ib_01M6PPFS4E6RSSTQ2QGR9CV9AR`）：重启换进程后，旧广播的 etaAt 早于新进程出生，但 `readBroadcastSync` 只按「etaAt ≤ now → inflight」推状态，于是重启完成后 10 分钟内每个新时空开场都在喊「重启进行中，别开新活」，动态白板也照抄。现在模块加载时记 `LOADED_AT`，`etaAt > 0 && LOADED_AT > etaAt` 判 `status:'completed'`（`expired:true`），`pendingBroadcastSync` 自然返回 null；同一进程内 eta 未到仍 pending、到了仍 inflight。`pendingBroadcastSync` / `readBroadcastSync` 都加了可注入的 `loadedAt`，便于单测。
- **`restart_dsh` 排程真机仍失败**（0.5.1 只换了 `pwsh.exe`，还是没建出任务）：新增 `resolvePwsh()`，默认写死 `C:\Program Files\PowerShell\7\pwsh.exe`（不存在再退 preview / Windows PowerShell / 命令名），`scheduleRestart` 用它。

### 测试
- smoke-tools：总目录用例改成断言**小节顺序**（在办 → 清单 → 文件 → 插件 → 工具 → A盘 → 已归档）与顶部权重行；广播用例补「eta 早于本进程出生 → completed、不再提醒、不误伤进行中的广播」。四套合计 98 项。

## 0.5.1（2026-11-06）

### 新增
- **插件接口与合体契约写进第一层**：新增 `handoff/规范/插件接口与合体契约.md`（名片字段、头/手/脚/心四点、双向合体、事件格式、自查三条、现状表）；`renderNormsPage` 把这份契约钉在 `handoff/规范总览.md` 最上面（「接入契约（所有做插件的时空必读）」+ ⭐ 行置顶），新时空第一眼就看到「插件怎么接进来」。
- `lib/organs.js` 新增 `connectPointsOf(card)`：把名片拆成 头（read 能力）/ 手（write|danger）/ 脚（events.path）/ 心（health.path + ttlMs）；`organ_list` 每行加 `connect`，顶层加 `integration`（online / connected / missingHead / missingFoot / missingHeart / missingHand）。三点以上且只缺手算「接上」——不是每个插件都该有动手能力。
- 新增 `scripts/check-organs.mjs`：合体矩阵（头手脚心 + 缺点），缺头或缺脚 exit 1。
- 书同文自己的 `organ.json` 升到 0.5.1：补 `health`（`runtime-state.json`，ttl 10 分钟）与 `tongwen.norms.read`（读规范总览）。

### 修复
- `restart_dsh` 的 `scheduleRestart` 静默失败：Windows 上 `spawn('pwsh', …)` 解析不到命令名，进程起了又退、计划任务根本没建（0.5.0 现场靠手敲脚本才重启成功）。改用 `pwsh.exe`，起完后 `schtasks /Query /TN dsh-restart-once` 确认（最多等 8 秒）；查不到就返回失败，并把刚写的广播改成 `cancelled`，不再留假广播骗人。

### 测试
- smoke-tools 增加「规范总览顶部接入契约 + 契约行置顶」与「合体四点（含 organ_list integration 统计）」用例。四套合计 98 项。

## 0.5.0（2026-11-06）

### 新增
- **三层信息**（你 04:10 要求）：`handoff/规范总览.md`（第一层：扫 `handoff/规范/*.md` 出的规矩清单）→ `handoff/动态白板.md`（第二层：在办项目按 P0–P3 排、各自的当前一棒/挂账、未接请求、重启广播）→ `handoff/README.md`（第三层：总目录，保持原样）。三层都在 `end_task` / 启动时一起重写，不手改。
- 开场注入按「⓪ 挂账 → ① 规范总览 → ② 动态白板 → ③ 总目录 → ④ 交接按项目找…」重排，并把「三层信息」写进现状行。
- **重启广播**：新工具 `restart_dsh`（`action=arm|status|cancel`）。`arm` 先写 `state/restart-broadcast.json`（by / reason / delaySec / etaAt / status），再调 `restart-dsh-later.ps1` 排程；每轮开场与 `begin_task` 都会读广播并提醒「收尾，别开新活」；`cancel` 撤广播并尽力删掉已排任务。
- `state/restart-broadcast.json` 是同一台机器所有时空共用的文件（不是消息总线）；10 分钟后自动算过期。

### 规范
- 新增 `handoff/规范/信息分层.md`（三层为什么分、谁写哪页、别手改）。
- `handoff/规范/重启.md` 改成广播版：先 `restart_dsh` arm、再排程；手敲脚本只用于工具不可用时。

### 测试
- 四套冒烟 95 项全过（core 37 / tools 30 / session 13 / cross 15）；冒烟里 `restart_dsh status` / `cancel` 只读不真杀。

## 0.4.9（2026-11-06）

### 新增
- `end_task` 采到 `verify:` 行后，把白名单内、解析成功的断言翻成 claims，交给安全插件的执行器 `safety-kit 的 bin/verify.mjs --stdin` 拿现实去验（相对路径按交接根目录解释；`file-exists` / `file-hash` / `cmd` / `port` 有明确映射，其余类型原样交过去由它 fail-closed）。
- 裁决落到 `logs/verify-verdicts.jsonl`（每次归档一条：verdict / total / failed / round / summary / ms），返回体带 `verifyVerdict`。
- `deny` 时给一条警告（`verify 不一致（failed/total 条）：<summary>`），但**不阻断归档**——规范 §九 要求先只扫一周、把误报压下来，再谈降 partial 或直接打回。
- 执行器路径可用环境变量 `TONGWEN_VERIFY_SCRIPT` 覆盖（测试/换机用）；执行器不在时只警告「断言只记录，没有裁决」，不报错。

### 测试
- smoke-tools 把原来的「只记不拦」用例升级为「采集 + 裁决」：断言三条 `verify:` 都登记、只送解析成功的两条、`verify-verdicts.jsonl` 每次归档恰好一条、返回体的 `verifyVerdict` 与文件里那条一致。四套冒烟 95 项全过（core 37 / tools 30 / session 13 / cross 15）。

## 0.4.8（2026-11-06）

### 新增
- `end_task` 扫描交接正文里的 `verify: <类型> <目标>` 行（白名单 file-exists / file-hash / cmd / port / json-field / http / proc），逐行登记到 `logs/verify-scanned.jsonl`，返回体带 `verifyClaims`。**只记不拦**：不阻断归档、不改判定，先跑一周看格式稳不稳定，再和安全插件谈「不一致就打回」。
- 总目录「一 · 文件」新增「要往公开仓库传代码」一条：先读 `handoff/规范/上传仓库前的隐私清洗.md`，活目录有 pre-push 保险丝，公开仓库只从 `scratch/publish/` 的干净副本推。

### 修复
- 交接清单与交接索引重复：同一份交接在迁移期时常留下「新命名 `<日期>-<时分>-<总结>.machine.md`」和「旧命名 `<总结>.machine.md`」两份文件，`listHandoffFiles` 各算一份，导致总目录、索引里每条出现两次。现在按「同一天 + 同主题」去重，同 key 优先保留新命名。
- `PLACEMENT_ROWS` 里补上隐私清洗规范一行（该表是给阅读者看的放置表）。

### 测试
- smoke-tools 新增两条：`verify:` 行只记不拦（三条示例、其中一条不认识的白名单外类型标 `parsed=false`）、同一份交接的新旧两种命名在清单里只算一行；总目录断言加「隐私清洗规范」。四套冒烟 95 项全过（core 37 / tools 30 / session 13 / cross 15）。

## 0.4.7（2026-11-05）

### 新增
- `end_task` 增加三个可选自评参数：`attempts`（真实返工几次）、`factsCited`（已确认事实被引对几条）、`factsWrong`（写错/被推翻几条）。没给就不写，不拿默认值冒充事实。
- 归档时把自评落到 `logs/账本/data/self-reports.jsonl`（按 entryId 认领）。账本采样（`ledger 工具\autosample.mjs`）下一次运行把它转成 strong 样本（`weak:false`），进 A 与 k* 拟合；自动采样出来的 weak 样本仍然只进 ρ 与成本。

### 修复
- 账本 `ledger.mjs`：同一 taskId 先有 weak、后有 strong 时，strong 一律胜出（之前会被晚写的那条盖掉，A 永远算不出来）。

### 测试
- smoke-tools 新增「0.4.7 自评落进账本 self-reports.jsonl」；四套冒烟 93 项全过（core 37 / tools 28 / session 13 / cross 15）。

## 0.4.6（2026-11-05）

### 修复
- 「重启」写进现状时指错了路：原文让人直接跑 \restart-dsh.ps1——那是「立刻杀」，会连带所有时空一起断（19:37 外部插件时空就是这么把书同文杀掉的）。
- 新增规范页 handoff/规范/重启.md（书同文侧口径）：先回话 → \restart-dsh-later.ps1 -DelaySec 30 排延迟 → 不要 Start-Process/WMI/手搓 schtasks → 10 分钟内最多重启 3 次。
- 总目录「一 · 文件」与放置表 PLACEMENT_ROWS 登记「重启 DSH 的正确姿势」，新时空不用翻手册也能找到。
- \restart-dsh-later.ps1 改为经 \run-hidden.vbs 以窗口样式 0 启动（任务计划直接拉 pwsh.exe 会闪黑框），并在文件头写清三种翻车路径。

### 测试
- smoke-cross-session 断言改为：现状必须出现 \restart-dsh-later.ps1、规范/重启.md、「不要直接跑 restart-dsh.ps1」。四套冒烟 92 项全过（core 37 / tools 27 / session 13 / cross 15）。

## 0.4.5（2026-11-05）

### 新增
- 交接「按项目寻址」：机器版/用户版交接头两行新增 `> 项目 <项目id> · 交给 <会话id/项目id/any>`，正文要求一句「做到哪、你从哪接」；`end_task` 新增 `project` / `to` 参数（不填沿用 `begin_task` 的 project，`to` 默认 any）。
- 总目录「五 · 在办」每个项目下面直接挂「当前交接：<文件>」——新时空认领项目后只读那一份就够了，不用翻几十份。
- 交接索引重写：顶部新增「## 按项目看」（项目 → 最近一份 + 路径），总表新增「项目」「交给」两列；已移进 `archive/` 的旧交接会标「（已归档）」。
- 开场第②步改为「交接按项目找：看『五 · 在办』每个项目的『当前交接』→ 只读那一份（头两行写着项目/交给，对不上就不是给你的）→ 对不出来直接问用户『我是来接哪个项目的？』」。
- 《交接规范》新增「归属三行（0.4.5 起必须有）」与自检项「归属对」。

### 修复
- `lib/index-store.js` 的 `normalizeEntry` 白名单漏了 `project`、`to` 两个字段——写进去会被下一次读盘静默丢掉；已补进白名单。
- 「当前交接」以前只看 `lastUpdated`，会把已归档的旧交接推给新时空；现在优先在办那份，真没有才退回归档件并标注。

### 测试
- 总目录用例：清单表头改为带「项目」列，断言出现「当前交接」；新增交接索引断言（有「按项目看」、总表带项目/交给）。
- 开场用例：断言出现「当前交接」「我是来接哪个项目的」。
- 四套冒烟 92 项全过。

## 0.4.4（2026-11-05）

### 修复
- 总目录顶部权重行的「⚠ 挂账（0）」是写死的 0，和下面的挂账小节（按实际条数）对不上；改成同一个数字（`openIssues.length`），顶部和小节再也不会分叉。
- 项目总览的时间全是 UTC 截断（「停在 11-04 21:16」其实是 11-05 05:16 的交接），时间统一转成北京时间显示。
- 项目总览补「最近一次交接」行，排行榜的时间列改名「白板更新」，并注明白板时间可能比交接旧——两张时间不再被混着看。
- 交接索引从一次性脚本改成插件自动生成：启动、`end_task`、`project_upsert` 后都会重写（`handoff/索引/交接索引.md`）；旧命名（如 `release-0-3-23.machine.md`）也按文件时间补进索引，不再漏份。
- 索引里的时间戳有两套来源（`runtime.index` 裸索引 / `ensureIndex()` 返回的 `{index,...}` 包装），两处都兼容；以前包装形态进不来，「最近一次交接」一直显示「（还没有）」。
- 开场「项目：N 个」改成每轮从磁盘现数（十来个文件名），不再吃异步刷新的缓存——以前会出现「开场 13 个 / project_list 14 个」。
- 现状里新增一行「你自己会的事：重启 DSH 只走 `safety-kit\bin\restart-dsh.ps1`；不要用计划任务/Start-Process 重启」——新时空不用再自己翻手册。

### 测试
- 总目录用例加断言：顶部挂账数必须等于小节数（0.4.4 回归）。
- 项目总览用例加断言：必须有「最近一次交接」和「白板更新」。
- 开场用例加断言：现状里必须出现 `restart-dsh.ps1`。
- 四套冒烟 92 项全过。

## 0.4.3（2026-11-05）

### 新增
- 门口接上安全插件的 gate（联动契约 v2）：organ_call 遇到 sideEffect=write|danger 时，先往 organs.gateDir（默认 ./safety-kit/state/gate）写 <id>.request.json，等安全插件回 <id>.ack.json；拿到 allow 也只回「已放行、执行器未接」，不冒充执行；超时按拒绝（契约口径「超时=拒绝」）。
- 配置新增 organs.gateDir、organs.gateTimeoutMs（默认 3000ms，最小 200ms）；配表 41→43。
- 每次 gate 裁决都进账本流水（type:organ，带 verdict/reason/by/timeout）。

### 修复 / 变更
- organ_call 的 write/danger 分支原来直接回 NEEDS_GATE；现在是真去报备、真拿裁决。
- dryRun 遇到 write/danger 时返回 needsGate:true 和 gate 目录，方便先看要报到哪。

### 测试
- 冒烟 tools 27 项：新增假安全插件 stub（扫 request → 回 allow），覆盖 allow 后「执行器未接」、danger 无回执超时拒绝、dryRun 报备预览。
- core 配表断言 41→43。

## 0.4.2（2026-11-05）

- 交接总目录顶部新增「⚠ 挂账」段：所有在办项目的未解决坑，按项目列出，带条数；修好一条用 `project_upsert` 的 `resolve_issue` 撤掉。
- 开场第⓪步改成「先看挂账」，再走原来的一~七步——坑要在第一眼被看见，而不是踩到才发现。
- 原因：你指出「bug 挂账了，但你思考时没有第一时间看挂账」，权重不对。
## 0.4.1

### 修复
- organ_list 的回执里有 undefined 字段，宿主判「不是无损 JSON」直接拒收——现在只回 JSON 能无损表达的值，坏名片用 invalid 数组说明问题。

### 变更
- 多插件合体验证：安全插件（safety-kit）与邮差（bridge-kit）各自在插件目录放了 organ.json；一次扫描能看到 3 个器官。
- 实测跨器官读：safety-kit.status.read（1306 字节）、bridge-kit.role.read；写动作 bridge-kit.chat.send 仍被 NEEDS_GATE 挡住。
- 启动时从安全插件 state/events.jsonl 增量收事件进账本（本次收到 1 条）。

### 测试
- 四套冒烟 92 项全过（core 37 / tools 27 / session 13 / cross 15）。

## 0.4.0 —— 器官系统 v0（神经系统第一步：只认文件）

- 新增：器官名片约定 organ.json（id/name/version/kind/abilities[{name,entry{type,path},sideEffect}]/events.path），放在插件自己目录。
- 新增 organ_list：扫插件根（默认 `插件目录` 与 `bridge-kit\plugins`，可用 `organs.roots` 覆盖）里的名片，列出能力、危险等级、入口类型。
- 新增 organ_call：按名片把能力路由到器官；v0 只放行 `entry.type=file` 且 `sideEffect=read`；`write`/`danger` 一律返回 `NEEDS_GATE`（等安全插件 gate），`dryRun` 只探路。
- 新增：启动时读各器官的 `events.jsonl` 新行，追加进 `logs/账本/data/records.jsonl`（type=organ，按 offset 增量，单器官单次最多 200 条）。
- 新增配置：`organs.enabled`(true) / `organs.roots`。
- 原则：独立优先、只认文件不认函数、danger fail-closed；器官信息不进总目录（只放账本流水和插件卡）。
- 测试：冒烟 92 项（core 37 / tools 27 / session 13 / cross 15）。

## 0.3.28 —— 过期文件清扫报告（只报告，不删除）
 —— 过期文件清扫报告（只报告，不删除）

- 新增：`housekeeping_report` 工具，扫审计日志、账本日报、回收站、临时区，列出超过保留期的文件与体积。
- 新增：启动时每 7 天自动刷新一份 `logs/清扫报告.md`（配置 `housekeeping.reportEveryDays`）。
- 新增配置：`housekeeping.auditDays`(90) / `ledgerDays`(180) / `trashDays`(90) / `scratchDays`(14)。
- 不变的原则：**只列清单，不自动删**；删除仍必须软删进 archive/trash，删前先问你。
- 总目录「一·文件」登记报告位置与保留期。
- 测试：冒烟 91 项（core 37 / tools 26 / session 13 / cross 15）。

## 0.3.27 —— 数据文件版本备份 + rollback_data

- 新增：`project_upsert` 覆盖白板前自动留一份到 `archive/versions/_data/`（默认 10 版）。
- 新增：`rollback_data` 工具，按 path + version 回滚数据文件；回滚前再备份当前版，所以能滚回去。
- 新增：回滚通知，写 `logs/rollback.log` 与 `handoff/任务交接本/最近回滚.md`。
- 测试：冒烟 90 项。


## 0.3.26 —— 项目白板「挂账」：错误当场挂、修好当场撤

- 新增：白板固定六节 → 七节，多一节 `## 挂账`。发现错误/卡点就挂一条，修好就撤掉，交接时一眼能看见「现在哪有坑」。
- 新增：`project_upsert` 支持 `issue`（挂一笔）与 `resolve_issue`（按关键字撤一笔）。
- 改：`handoff/项目总览.md` 排行榜加「挂账」列，逐项目显示 ⚠ 挂账条目。
## 0.3.25 —— JSON 默认纯 ASCII 写盘

- 修：PowerShell 5.1 解析 UTF-8 无 BOM 的 JSON 会按 ANSI 读，中文变乱码、甚至报 `Invalid object passed in`。
- 改：新增 `lib/json-text.js` 的 `jsonText()`，索引、运行态、指针、快照四处写盘统一走它，非 ASCII 字符一律 `\uXXXX` 转义，落盘纯 ASCII。
- 改：`locale/zh.json` 一并转义成纯 ASCII。
- 注意：只改存储形式，不改语义；`JSON.parse` 读出来仍是原来的中文。
## 0.3.24 — 2026-11-05

修复：`package.json` 里的非 ASCII 字符（description 的中文与破折号）改成 JSON 的 `\uXXXX` 转义，文件变成纯 ASCII。Windows PowerShell 5.1 默认按 ANSI 读 UTF-8 文件时，中文会被读成乱码并让 `ConvertFrom-Json` 报「Invalid object passed in」；转义后 5.1 与 Node 都能正确解析，解析出来的 description 仍是中文。
说明：内容没变，只是存储形式变了；`index.js` 读 `version` 的路径也验证过。

## 0.3.23 — 2026-11-05

变更：`end_task` 归档完成后立刻重算 `handoff/项目总览.md`（不再等下次启动或下次 project_upsert），白板随每次归档动态更新；失败只记 warning，不阻断归档。
测试：tools 冒烟沿用 89 全过（core 37 / tools 24 / session 13 / cross 15）。

## 0.3.22 — 2026-11-05

新增：交接命名与归档规矩——文件名统一 `<日期>-<时分>-<内容总结>.machine.md`（user 版同名），查旧交接先扫 `handoff/索引/交接索引.md`，做完的交接移进 `handoff/machine/archive/<日期>/`。
新增：总目录「六·清单」改为扫盘生成（时间 / 内容总结 / 状态 / 路径，取最近 20 份），并链到 `handoff/索引/交接索引.md`；索引页登记新增「交接索引」。
变更：开场第②步提醒先扫交接索引；《交接规范》与自检清单写明命名/归档规则。
迁移：历史 61 份交接按新命名整理（45 份改名、27 份归档），索引路径与哈希同步修正。
测试：tools 断言改为「时间 / 内容总结 / 状态 / 路径」表与交接索引链接；cross 开场断言加 `handoff/索引/交接索引.md`。

## 0.3.21 — 2026-11-04

新增：日档规矩——除 聊天类时空外，每个时空每天收尾前写一份 `self/日档/<日期>-<时空名>.md`（五段：触点 / 我的想 / 变 / 我的回 / 回声），合体后能知道那天各自发生了什么。
新增：`self/日档/README.md` 规则说明、`handoff/规范/模板/日档.md` 模板、《交接规范》第七节、文件目录登记。
变更：开场第⑦步提醒写日档；总目录「一·文件」加日档一行。
测试：cross-session 开场断言加 `self/日档/`。

## 0.3.20 — 2026-11-04

### 新增
- **项目总览（第二张对齐图）**：`lib/catalog.js` 新增 `renderProjectOverview` / `updateProjectOverview`，生成 `handoff/项目总览.md`——项目总数与分档、按 P 权重排行、逐项目写出状态/待办数/当前一棒/最近 3 条进展/待办，已归档单列。
- 总目录「五·在办」加一条指向项目总览；开场第①步改成「先读总目录，接活前再读项目总览」。
- 启动与每次 `project_upsert` 后自动刷新项目总览（和总目录同一时机）。

### 修复
- `handoff/索引/工具目录.md`：账本两条路径改到 `ledger 工具\`，补 `record.mjs` 与 `restart-dsh.ps1`（`safety-kit\bin\restart-dsh.ps1`，重启 DSH 本体的真入口）。

### 测试
- 冒烟 89 全过：core 37 / tools 24 / session 13 / cross 15；tools 里项目用例新增项目总览断言，cross 开场断言新增 `handoff/项目总览.md`。
## 0.3.19 — 2026-11-04

### 新增
- **交接规范与模板**：`handoff/规范/交接规范.md` 把五种交接（机器版/用户版/插件卡/教训/账本记录）的位置、命名、必备段落、自检清单写死；`handoff/规范/模板/` 放五份可直接照抄的模板。
- **插件现状卡补齐 9 张**（总 16 张）：mall、skin-maid-atelier、billion-context、dsh-better-sidebar、dsh-builtin-browser、dsh-identity、dsh-session-surgeon、dsh-whale-widget、dshmarket；内容按各自 package.json 实查（版本/入口/是否 dsh.client/有无 agent 工具），总览在 `handoff/plugins/README.md`。
- **账本记录系统**：`ledger 工具的 record.mjs`（`--type test|bench|env|memory|model-assist|token|note --title --data …`）追加 `logs/账本/data/records.jsonl` 并重生成 `logs/账本/记录.md`；规范 `logs/账本/记录规范.md`（可复核、多次实验放 runs、写错补「更正」）。
- **使用排行**：总目录新增「使用排行（最近 30 份机器交接里的引用次数）」段，按被引用次数排前 8 个索引页/入口，与权重并存。

### 变更
- `lib/catalog.js`：「一·文件」加交接规范与账本记录两行；「二·插件」指向 `handoff/plugins/` 16 张卡；A 盘段扫描行保留；新增 `usageRanking(ctx)`。
- A 盘计划任务 `tongwen-disk-scan` 由每周日改为**每天 04:00**。

### 测试
- 冒烟 89 项全过：core 37 / tools 24 / session 13 / cross 15。

## 0.3.18 — 2026-11-04

### 新增
- **A 盘全盘目录（自动扫描）**：脚本 `disk-scan 脚本` 递归扫 `C:\` 的顶层目录与文件，统计大小/文件数/最近更新，生成 `handoff/索引/A盘目录.md`；「干什么的」来自 `disk-scan 脚本\a-drive-notes.json`（脚本不覆盖人工注解，新目录标「待认领」），并与上次扫描对比新增/消失/变大。
- **每周自动检测**：Windows 计划任务 `tongwen-disk-scan`（每周日 04:00）跑同一脚本；结果写 `logs/disk-scan/last-scan.json`，总目录「四·A盘」会显示最近扫描时间与总量。
- 总目录「四·A盘」段新增「最近扫描」一行（读 `logs/disk-scan/last-scan.json`，读不到就不显示）；`handoff/索引/文件目录.md` 登记 A盘目录页。

### 变更
- `lib/catalog.js`：新增 `aDriveScanLine(ctx)`，渲染 A 盘段时附带最近扫描摘要。

### 测试
- 冒烟 89 项全过：core 37 / tools 24 / session 13 / cross 15。

## 0.3.17 — 2026-11-04

### 新增
- **教训日记标准正式版**：`handoff/教训日记/README.md` 从草稿改为正式口径——文件名写「当时的现象」、标题带现象关键词、正文四段固定（发生了什么 / 根因 / 下次怎么做 / 证据路径）、同坑只留一条（再犯追加记录）、检索约定（先列全量、用现象词、搜不到要报搜过的词）。
- **教训索引页**：`handoff/索引/教训索引.md` 一行一条（日期 / 主题 / 一句话 / 路径），11 条现成教训全部登记；新写教训顺手加一行。
- **插件现状卡**：`handoff/plugins/<插件名>/README.md`，先给 7 张（dsh-tongwen、dsh-self-persona、bridge-kit、safety-kit、dsh-whale-sense、dsh-computer-use-win、dsh-game-stack），每张写「版本 / 位置 / 怎么调起 / 坑 / 最近状态」；总览 `handoff/plugins/README.md`。

### 变更
- `lib/catalog.js`：`INDEX_PAGES` 增加「教训索引」；「一·文件」段补教训索引与插件现状卡两行；`PLACEMENT_ROWS` 同步；段标题从「索引四页」改为「索引页」。
- 修 `2026-11-01-交接链路事故合集.md` 为四段结构（原来只有分条，没有四段标题）。
- `handoff/索引/文件目录.md`：补教训索引、插件现状卡两行；账本两行改为新位置（`logs/账本/`、`ledger 工具的 ledger.mjs`）。

### 测试
- `smoke-tools` 总目录用例补两条断言（链到教训索引、写清插件卡位置）。
- 冒烟 89 项全过：core 37 / tools 24 / session 13 / cross 15。

## 0.3.16 — 2026-11-04

### 新增
- **账本进总目录**：交接总目录「一·文件」段新增一行——账本在 `logs/账本/README.md`（每 10 分钟自动更新），脚本 `ledger 工具的 ledger.mjs`，计划任务 `tongwen-ledger`；并注明它是独立记录系统、只看不改，记忆容量采样设计稿在 `handoff/machine/2026-11-04/ledger-memory-economics.machine.md`。

### 变更
- 账本从 `handoff/账本/` 迁到 `logs/账本/`（台账归 logs 档），脚本从 `scratch/` 迁到 `ledger 工具\`，计划任务指向新路径。
- 账本新增 V4.1-Flash 峰谷计价：缓存命中 0.04 / 未命中 2 / 输出 8 元每百万（高峰=北京时间周一至周五 9:00–12:00、14:00–18:00，其余半价，节假日读 `data/holidays.json`），日报与周表同时给「账面实扣」和「估算」。

### 测试
- 冒烟 89 项全过：core 37 / tools 24 / session 13 / cross 15。


## 0.3.15 — 2026-11-04

### 新增
- **交接总目录改版（权重七段）**：`lib/catalog.js` 的 `renderCatalog` 现在按 `一·文件(100) → 二·插件(90) → 三·工具(80) → 四·A盘(70) → 五·在办(60)·当前一棒 → 六·清单(50) → 七·已归档(40)` 七段输出，每段只放「位置 + 一句话」；开头两句写清「从上往下按权重看」「别把全部交接读完」。
- **索引四页只链不覆盖**：新增 `INDEX_PAGES`（文件 / 插件 / 工具 / A盘目录），总目录只列链接并标注「手写，插件只链不覆盖」；细则由人写，插件启动/归档不会改那四页。
- 文件段保留九档一句话 + 交接位置一行 + 「教训写哪 / 电脑现状写哪」 + 机器读的 `index.machine.json`。

### 变更
- 原「文件放哪」表并入「一·文件」段，`PLACEMENT_ROWS` 仍导出但不再渲染；「当前一棒」保留 P0–P3 排序；「已归档」单列第七段。
- 仓库 `README.md` 同步：目录树补 `索引/`、`教训日记/`、`任务交接本/当前状态.md`、`能力目录.md`、`时间交接/`，总目录说明改为七段权重。

### 测试
- `smoke-tools` 目录用例改断言新七段标题与索引页链接、归档用例改断言 `## 七 · 已归档（40）`。
- 冒烟 89 项全过：core 37 / tools 24 / session 13 / cross 15。
## 0.3.14 — 2026-11-03

### 变更
- **九档说明纠正**：`self/` 不再写成「给用户看的报告」，改为「关于我自己的抽屉：persona、记忆、日记与
  自我记录」；给用户看的报告一直在 `handoff/user/`。总目录「目录职责」与「其它文件」两处同步。
- `handoff/self/README.md` 重写：说清它只放会话变更日记（默认统计 `handoff/` 交接区），不是报告目录；
  九档 `self/`（`./tongwen\self\`）才是 persona/记忆那类自我数据。

## 0.3.13 — 2026-11-03

### 新增
- **项目白板带优先级**：`project_upsert` 新增 `priority`（`P0` 立刻做 / `P1` 本周 / `P2` 有空 /
  `P3` 以后，默认 `P2`），写进白板头行；`project_list` / `project_read` 一并返回。
  `handoff/README.md` 的「当前一棒」按 P 级排序并显示 `[P0]`，新人一眼能看出先干哪个。

### 变更
- **做完自动归档**：`project_upsert` 传 `status: "done"` 时，白板自动从 `handoff/projects/`
  搬进 `handoff/projects/done/`；总目录里「当前一棒」不再列它，只在「已归档项目」留一行。
  重新激活（`active` / `paused`）会自动搬回来。
- `project_upsert` 写完顺手刷新 `handoff/README.md`（以前要等启动或交接归档才刷）。

### 测试
- tools 冒烟新增「项目优先级与做完归档」用例（P 级进总目录、done 后搬进 `done/`、旧位置清掉、
  归档后不再出现在「当前一棒」）。

## 0.3.12 — 2026-11-03

### 变更
- **版本备份默认保留 10 份**（`archive.keepVersionsK`：5 → 10）。这是插件里唯一会真删旧文件的
  路径（`archive/versions/` 清理）。安全插件（safety-kit）要求「不可永久删除」，先放大窗口；
  等安全插件执行器上线（S1/S2）后，这次清理会改成「交给执行器删 + 落审计」。
  取值范围仍是 1–1000，`settings.json` 可覆盖。

## 0.3.11 — 2026-11-02

### 新增
- **开场第⑥步：先看能力目录**。开场简报多一行，提醒先翻 `handoff/能力目录.md`（本机由
  `能力目录脚本` 生成：扫 DSH 内置技能 + 已装插件自带的 SKILL.md，
  写清「技能名 / 能干什么 / 怎么调起 / 出处」），里面没有的再去 `market_search` 现找现装。
  能力目录本身是普通交接文件，不占插件代码。

### 测试
- cross-session 开场断言补一条：必须提到 `handoff/能力目录.md`。

## 0.3.10 — 2026-11-02

### 修复
- **开场改成每轮都带**：0.3.9 按会话 id 记「开场出过没有」，实测新会话仍然只拿到短版——宿主在
  `session/created` 之前就把系统提示拼好了，按事件重置的写法赶不上。这轮不再赌时序：开场五步
  （先读总目录 → 只读当前一棒 → 白板只读相关项目 → 路径先查证 → 教训/状态写哪儿）每轮都随
  primer 发出，新会话第一眼就能看到；代价约 100 token/轮。
- 删掉 `state.primerServedFor` 与 `session/created` 里的重置逻辑，少一处依赖宿主时序的状态。

### 测试
- cross-session 用例改为断言「每轮都在」：同一会话连续取两次都带开场；模拟 `session/created`
  后的新会话同样带开场与根目录。
- 四套冒烟：core 37 / tools 23 / session 13 / cross 15 = 88 项全过。

## 0.3.9 — 2026-11-02

### 修复
- **新会话拿不到「开场必读」**：原来用进程级布尔 `primerServed` 记「这个进程出过开场没有」，
  同一进程里开新会话时，系统提示在 `session/created` 重置标志之前就拼好了，新会话看不到开场五步
  （实测：新会话要自己去翻 `index.js` 才知道有这套规矩）。改成按会话 id 记
  （`primerServedFor`），并且取「活会话 id」而不是初始化时的缓存值；`session/created` 只清标记。

### 改进
- **交接根目录写进开场和现状**：开场第一行就是 `交接根目录：<实际 root>`，并说明「下面所有
  `handoff/...` 都相对它；换盘/换电脑以这里为准，别猜」；每轮的「现状」也多一行根目录。
  根目录来自运行时配置（cordis patch 的 `root`），代码里没有写死。
- 开场④补一句「只在上面那个根目录里找，别在别处翻旧交接（比如工作区根上的旧 HANDOFF.md）」——
  实测有会话先在工作区根翻到旧体系的 `HANDOFF.md`，白花一轮。

### 测试
- cross-session 新增「新会话重新注入开场（按会话 id 记，不是全局布尔）」：fake ctx 记录 `session/created`，
  模拟第二个会话，断言开场五步与根目录重新出现、同一会话再取仍回到短版。
- 四套冒烟：core 37 / tools 23 / session 13 / **cross 15** = 88 项全过。



## 0.3.8 — 2026-11-02

### 新增
- **`handoff/README.md` 改成真正的交接总目录**：写清「什么东西放哪」「当前一棒派给谁」
  「有哪些交接（标题级，最近 20 条）」。启动和每次归档后自动重写；手改会在下次刷新时被覆盖。
- **开场必读改成「先读总目录，再只读自己那一棒」**：原来的开场让人读白板与最近交接，
  新会话容易把全部交接翻一遍。现在先读总目录一页，被派到哪个交接才打开哪个文件，
  其它交接只从目录里知道存在；并直接写明教训写 `handoff/教训日记/`、电脑状态写
  `handoff/任务交接本/当前状态.md`。

### 其它
- 目录生成逻辑独立成 `lib/catalog.js`，启动（`runStartup`）与归档（`end_task`）都刷新。
- 冒烟 87 全过（core 37 / tools 23 / session 13 / cross 14）：tools 新增
  「交接总目录写清放哪/当前一棒/交接清单且明确别全读」；cross 的 primer 断言改为
  「先读 handoff/README.md」「不要逐个打开」。

## 0.3.7 — 2026-11-01

### 新增
- **变更笔记统计范围可配**：新配置 `selfScan.scope`（`handoff` 默认 / `self`）。
  以前只统计 `handoff/self/`，交接、日志、白板怎么改都是 0/0/0；现在默认统计整个
  `handoff/`，笔记里多一行「统计范围：handoff/」。
- **范围切换自动重建基线**：快照里记 `scope`，与当前配置不一致时按「重建基线」处理
  （审计 `snapshot.scopeRebaselined`），不会拿两个目录的基线硬比出假差异。

### 其它
- `self/README.md` 与 README 配置说明同步：统计范围由 `selfScan.scope` 决定；配置字段
  共 34 个。
- 冒烟 86 全过（core 37 / tools 22 / session 13 / cross 14）：session 新增
  「统计范围 handoff：改交接区文件也会进补记」，并覆盖切回 self 的基线重建。

## 0.3.6 — 2026-11-01

### 新增
- **`archive_handoff` 归档工具**：把一个交接实例的机器版与用户版整份移进
  `archive/trash/<时间戳>/from-<档>/`，回收记录写一条 `source=bucket_soft_delete`
  （`restore` 工具能找回），再从索引里摘掉条目。以前清理旧实例只有手工搬文件一条路。

### 修复
- **补记里「（无记录）」读着像又炸了**：结束时间拿不到时（心跳与快照时间都不晚于窗口起点），
  时间窗口改成写「（起点时间，无结束记录）」，并在备注里说明「变更数以起点时刻为界」，
  不再只留一个吓人的「（无记录）」。

### 其它
- 冒烟 85 全过（core 37 / tools 22 / session 12 / cross 14）：tools 新增
  「archive_handoff 软删双份文件、摘索引、可 restore」。

## 0.3.5 — 2026-11-01

### 修复
- 工具注册时 `description` 强制转成字符串（数组则 `join('\n')`）：避免描述字段被写成数组后在注册/序列化环节出问题，属于本插件自身的防御。
- 冒烟 84 全过（core 37 / tools 21 / session 12 / cross 14）。

## 0.3.4 — 2026-11-01

### 修复

- **重启后 end_task 报 `E_IO (reading 'instance')`**：运行态里补 `currentTask: null` 字段；
  同一会话异常重启时把上一个运行态的 `currentTask` 带回新运行态（只在 sessionId 相同且
  上次状态仍是 active 时），启动返回的 runtime 也从 `startup.runtimeState.currentTask` 取值。
  这样重启后任务登记不丢，`end_task` 能接上。
- **没有进行中的任务时归档报错不清晰**：`end_task` 开头加守卫，直接返回 `E_NO_TASK`
  并提示先用 `begin_task`，不再走到深处才炸。
- **同一个任务被重复归档**：`end_task` 成功分支原来只清磁盘上的 `currentTask`，
  内存里还留着，再调一次 `end_task` 会把同一个任务再归档一遍；现在成功时内存与磁盘一起清。

### 其它

- 冒烟 84 项（37 / 21 / 12 / 14）：session 新增「同一会话异常重启：currentTask 带回新运行态」，
  tools 新增「没有进行中的任务时归档返回 E_NO_TASK」。

## 0.3.3 — 2026-11-01

### 新增

- **开场必读注入**：每个新会话的第一次系统注入会带一段「开场」——不管用户第一句话说什么，
  先读 `handoff/projects/` 的白板（标题 / 当前一棒 / 待办）和 `handoff/index.machine.json`
  里最近 1–2 条机器交接，弄清电脑状态与后续计划，再回话。只注入一次，之后恢复短版，不每轮刷屏。
  事件 `session/created` 时重置，保证新会话（重启/新开）都重新带一遍。

### 其它

- 冒烟仍为 82 项（37 / 20 / 11 / 14）；cross-session 的 primer 用例新增两条断言：
  第一次注入含「开场」与 `先读 handoff/projects/`，第二次起不再出现。

## 0.3.2 — 2026-11-01

### 修复

- **同一会话反复崩溃只补一篇**：补记去重键从「会话 ID」改成「(会话 ID, 窗口起点)」。
  同一个会话崩溃重启多少次，就有多少个独立的中断窗口，每个窗口各补一篇 journal；
  同一窗口重复启动仍然只补一次。
- **归档覆盖别的会话的索引改动**：`end_task` 写索引前先从盘上重新加载并合并，
  运行期间外部写入的条目不会再被启动时的内存快照冲掉；重读失败时退回内存索引，不阻断归档。
- **补记不重放未完成任务**：`begin_task` 把进行中的任务写进 `runtime-state.currentTask`，
  崩溃补记会输出「未完成任务：实例（档/类型，taskId）」和目标；`end_task` 成功后清掉，
  免得下次崩溃报一个早就做完的任务。

### 其它

- 启动审计新增 `startup.source`：记录插件实际加载目录，验收不必再靠 junction/时间线旁证。
- 冒烟扩到 82 项：core 37 / tools 20 / session 11 / cross-session 14。

## 0.3.1 — 2026-11-01

### 修复

- **补记窗口塌缩**：`performBackfill` 计算窗口终点时，改为在 `lastHeartbeatAt`、`endedAt`、
  `lastCompleteScanAt`、`lastScanAt` 里取最晚且晚于窗口起点的那一个；全都早于起点时不再
  输出同一时刻，渲染为「（无记录）」。硬杀后补记的时间窗口不再塌成一行。
- **交接列表参数被吞**：`end_task` 的 `done` / `blocked` / `readFirst` / `avoid` 收到 JSON
  编码字符串（而不是数组）时，照样能落进机器版与用户版，不再静默写成「（无）」。
- **同一实例二次归档崩溃**：版本清理补传 `baseName` 与 `keepK`，清理失败降级为 warning
  并记审计 `versions.cleanupFailed`，不再在写盘之后抛 `E_IO` 让整个归档看起来失败。
- **心跳不落盘**：心跳定时器每次跳动同时把 `runtime-state.json` 写盘，进程被硬杀后
  运行态文件里不再是启动那一刻的旧时间。
- **版本指针不同步**：`current.json` 在插件升级后由启动流程同步到新版本号（保留
  `installedAt`，记录 `upgradedAt`，审计 `version.pointerSynced`）；插件版本号改为直接读
  `package.json`，不再手写常量。

### 其它

- 冒烟扩到 79 项：core 37 / tools 19 / session 9 / cross-session 14。
- 新增回归：JSON 字符串列表落交接、同一实例二次归档、升级后版本指针同步、补记窗口不塌缩。

## 0.3.0 及更早

见 git 历史。


