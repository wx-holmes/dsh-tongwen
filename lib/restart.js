/**
 * 重启广播（0.5.0）。
 *
 * 为什么有这个东西：一个时空重启会杀掉**所有**时空（DSH 是整个进程被终止，
 * 看门狗再拉起一个新的）。以前的做法是「谁想重启谁自己排个 30 秒」——
 * 别的时空正写到一半，刀就落下来了，只能靠事后补记。
 *
 * 现在改成：想重启的时空先「广播」，广播写在 logs/state/restart-broadcast.json，
 * 每个时空的每轮开场都会读到它（buildPrimer 每轮都带），看到就收尾、不再开新活；
 * 30 秒后统一断。广播是文件，不是消息总线——同一台机器上的所有 DSH 会话共享这份文件。
 *
 * 0.5.3：路径从 `state/` 挪进 `logs/state/`——顶层只许九档，state/ 是当初多出来的第 10 档。
 */

import fsp from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const BROADCAST_REL = 'logs/state/restart-broadcast.json'
export const DEFAULT_RESTART_SCRIPT = 'A:\\safeprotocol\\bin\\restart-dsh-later.ps1'
export const MIN_DELAY_SEC = 25
/** 过期多久之后不再算「刚重启完」（防止旧广播一直挂着吓人）。 */
export const STALE_MS = 10 * 60 * 1000

const pad = (n) => String(n).padStart(2, '0')

/** 北京时间文本，人看的。 */
export function bjTime(ms) {
  const d = new Date(ms)
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  return `${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}`
}

/** @param {import('./context.js').PluginContext} ctx */
export function broadcastPath(ctx) {
  return path.join(ctx.root, BROADCAST_REL)
}

/**
 * 本进程「出生时间」。
 *
 * 为什么记这个（0.5.2 修一个真 bug）：重启会换进程，旧进程写下的广播 etaAt 在
 * 新进程出生之前就已经过了。只按 etaAt 推状态的话，新进程会把那条广播判成
 * 「inflight（正在重启）」，于是重启完的十分钟里每个新时空开场都在喊「别开新活」，
 * 动态白板也跟着抄——重启明明已经完成了。
 * 现在：etaAt 早于本进程出生 → 那条广播一定是「上一个我」留下的、已经执行完的 → completed。
 * 同一进程内 eta 未到还是 pending、到了但没换进程还是 inflight（真的快断了）。
 */
const LOADED_AT = Date.now()

/**
 * 读广播文件（同步，给 buildPrimer 用；每轮都调，不能慢）。
 * 读不到就 null，读坏了也 null——广播坏了不该拖垮开场。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {number} [now]
 * @param {number} [loadedAt] 本进程出生时间（单测可注入）
 */
export function readBroadcastSync(ctx, now = Date.now(), loadedAt = LOADED_AT) {
  try {
    const parsed = JSON.parse(readFileSync(broadcastPath(ctx), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const etaAt = Number(parsed.etaAt) || 0
    const announcedAt = Number(parsed.announcedAt) || 0
    const cancelled = parsed.status === 'cancelled'
    // ① 老到没人记得（10 分钟前的广播）② 或者比本进程还早出生 → 都已经结束了。
    const tooOld = etaAt > 0 && now - etaAt > STALE_MS
    const beforeLoad = etaAt > 0 && loadedAt > etaAt
    const completed = !cancelled && (tooOld || beforeLoad)
    const status = cancelled
      ? 'cancelled'
      : completed
        ? 'completed'
        : etaAt > now
          ? 'pending'
          : 'inflight'
    // 0.5.3：派生出来的「已完成」写回磁盘。不写的话，文件里永远躺着 pending，
    // 下一个人（或下一个时空）打开文件看还是「要重启」，得靠内存状态才判得对。
    if (status === 'completed' && parsed.status !== 'completed') {
      try {
        writeFileSync(
          broadcastPath(ctx),
          `${JSON.stringify({ ...parsed, status: 'completed', completedAt: new Date(now).toISOString() }, null, 2)}\n`,
          'utf8',
        )
      } catch {
        /* 广播写不回去也不该拖垮开场 */
      }
    }
    return {
      id: String(parsed.id ?? ''),
      by: String(parsed.by ?? 'unknown'),
      reason: String(parsed.reason ?? ''),
      delaySec: Number(parsed.delaySec) || 0,
      announcedAt,
      etaAt,
      status,
      // 0.5.6：握手式自动重启用到的字段；老广播没有这几个，按 fixed 处理
      mode: parsed.mode === 'auto' ? 'auto' : 'fixed',
      auto: parsed.auto && typeof parsed.auto === 'object' ? parsed.auto : null,
      acks: Array.isArray(parsed.acks) ? parsed.acks : [],
      promotedAt: Number(parsed.promotedAt) || 0,
      promotedDelaySec: Number(parsed.promotedDelaySec) || 0,
      expired: completed,
      cancelled,
    }
  } catch {
    return null
  }
}

/**
 * 当前**需要别人让路**的广播：还在倒计时，或刚过点（视为正在重启）。
 * 取消的、过期的不算。
 *
 * @param {import('./context.js').PluginContext} ctx
 * @param {number} [now]
 */
export function pendingBroadcastSync(ctx, now = Date.now(), loadedAt = LOADED_AT) {
  const b = readBroadcastSync(ctx, now, loadedAt)
  if (!b || b.cancelled || b.expired) return null
  if (b.status === 'pending' || b.status === 'inflight') return b
  return null
}

/** 一句话描述，给开场和 begin_task 的提醒用。 */
export function describeBroadcast(b, now = Date.now()) {
  if (!b) return ''
  if (b.status === 'pending') {
    const wait = Math.max(0, Math.round((b.etaAt - now) / 1000))
    const autoNote =
      b.mode === 'auto'
        ? `；**自动收尾**：你这一轮收完就调 restart_dsh(action="ack")，别的时空都收手了会提前断（最晚 ${wait} 秒）`
        : ''
    return `⏰ 重启广播：${bjTime(b.etaAt)}（还有 ${wait} 秒）全时空重启，发起 ${b.by}${b.reason ? `，原因「${b.reason}」` : ''}——**收尾：不再开新任务，写完交接等它断**${autoNote}`
  }
  if (b.status === 'inflight') {
    return `⏰ 重启进行中：${bjTime(b.etaAt)} 已到点，进程随时会断——先把手里的话说完/交接写完，别开新活`
  }
  return ''
}

/** 写广播。 */
export async function writeBroadcast(ctx, { by, reason, delaySec, mode = 'fixed', auto = null }) {
  const announcedAt = Date.now()
  const etaAt = announcedAt + Math.max(0, Math.round(delaySec * 1000))
  const record = {
    id: `rb-${announcedAt.toString(36)}`,
    by: String(by || 'unknown'),
    reason: String(reason || ''),
    delaySec: Math.round(delaySec),
    announcedAt,
    etaAt,
    status: 'pending',
    // 0.5.6：auto = 先按天花板排着，只有拿到硬证据（别的时空全 ack，或没人挂着任务也没人在写）才提前；
    // fixed = 老行为，等满 delaySec。
    mode: mode === 'auto' ? 'auto' : 'fixed',
    ...(auto && typeof auto === 'object' ? { auto } : {}),
    acks: [],
  }
  const file = broadcastPath(ctx)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

/** 某个时空表示「我收尾了，可以断」。重复 ack 只更新一次。 */
export async function ackBroadcast(ctx, { sessionId, note = '' } = {}) {
  const key = String(sessionId || '')
  if (!key) return null
  const file = broadcastPath(ctx)
  let prev = null
  try {
    prev = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
  if (!prev || typeof prev !== 'object' || prev.status !== 'pending') return null
  const acks = Array.isArray(prev.acks) ? prev.acks.slice() : []
  const hit = acks.findIndex((a) => a && a.sessionId === key)
  const entry = { sessionId: key, at: Date.now(), note: String(note || '') }
  if (hit >= 0) acks[hit] = entry
  else acks.push(entry)
  const record = { ...prev, acks }
  await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

/**
 * 把广播的到点时间改早（自动收尾到期时用）。
 * 只改 etaAt/delaySec，并记下 promotedAt/promotedDelaySec，防止反复提前。
 */
export async function updateBroadcastEta(ctx, { etaAt, delaySec, note = '' } = {}) {
  const file = broadcastPath(ctx)
  let prev = null
  try {
    prev = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
  if (!prev || typeof prev !== 'object' || prev.status !== 'pending') return null
  const record = {
    ...prev,
    etaAt: Math.round(etaAt),
    delaySec: Math.round(delaySec),
    promotedAt: Date.now(),
    promotedDelaySec: Math.round(delaySec),
    ...(note ? { promotedNote: String(note) } : {}),
  }
  await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

/** 取消/清理广播：不删文件，改成 status=cancelled（软状态，留痕）。 */
export async function cancelBroadcast(ctx, note = '') {
  const file = broadcastPath(ctx)
  let prev = null
  try {
    prev = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    prev = null
  }
  const record = {
    ...(prev && typeof prev === 'object' ? prev : {}),
    status: 'cancelled',
    cancelledAt: Date.now(),
    cancelledNote: String(note || ''),
  }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

/** 取消已排的重启计划任务（尽力而为；失败只说没撤掉，不谎报）。 */
export function unscheduleRestartTask() {
  // 冒烟/演练里不许真去删机器上的重启任务。
  if (process.env.TONGWEN_NO_SCHTASKS === '1') {
    return { ok: true, output: 'skipped（TONGWEN_NO_SCHTASKS=1）' }
  }
  try {
    const r = spawnSync('schtasks.exe', ['/Delete', '/TN', 'dsh-restart-once', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    })
    // 0.5.22：删任务注册不等于停掉已经在睡的那个 pwsh——cancel 之后它到点还会杀一次 DSH。
    const timers = killRestartTimers()
    return {
      ok: r.status === 0,
      killed: timers.killed,
      output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
    }
  } catch (error) {
    return { ok: false, killed: [], output: String(error?.message ?? error) }
  }
}

/**
 * 杀掉还在睡的旧重启定时器（0.5.22）。
 *
 * 背景：`restart-dsh-later.ps1` 每次都会写一个新的 `%TEMP%\dsh-restart-delay-<guid>.ps1`
 * （里面 `Start-Sleep -Seconds <DelaySec>`，醒来才调 restart-dsh.ps1），然后注册计划任务。
 * 问题：0.5.6 的握手式提前档会**再调一次** schedule()——旧脚本已经开睡，脚本里的
 * `Unregister-ScheduledTask` 只删任务注册，**杀不掉已经在跑的那个 pwsh**。于是到点两次：
 * 提前档 25 秒杀一次，旧的天花板 90 秒又杀一次，刚拉起来的 DSH 被自己人补刀
 * （2026-11-06 22:32:13 / 22:32:53 实测，恢复时间从 ~70 秒拖到 ~180 秒）。
 *
 * 做法：找命令行里带 `dsh-restart-delay-<32位hex>.ps1` 的 pwsh 进程，直接 Stop-Process。
 * 排新的之前先杀旧的；取消重启时也杀（cancel 之后不该还有一颗定时炸弹）。
 *
 * 冒烟/演练里（TONGWEN_NO_SCHTASKS=1）完全跳过，绝不杀机器上的东西。
 *
 * @returns {{ok: boolean, killed: number[], output: string}}
 */
export function killRestartTimers({ pwsh = resolvePwsh() } = {}) {
  if (process.env.TONGWEN_NO_SCHTASKS === '1') {
    return { ok: true, killed: [], output: 'skipped（TONGWEN_NO_SCHTASKS=1）' }
  }
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$hits = Get-CimInstance Win32_Process -Filter \"Name='pwsh.exe'\" | Where-Object { $_.CommandLine -match 'dsh-restart-delay-[0-9a-fA-F]{32}\\.ps1' }",
    '$ids = @($hits | ForEach-Object { [int]$_.ProcessId })',
    'foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
    "Write-Output ('KILLED ' + ($ids -join ','))",
  ].join('; ')
  try {
    const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    })
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    const match = /KILLED\s*([0-9,\s]*)/.exec(text)
    const killed = match
      ? match[1]
          .split(',')
          .map((n) => Number(n.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
      : []
    return { ok: result.status === 0, killed, output: text.slice(-300) }
  } catch (error) {
    return { ok: false, killed: [], output: String(error?.message ?? error) }
  }
}

/**
 * 找 pwsh 的真实路径：DSH 里 spawn('pwsh.exe') 解析不可靠（PATH 里的东西不一定
 * 能被子进程用），所以默认写死 PowerShell 7 的绝对路径，存在性检查不过再退回命令名。
 */
export function resolvePwsh() {
  if (process.env.TONGWEN_PWSH) return process.env.TONGWEN_PWSH
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return 'pwsh.exe'
}

/**
 * 真正排重启：调护城河的 restart-dsh-later.ps1（它会建计划任务、走 run-hidden.vbs，
 * 到点杀进程、看门狗拉起）。
 *
 * 0.5.1 修：以前用 `spawn('pwsh', …)` 静默失败——Windows 上不带 .exe 的命令名
 * spawn 解析不到，进程起了又退、schtasks 里什么都没留下。现在：
 * ① 默认用绝对路径 `C:\Program Files\PowerShell\7\pwsh.exe`（0.5.2 起，见 resolvePwsh）；
 * ② 起完之后真去 schtasks 查一次任务在不在，查不到就报错，不谎报「已排程」。
 *
 * 0.5.5 修：`spawn(detached) + 轮询` 在 DSH 里仍然假成功（进程起了、任务没建出来，
 * 子进程的报错还被 detached 吞掉）。改成 `spawnSync` 前台等它跑完、把 stdout/stderr
 * 原样带回来；`dryRun=true` 传给脚本的 `-DryRun`（只打印不注册），用来安全验证通路。
 *
 * @returns {{ok: boolean, command: string, taskReady?: boolean, output?: string}}
 */
export function scheduleRestart({ delaySec, reason, by, script = DEFAULT_RESTART_SCRIPT, pwsh = resolvePwsh(), dryRun = false }) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-DelaySec',
    String(delaySec),
    '-Reason',
    String(reason || ''),
    '-By',
    String(by || 'unknown'),
  ]
  if (dryRun) args.push('-DryRun')
  const command = `${pwsh} ${args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')}`
  if (process.env.TONGWEN_NO_SCHTASKS === '1') {
    return { ok: true, command, taskReady: null, output: 'skipped（TONGWEN_NO_SCHTASKS=1，冒烟不真排）' }
  }
  // 0.5.22：排新的之前先杀掉还在睡的旧定时器。提前档（90 秒 → 25 秒）最容易撞上：
  // 旧的 90 秒脚本不会因为重新注册任务而停下，到点会二次杀 DSH（见 killRestartTimers）。
  const timers = dryRun ? { killed: [] } : killRestartTimers({ pwsh })
  // 前台等它跑完（脚本 1–2 秒，注册任务那步失败会立刻报错，正好抓得到）。
  let stdout = ''
  let stderr = ''
  let status = null
  try {
    const result = spawnSync(pwsh, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1 << 20,
    })
    stdout = String(result.stdout ?? '').trim()
    stderr = String(result.stderr ?? '').trim()
    status = result.status
    if (result.error) stderr = `${stderr}${stderr ? '\n' : ''}${String(result.error.message ?? result.error)}`.trim()
  } catch (error) {
    return { ok: false, command, killedTimers: timers.killed, output: String(error?.message ?? error) }
  }
  const out = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim().slice(-800)
  if (dryRun) {
    // 演练：脚本只打印 DRYRUN，不会注册任务，所以不看 schtasks。
    return { ok: status === 0 && /DRYRUN/i.test(stdout), command, taskReady: null, killedTimers: timers.killed, output: out }
  }
  if (status !== 0) {
    return { ok: false, command, taskReady: false, killedTimers: timers.killed, output: out || `pwsh 退出码 ${status}` }
  }
  // 等它把计划任务建出来（注册完其实就有了，给 3 秒余量）。
  const deadline = Date.now() + 3000
  let lastOutput = out
  while (Date.now() < deadline) {
    const query = spawnSync('schtasks.exe', ['/Query', '/TN', 'dsh-restart-once'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (query.status === 0) return { ok: true, command, taskReady: true, killedTimers: timers.killed, output: out }
    lastOutput = `${out}\nschtasks: ${`${query.stdout ?? ''}${query.stderr ?? ''}`.trim().slice(0, 300)}`.trim()
    // 同步小睡 300ms（不用 setTimeout：这是工具调用路径，返回前必须确认）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
  }
  return { ok: false, command, taskReady: false, killedTimers: timers.killed, output: `计划任务没建出来：${lastOutput || 'schtasks 查不到 dsh-restart-once'}` }
}
