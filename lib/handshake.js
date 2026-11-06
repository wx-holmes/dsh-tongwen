/**
 * 握手式自动重启（0.5.6）。
 *
 * 用户原话：「广播加上痕迹追踪，完全可以实现自动重启而不破坏别的时空」。
 * 0.5.5 只是「看现场算一个固定秒数」——算完就锁死，别人提前收手也白等。
 * 0.5.6 改成：
 *
 *   ① arm 时先按**天花板**（120 秒）排一个一次性重启任务，广播写成 mode=auto；
 *   ② 别的时空看到广播，收完自己那一轮就调 `restart_dsh(action="ack")` 说「我收尾了」；
 *   ③ 本插件每 3 秒算一次「就绪」——**只认硬证据**：
 *      a) 别的时空全部 ack（都握手了）；或
 *      b) 没有任何未完成的 open-task，且没有别的时空正在写（刚动过 ≤ ACTIVE_MS）。
 *      以前那条「静默 20 秒 = 收手」在 0.5.13 删掉了：干活中的时空跑一条三十秒的命令，
 *      从外面看就是静默，于是被判收手、提前到 25 秒断——06:47 就这样把安全插件杀了。
 *      现在沉默不再是证据，只说明「我们不知道」。没有证据就等到天花板。
 *   ④ 天花板到点无论如何断——永远不会有「大家都不 ack 于是永远不重启」。
 *
 * 痕迹（不靠猜）：
 *   - 广播里的 acks（显式握手，唯一能证明「我看过并收手了」）
 *   - logs/state/open-tasks.json（begin_task 记、end_task 划）
 *   - 会话库 mtime（presence.js 的 scanSpaces）只用来认「刚动过 = 可能正在写」，
 *     绝不把「一段时间没动」当成停手。
 */

import { readOpenTasksSync, scanSpaces, sessionsRoot } from './presence.js'
import { readBroadcastSync, scheduleRestart, updateBroadcastEta } from './restart.js'

/** 天花板：最多等这么久，到点无论如何断（0.5.13 从 120 收到 90——没有证据就别耗着）。 */
export const AUTO_CEILING_SEC = 90
/** 提前档：安全插件脚本的硬下限是 25 秒，低于它会被抬回去。 */
export const AUTO_EARLY_SEC = 25
/** 公告后至少等这么久才允许提前（让别人来得及看到广播）。 */
export const AUTO_MIN_READY_SEC = 20
/**
 * 别的时空在这段时间内动过 → 当作「可能正在写」，不许提前。
 * 单向使用：**最近动过** 是证据（它醒着），**一直没动** 不是证据（它可能正在跑命令）。
 */
export const AUTO_ACTIVE_MS = 10 * 1000
/** 扫描间隔。 */
export const AUTO_TICK_MS = 3000

function ageText(ageMs) {
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))} 秒前`
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)} 分钟前`
  return `${Math.round(ageMs / 3_600_000)} 小时前`
}

/**
 * 现在能不能提前断——**只认硬证据**（0.5.13）。
 *
 * 就绪的两条路：
 *   a) `allAcked`：扫到的别的时空全都 ack 过；
 *   b) `quiet`：没有任何未完成的 open-task，且没有别的时空在 AUTO_ACTIVE_MS 内动过。
 * 两条都不满足就返回 ready:false，一直等到天花板——**沉默不算证据**。
 *
 * @returns {{active: false} | {active: true, mode: string, broadcast: any, ready: boolean,
 *   waitedSec: number, evidence: 'all-acked'|'quiet'|null,
 *   pending: {sessionId: string, idleSec: number, task: string|null, working: boolean}[],
 *   acked: string[], others: number, openTasks: string[], promoted: boolean}}
 */
export function computeReadiness({ ctx, selfSessionId = '', now = Date.now(), root = sessionsRoot() } = {}) {
  const broadcast = readBroadcastSync(ctx, now)
  if (!broadcast || broadcast.status !== 'pending') return { active: false }
  const acked = (broadcast.acks ?? []).map((a) => String(a?.sessionId ?? '')).filter(Boolean)
  const ackSet = new Set(acked)
  const spaces = scanSpaces({ root, now, selfSessionId })
  const tasks = readOpenTasksSync(ctx)
  const waitedSec = Math.max(0, Math.round((now - (broadcast.announcedAt || 0)) / 1000))

  // 没 ack 的才算「还没交代」。ack 过的哪怕刚动过也放过——它自己说了收手。
  const unacked = spaces.filter((s) => !ackSet.has(s.sessionId))
  const pending = unacked.map((s) => {
    const task = tasks[s.sessionId]
    return {
      sessionId: s.sessionId,
      idleSec: Math.round(s.ageMs / 1000),
      task: task?.displayName || task?.taskId || null,
      // 「刚动过」= 它醒着、可能正在跑命令：这是**不许提前**的证据。
      working: s.ageMs <= AUTO_ACTIVE_MS,
    }
  })
  const openTasks = Object.keys(tasks).filter((id) => id && id !== selfSessionId)
  const allAcked = unacked.length === 0
  const quiet = openTasks.length === 0 && !pending.some((p) => p.working)
  const evidence = allAcked ? 'all-acked' : quiet ? 'quiet' : null
  const ready =
    broadcast.mode === 'auto' &&
    !broadcast.promotedAt &&
    waitedSec >= AUTO_MIN_READY_SEC &&
    Boolean(evidence)
  return {
    active: true,
    mode: broadcast.mode,
    broadcast,
    ready,
    waitedSec,
    evidence,
    pending,
    acked,
    others: spaces.length,
    openTasks,
    promoted: Boolean(broadcast.promotedAt),
  }
}

/** 一句话说清现在卡在哪儿。 */
export function describeReadiness(r) {
  if (!r || !r.active) return '没有进行中的重启广播'
  if (r.mode !== 'auto') return '固定延迟广播（mode=fixed），不看现场'
  if (r.promoted) return '已经提前过一次了，到点就断'
  if (r.ready) {
    return r.evidence === 'all-acked'
      ? `别的时空全都 ack 了（公告后 ${r.waitedSec} 秒），可以提前到 ${AUTO_EARLY_SEC} 秒`
      : `没有未完成的任务、也没人在写（公告后 ${r.waitedSec} 秒），可以提前到 ${AUTO_EARLY_SEC} 秒`
  }
  if (r.waitedSec < AUTO_MIN_READY_SEC) return `公告才 ${r.waitedSec} 秒，先让别的时空看到`
  const bits = []
  if (r.openTasks?.length) bits.push(`还挂着 ${r.openTasks.length} 个未完成任务`)
  const working = (r.pending ?? []).filter((p) => p.working)
  if (working.length) {
    bits.push(
      `有 ${working.length} 个时空刚动过（${working
        .slice(0, 3)
        .map((p) => `${p.sessionId} ${p.idleSec} 秒前`)
        .join('、')}），可能正在跑命令`,
    )
  }
  if (!bits.length) {
    const silent = (r.pending ?? []).length
    return silent
      ? `还有 ${silent} 个时空没 ack 也没动静——沉默不算证据，等到天花板 ${AUTO_CEILING_SEC} 秒`
      : `还没有硬证据，等到天花板 ${AUTO_CEILING_SEC} 秒`
  }
  return bits.join('；') + '——不提前，等到天花板'
}

/**
 * 到点检查：如果都收手了，就把天花板任务换成提前档，并把广播的 etaAt 改早。
 *
 * @param {{ctx: any, selfSessionId?: string, now?: number, root?: string, schedule?: Function}} options
 */
export function maybePromote({ ctx, selfSessionId = '', now = Date.now(), root = sessionsRoot(), schedule = scheduleRestart } = {}) {
  const readiness = computeReadiness({ ctx, selfSessionId, now, root })
  if (!readiness.active) return { promoted: false, reason: '没有进行中的广播', readiness }
  if (!readiness.ready) return { promoted: false, reason: describeReadiness(readiness), readiness }
  const remainingSec = Math.round(((readiness.broadcast.etaAt || 0) - now) / 1000)
  // 本来就没多久了，再折腾一次没意义（还要写盘 + 起 pwsh）。
  if (remainingSec <= AUTO_EARLY_SEC + 5) {
    return { promoted: false, reason: `离到点只剩 ${remainingSec} 秒，不动了`, readiness }
  }
  const baseReason = String(readiness.broadcast.reason || '重启')
  const why =
    readiness.evidence === 'all-acked' ? '别的时空全都 ack 了' : '没有未完成任务、也没人在写'
  const scheduled = schedule({
    delaySec: AUTO_EARLY_SEC,
    reason: `${baseReason}（自动收尾：${why}）`,
    by: String(readiness.broadcast.by || 'yunyou'),
  })
  if (!scheduled?.ok) {
    return { promoted: false, reason: `提前排程失败：${scheduled?.output || '未知原因'}`, readiness, scheduled }
  }
  return updateBroadcastEta(ctx, {
    etaAt: now + AUTO_EARLY_SEC * 1000,
    delaySec: AUTO_EARLY_SEC,
    note: `公告后 ${readiness.waitedSec} 秒就绪，从天花板 ${remainingSec} 秒提前到 ${AUTO_EARLY_SEC} 秒`,
  }).then((broadcast) => ({
    promoted: true,
    readiness,
    scheduled,
    broadcast,
    reason: `都收手了，提前到 ${AUTO_EARLY_SEC} 秒（原计划还剩 ${remainingSec} 秒）`,
  }))
}
