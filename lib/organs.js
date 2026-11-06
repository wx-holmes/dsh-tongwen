// 器官系统 v0.4（0.4.0 起）：只认文件，不认函数。
// 名片：<插件目录>/organ.json；事件：名片 events.path 指向的 jsonl；门口：organ_call。
// 0.4.3（联动契约 v2）：write / danger 先写 gate 报备给安全插件，拿到裁决再决定放不放行；
// 0.5.8（手是共用的）：门口接上执行通路——file / cli / http 三类都走同一份代码，
//   插件只声明「用公共的手做什么」，不各写一只手；门仍是安全插件，动手前先在 logs/organs-exec.jsonl 留一行。
import { readFile, readdir, mkdir, appendFile, writeFile, stat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileP = promisify(execFile);

const STATE_REL = path.join('logs', 'organs-state.json');
const RECORDS_REL = path.join('logs', '账本', 'data', 'records.jsonl');
const EXEC_LOG_REL = path.join('logs', 'organs-exec.jsonl');
const MAX_EVENTS_PER_ORGAN = 200;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 30000;

// 安全插件 gate 的约定（见 handoff/手册/插件的自我管理.md 与 safety-kit/bin/watchdog.cjs 的 tickGate）：
// 我们写 <id>.request.json（含 organ / ability / sideEffect），它 200ms 扫一次回 <id>.ack.json。
// 它只认 sideEffect: write→allow、danger→deny、不认识→deny；契约写「超时=拒绝」，所以我们自己也兜底拒。
const DEFAULT_GATE_DIR = './safety-kit/state/gate';
const DEFAULT_GATE_TIMEOUT_MS = 3000;
const GATE_POLL_MS = 100;

// 默认扫描两个插件根：书同文自己的插件目录 + bridge-kit 的插件目录。
// 可用配置 organs.roots 覆盖（分号分隔）。
export const DEFAULT_ROOTS = Object.freeze(['插件目录', 'bridge-kit\\plugins']);

const KNOWN_EVENT_TYPES = new Set([
  'threat.detected',
  'fever.start',
  'fever.cooled',
  'dispose.done',
  'task.start',
  'task.done',
  'organ.call',
  // 外部插件（external-plugin）压缩生命周期：名片 events.path → <stateRoot>/events.jsonl
  'compact.archived',
  'compact.skipped',
  'archive.failed',
]);

function rootsOf(config) {
  const raw = typeof config?.['organs.roots'] === 'string' ? config['organs.roots'].trim() : '';
  const list = (raw ? raw.split(';') : DEFAULT_ROOTS).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_ROOTS];
}

function gateDirOf(config) {
  const raw = typeof config?.['organs.gateDir'] === 'string' ? config['organs.gateDir'].trim() : '';
  return raw || DEFAULT_GATE_DIR;
}

function gateTimeoutOf(config) {
  const n = Number(config?.['organs.gateTimeoutMs']);
  return Number.isFinite(n) && n >= 200 ? n : DEFAULT_GATE_TIMEOUT_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 走一次安全插件 gate：写 request，等 ack，超时按拒绝处理。
 * 返回 { verdict: 'allow'|'deny', reason, by, timeout, id }。
 * 注意：request/ack 都是临时文件，拿到结果就清掉，别让目录无限长。
 */
export async function askGate(config, organId, abilityName, sideEffect) {
  const dir = gateDirOf(config);
  const timeout = gateTimeoutOf(config);
  const id = `gt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const reqPath = path.join(dir, `${id}.request.json`);
  const ackPath = path.join(dir, `${id}.ack.json`);
  const request = {
    id,
    organ: String(organId),
    ability: String(abilityName),
    sideEffect: String(sideEffect),
    requestedBy: 'tongwen',
    at: new Date().toISOString(),
  };
  const cleanup = async () => {
    for (const file of [reqPath, ackPath]) {
      try {
        await unlink(file);
      } catch {
        /* 已经没了就算了 */
      }
    }
  };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(reqPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  } catch (e) {
    return { id, verdict: 'deny', reason: `gate 目录不可写：${e?.code || e?.message || e}`, by: 'tongwen', timeout: false };
  }
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      const ack = await readJson(ackPath);
      if (ack && typeof ack.verdict === 'string') {
        return {
          id,
          verdict: ack.verdict === 'allow' ? 'allow' : 'deny',
          reason: typeof ack.reason === 'string' ? ack.reason : '',
          by: typeof ack.by === 'string' ? ack.by : 'safety-kit',
          timeout: false,
        };
      }
      await sleep(GATE_POLL_MS);
    }
  } finally {
    await cleanup();
  }
  return { id, verdict: 'deny', reason: `gate 超时（${timeout}ms 没回执，超时=拒绝）`, by: 'tongwen', timeout: true };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 校验一张名片；返回 { ok, errors }。 */
export function validateOrgan(card) {
  const errors = [];
  if (!card || typeof card !== 'object') return { ok: false, errors: ['不是对象'] };
  if (typeof card.id !== 'string' || !card.id.trim()) errors.push('缺 id');
  if (typeof card.name !== 'string' || !card.name.trim()) errors.push('缺 name');
  if (!Array.isArray(card.abilities) || card.abilities.length === 0) errors.push('abilities 必须是非空数组');
  else {
    card.abilities.forEach((a, i) => {
      if (!a || typeof a.name !== 'string' || !a.name.trim()) errors.push(`abilities[${i}] 缺 name`);
      if (!a.entry || typeof a.entry !== 'object') errors.push(`abilities[${i}] 缺 entry`);
      else if (!['file', 'cli', 'tool', 'http'].includes(a.entry.type)) errors.push(`abilities[${i}].entry.type 不认识：${a.entry.type}`);
      if (a.sideEffect && !['read', 'write', 'danger'].includes(a.sideEffect)) errors.push(`abilities[${i}].sideEffect 不认识：${a.sideEffect}`);
    });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 合体四字（规范 `handoff/手册/插件的自我管理.md`）：
 * 头 = 能只读看状态（sideEffect=read 的能力）；
 * 手 = 能动手（write / danger 的能力）；
 * 脚 = 有事件输出（events.path）；
 * 心 = 有 health（一个会刷新的文件 + ttl）。
 * 缺哪一点由 organ_list 点名——新插件必须至少接上三点，其中「头」「脚」是硬要求。
 */
export function connectPointsOf(card) {
  const abilities = Array.isArray(card?.abilities) ? card.abilities : [];
  const head = abilities
    .filter((a) => (a?.sideEffect ?? 'read') === 'read' && typeof a?.name === 'string' && a.name)
    .map((a) => a.name);
  const hand = abilities
    .filter((a) => ['write', 'danger'].includes(a?.sideEffect) && typeof a?.name === 'string' && a.name)
    .map((a) => a.name);
  const foot = typeof card?.events?.path === 'string' && card.events.path ? card.events.path : '';
  const heartPath = typeof card?.health?.path === 'string' ? card.health.path : '';
  const heartTtl = Number(card?.health?.ttlMs) || null;
  const points = [];
  if (head.length) points.push({ key: 'head', label: '头（只读状态）', detail: `${head.length} 项` });
  if (hand.length) points.push({ key: 'hand', label: '手（能动手）', detail: `${hand.length} 项` });
  if (foot) points.push({ key: 'foot', label: '脚（事件输出）', detail: foot });
  if (heartPath) points.push({ key: 'heart', label: '心（health）', detail: `${heartPath}${heartTtl ? ` · ttl ${heartTtl}ms` : ''}` });
  const missing = ['head', 'hand', 'foot', 'heart'].filter((key) => !points.some((point) => point.key === key));
  return { score: points.length, total: 4, points, missing, head, hand, foot, heart: heartPath || null };
}

/**
 * 心：量一次脉搏（0.5.10 起真的去 stat，不再只是名片上写着路径）。
 * 名片写 health.path + health.ttlMs；这个文件最近被刷过 = 器官还活着。
 * 返回 { present, path, ttlMs, ageMs, alive, missing }；没写 health 的返回 { present:false }。
 */
export async function probeHeart(card, now = Date.now(), dir = '') {
  const raw = typeof card?.health?.path === 'string' ? card.health.path : '';
  if (!raw) return { present: false };
  // 名片里的相对路径按器官目录解析（0.5.10 修：以前直接 stat，相对路径会落到进程 cwd 判成「文件没了」）
  const file = path.isAbsolute(raw) || !dir ? raw : path.resolve(dir, raw);
  const ttlMs = Number(card?.health?.ttlMs) || null;
  let st = null;
  try {
    st = await stat(file);
  } catch {
    return { present: true, path: file, ttlMs, missing: true, alive: false };
  }
  const ageMs = Math.max(0, Math.round(now - st.mtimeMs));
  return { present: true, path: file, ttlMs, ageMs, missing: false, alive: ttlMs ? ageMs <= ttlMs : true };
}

/** 手有没有真用过：从 logs/organs-exec.jsonl 取每个器官最近一条（0.5.10）。 */
export async function lastExecOf(ctx, now = Date.now()) {
  const out = {};
  let text = '';
  try {
    const st = await stat(path.join(ctx.root, EXEC_LOG_REL));
    if (st.size > 2 * 1024 * 1024) return out;
    text = await readFile(path.join(ctx.root, EXEC_LOG_REL), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row.organ !== 'string') continue;
    out[row.organ] = {
      at: typeof row.at === 'string' ? row.at : null,
      ability: typeof row.ability === 'string' ? row.ability : null,
      phase: typeof row.phase === 'string' ? row.phase : null,
      ok: row.ok === true,
      tool: typeof row.tool === 'string' ? row.tool : null,
    };
  }
  const ageOf = (at) => {
    const t = Date.parse(at ?? '');
    return Number.isFinite(t) ? Math.max(0, Math.round(now - t)) : null;
  };
  for (const key of Object.keys(out)) out[key].ageMs = ageOf(out[key].at);
  return out;
}

/** 扫所有根下的 organ.json，返回 [{ id, dir, card }]，同 id 先到先得。 */
export async function scanOrgans(ctx, config = {}) {
  const seen = new Set();
  const out = [];
  for (const root of rootsOf(config)) {
    let dirs = [];
    try {
      dirs = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      const card = await readJson(path.join(dir, 'organ.json'));
      if (!card) continue;
      const check = validateOrgan(card);
      if (!check.ok) {
        out.push({ id: card.id || d.name, dir, card, invalid: check.errors });
        continue;
      }
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      out.push({ id: card.id, dir, card });
    }
  }
  return out;
}

function recordsPath(ctx) {
  return path.join(ctx.root, RECORDS_REL);
}

async function appendRecord(ctx, record) {
  const file = recordsPath(ctx);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

async function loadState(ctx) {
  return (await readJson(path.join(ctx.root, STATE_REL))) ?? { organs: {} };
}

async function saveState(ctx, state) {
  const file = path.join(ctx.root, STATE_REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 每个器官记住最近见过的 event id（外部插件 0.1.0 起事件带 id，同文件内不复用）。
 * 只留最近 MAX_SEEN_IDS 个：offset 回退、文件被重写、同一批读两次，都不会重复入账。
 */
const MAX_SEEN_IDS = 500;

/** 把每个器官的 events.jsonl 新行追加进账本流水（type=organ）。返回处理条数。 */
export async function ingestOrganEvents(ctx, config = {}) {
  const organs = await scanOrgans(ctx, config);
  const state = await loadState(ctx);
  state.organs ??= {};
  let ingested = 0;
  for (const organ of organs) {
    if (organ.invalid) continue;
    const rel = typeof organ.card.events?.path === 'string' ? organ.card.events.path : '';
    if (!rel) continue;
    const file = path.isAbsolute(rel) ? rel : path.join(organ.dir, rel);
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      continue;
    }
    const slot = (state.organs[organ.id] ??= { offset: 0 });
    if (!Number.isInteger(slot.offset) || slot.offset < 0 || slot.offset > size) slot.offset = 0;
    if (!Array.isArray(slot.seenIds)) slot.seenIds = [];
    if (slot.offset === size) continue;
    let text = '';
    try {
      const buf = await readFile(file);
      text = buf.subarray(slot.offset, Math.min(size, slot.offset + 512 * 1024)).toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').filter((l) => l.trim());
    let used = 0;
    for (const line of lines.slice(0, MAX_EVENTS_PER_ORGAN)) {
      used += Buffer.byteLength(line, 'utf8') + 1;
      let evt = null;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (!evt || typeof evt !== 'object') continue;
      // 0.5.12：按 event id 幂等（同一件事只入账一次）
      const evtId = typeof evt.id === 'string' && evt.id ? evt.id : '';
      if (evtId && slot.seenIds.includes(evtId)) continue;
      const type = typeof evt.type === 'string' ? evt.type : 'unknown';
      const owner = typeof evt.payload?.owner === 'string' && evt.payload.owner ? evt.payload.owner : null;
      await appendRecord(ctx, {
        type: 'organ',
        title: `${organ.id} · ${type}`,
        at: typeof evt.ts === 'string' ? evt.ts : new Date().toISOString(),
        data: {
          organ: organ.id,
          eventId: evtId || null,
          eventType: type,
          severity: evt.severity ?? null,
          subject: evt.subject ?? null,
          // 0.5.12：owner 是「这份 profile 归谁」，外部插件写在 payload 里，提到顶层方便按项目查
          owner,
          payload: evt.payload ?? null,
          trace: evt.trace ?? null,
          known: KNOWN_EVENT_TYPES.has(type),
        },
        source: `organ:${organ.id}`,
      });
      if (evtId) {
        slot.seenIds.push(evtId);
        if (slot.seenIds.length > MAX_SEEN_IDS) slot.seenIds.splice(0, slot.seenIds.length - MAX_SEEN_IDS);
      }
      ingested += 1;
    }
    if (used > 0) slot.offset += used;
  }
  state.updatedAt = new Date().toISOString();
  await saveState(ctx, state);
  return ingested;
}

/** 列出器官（给工具用）。不含文件内容，只给名片摘要。 */
export async function organList(runtime) {
  const ctx = runtime.ctx;
  const config = runtime.config ?? {};
  const organs = await scanOrgans(ctx, config);
  const execs = await lastExecOf(ctx);
  const now = Date.now();
  // 注意：这里只放 JSON 能无损表达的值（不要 undefined），否则宿主会拒绝工具回执。
  const rows = await Promise.all(organs.map(async (o) => {
    const row = {
      id: String(o.id),
      name: typeof o.card?.name === 'string' ? o.card.name : String(o.id),
      version: o.card?.version ?? null,
      kind: o.card?.kind ?? null,
      status: o.card?.status ?? null,
      abilities: (o.card?.abilities ?? [])
        .filter((a) => a && typeof a.name === 'string' && a.name)
        .map((a) => ({
          name: a.name,
          sideEffect: typeof a.sideEffect === 'string' ? a.sideEffect : 'read',
          entryType: typeof a.entry?.type === 'string' ? a.entry.type : null,
        })),
      dir: o.dir,
      connect: connectPointsOf(o.card),
    };
    // 0.5.10：心真量一次（heart.present/alive/ageMs），手真用过几次（lastExec）。
    const heart = await probeHeart(o.card, now, o.dir);
    if (heart.present) row.heart = heart;
    const lastExec = execs[String(o.id)];
    if (lastExec) row.lastExec = lastExec;
    if (Array.isArray(o.invalid) && o.invalid.length) row.invalid = o.invalid;
    return row;
  }));
  const connectable = rows.filter((row) => row.connect.score >= 3 && row.connect.missing.every((key) => key === 'hand'));
  const staleHeart = rows.filter((row) => row.heart && (row.heart.missing || row.heart.alive === false)).map((row) => row.id);
  /** 手真「做成过事」的器官：exec 日志里有 phase=done 且 ok=true 的行（派单 delegated 不算做成了）。 */
  const handUsed = rows.filter((row) => row.lastExec && row.lastExec.phase === 'done' && row.lastExec.ok === true).map((row) => row.id);
  const handDelegated = rows.filter((row) => row.lastExec && row.lastExec.phase === 'delegated').map((row) => row.id);
  return {
    ok: true,
    roots: rootsOf(config),
    count: rows.length,
    /** 合体统计：三点以上算接上（手可以没有——不是每个插件都该有动手能力）。 */
    integration: {
      online: rows.length,
      connected: connectable.length,
      missingHead: rows.filter((row) => row.connect.missing.includes('head')).map((row) => row.id),
      missingFoot: rows.filter((row) => row.connect.missing.includes('foot')).map((row) => row.id),
      missingHeart: rows.filter((row) => row.connect.missing.includes('heart')).map((row) => row.id),
      missingHand: rows.filter((row) => row.connect.missing.includes('hand')).map((row) => row.id),
      /** 心不跳了（health 文件没了 / 超过 ttl 没刷新）。 */
      staleHeart,
      /** 手真做成过事的器官（organs-exec.jsonl 里有 phase=done & ok 的行）。 */
      handUsed,
      /** 手只派过单、还没真按下去的器官（tool 类）。 */
      handDelegated,
    },
    organs: rows,
  };
}

function findAbility(organs, name) {
  for (const organ of organs) {
    if (organ.invalid) continue;
    for (const ability of organ.card.abilities ?? []) {
      if (ability.name === name) return { organ, ability };
    }
  }
  return null;
}

/** 留痕：动手前先记「我准备做什么」，做完再记一条结果（0.5.8 你定：留）。 */
async function appendExecLog(ctx, row) {
  try {
    const file = path.join(ctx.root, EXEC_LOG_REL);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf8');
  } catch {
    /* 留痕失败不阻断执行：门才是闸，痕迹只是账 */
  }
}

function timeoutOf(input, fallback) {
  const n = Number(input?.timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), 1000), 120000);
}

/** 公共的手 · 写文件（entry.path + input.content；entry.mode='append' 追加）。 */
async function execFileWrite(organ, entry, input) {
  const rawPath = typeof entry.path === 'string' ? entry.path : '';
  if (!rawPath) return { ok: false, errorCode: 'ENTRY_FAILED', message: '名片缺 entry.path' };
  const content = typeof input.content === 'string' ? input.content : null;
  if (content === null) {
    return { ok: false, errorCode: 'E_ARGUMENT', message: '写文件要带 content（字符串）；只探路用 dryRun' };
  }
  const file = path.isAbsolute(rawPath) ? rawPath : path.join(organ.dir, rawPath);
  const append = entry.mode === 'append' || input.append === true;
  const t0 = Date.now();
  await mkdir(path.dirname(file), { recursive: true });
  if (append) await appendFile(file, content, 'utf8');
  else await writeFile(file, content, 'utf8');
  const info = await stat(file);
  return {
    ok: true,
    entry: { type: 'file', path: file, mode: append ? 'append' : 'write' },
    bytes: info.size,
    ms: Date.now() - t0,
  };
}

/** 公共的手 · 跑一条命令（entry.command + entry.args + input.args）。 */
async function execCli(organ, entry, input) {
  const command = typeof entry.command === 'string' ? entry.command.trim() : '';
  if (!command) return { ok: false, errorCode: 'ENTRY_FAILED', message: 'cli 名片缺 entry.command' };
  const baseArgs = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const extraArgs = Array.isArray(input.args) ? input.args.map(String) : [];
  const args = [...baseArgs, ...extraArgs];
  const rawCwd = typeof entry.cwd === 'string' ? entry.cwd : '';
  const cwd = rawCwd ? (path.isAbsolute(rawCwd) ? rawCwd : path.join(organ.dir, rawCwd)) : organ.dir;
  const timeout = timeoutOf(input, DEFAULT_EXEC_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const out = await execFileP(command, args, { cwd, timeout, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES });
    return {
      ok: true,
      entry: { type: 'cli', command, args, cwd },
      stdout: String(out?.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
      stderr: String(out?.stderr ?? '').slice(0, MAX_OUTPUT_BYTES),
      ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      errorCode: 'EXEC_FAILED',
      message: `命令失败（exit ${e?.code ?? '?'}）：${String(e?.stderr || e?.message || e).slice(0, 400)}`,
      entry: { type: 'cli', command, args, cwd },
      exitCode: Number.isFinite(e?.code) ? e.code : null,
      stdout: String(e?.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
      stderr: String(e?.stderr ?? '').slice(0, MAX_OUTPUT_BYTES),
      ms: Date.now() - t0,
    };
  }
}

/** 公共的手 · 发一个请求（entry.url + entry.method，只认 http(s)）。 */
async function execHttp(entry, input) {
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, errorCode: 'ENTRY_FAILED', message: 'http 名片缺 http(s) 的 entry.url' };
  }
  const method = String(entry.method ?? 'GET').toUpperCase();
  const timeout = timeoutOf(input, 10000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const body = method === 'GET' || method === 'HEAD' || typeof input.content !== 'string' ? undefined : input.content;
    const headers = entry.headers && typeof entry.headers === 'object' ? entry.headers : undefined;
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = (await res.text()).slice(0, MAX_OUTPUT_BYTES);
    return {
      ok: res.ok,
      entry: { type: 'http', url, method },
      status: res.status,
      body: text,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      errorCode: 'EXEC_FAILED',
      message: `请求失败：${e?.message || e}`,
      entry: { type: 'http', url, method },
      ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 派单参数归一：对象原样；JSON 字符串试解析（0.5.11，安全插件报 args=null 那次）；数组只给命令用。 */
function normalizeDelegateArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* 不是 JSON 就当没给 */
    }
  }
  return null;
}

/**
 * tool 类：那只手是**模型自己手里的工具**（MCP / 内置工具），插件调不动它。
 *
 * 所以这里不假装执行：门批了、痕迹留了，回执把「按哪个工具、带什么参数」写清楚，
 * 由调用方（模型）真按下去。0.5.9 起支持，语义叫「派单」。
 */
function delegateTool(entry, input, who = null) {
  const tool = String(entry.tool ?? entry.path ?? '').trim();
  if (!tool) {
    return { ok: false, errorCode: 'ENTRY_FAILED', message: '名片缺 entry.tool（要按的工具名）', ms: 0 };
  }
  const args = normalizeDelegateArgs(input.args);
  return {
    ok: true,
    executed: false,
    mode: 'delegated',
    tool,
    args,
    // 0.5.12：派单回执带 who —— 门批了，也得知道这一下是谁请求的。
    who,
    ms: 0,
    message: `门已经批了、痕迹也留了；最后这一下得由调用方自己按下工具 ${tool}${args ? '，参数照抄 args' : ''}`,
  };
}

/** 按 entry.type 落到公共那只手上：file / cli / http 真做；tool 派单给调用方。 */
async function executeAbility(organ, ability, input, who = null) {
  const entry = ability.entry ?? {};
  const type = String(entry.type ?? 'file');
  if (type === 'file') return execFileWrite(organ, entry, input);
  if (type === 'cli') return execCli(organ, entry, input);
  if (type === 'http') return execHttp(entry, input);
  if (type === 'tool') return delegateTool(entry, input, who);
  return { ok: false, errorCode: 'UNSUPPORTED_ENTRY', message: `不认识的 entry.type：${type}` };
}

/** 门口：按名片路由一个能力。read 直读；write/danger 先过安全插件的门，再落到公共那只手。 */
export async function organCall(runtime, input = {}) {
  const ctx = runtime.ctx;
  const config = runtime.config ?? {};
  const abilityName = typeof input.ability === 'string' ? input.ability.trim() : '';
  if (!abilityName) {
    return { ok: false, errorCode: 'E_ARGUMENT', message: '缺少 ability（能力名，例如 chat.send）' };
  }
  const dryRun = input.dryRun === true;
  const organs = await scanOrgans(ctx, config);
  const hit = findAbility(organs, abilityName);
  if (!hit) {
    const candidates = organs.flatMap((o) => (o.card?.abilities ?? []).map((a) => a.name));
    return {
      ok: false,
      errorCode: 'NO_ORGAN',
      message: `没有器官认领能力「${abilityName}」`,
      data: { knownAbilities: candidates },
    };
  }
  const { organ, ability } = hit;
  const sideEffect = ability.sideEffect ?? 'read';
  const entry = ability.entry ?? {};
  // 0.5.12：谁在请求（调用方会话 id）。门批了、痕迹里也得知道是谁要的这一下。
  // 谁请求的这一下：运行时给了 sessionId 就用它；老调用方/测试可能只挂在 ctx 上，兜一层
  const who =
    (typeof runtime.sessionId === 'string' && runtime.sessionId) ||
    (typeof ctx.sessionId === 'string' && ctx.sessionId) ||
    null;

  if (sideEffect === 'danger' || sideEffect === 'write') {
    const plan = {
      organ: organ.id,
      ability: abilityName,
      sideEffect,
      entryType: typeof entry.type === 'string' ? entry.type : 'file',
      who,
    };
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        needsGate: true,
        organ: organ.id,
        ability: abilityName,
        sideEffect,
        gateDir: gateDirOf(config),
        plan,
      };
    }
    // 留痕第一行：动手之前先记「我准备做什么」（你 2026-11-06 定的：留）
    await appendExecLog(ctx, { phase: 'prepare', ...plan, action: 'gate' });
    const gate = await askGate(config, organ.id, abilityName, sideEffect);
    await appendRecord(ctx, {
      type: 'organ',
      title: `${organ.id} · organ.call(gate:${gate.verdict})`,
      at: new Date().toISOString(),
      data: {
        organ: organ.id,
        ability: abilityName,
        sideEffect,
        who,
        gate: { verdict: gate.verdict, reason: gate.reason, by: gate.by, timeout: gate.timeout },
      },
      source: `organ:${organ.id}`,
    });
    if (gate.verdict !== 'allow') {
      await appendExecLog(ctx, { phase: 'denied', ...plan, gate: gate.verdict, reason: gate.reason });
      return {
        ok: false,
        errorCode: 'GATE_DENIED',
        message: `安全插件拒绝「${abilityName}」：${gate.reason}`,
        data: { organ: organ.id, ability: abilityName, sideEffect, gate },
      };
    }
    // 门开了 → 落到公共那只手上（file / cli / http 真做；tool 派单）
    const result = await executeAbility(organ, ability, input, who);
    const delegated = result.executed === false;
    await appendExecLog(ctx, {
      phase: delegated ? 'delegated' : 'done',
      ...plan,
      gate: gate.verdict,
      ok: result.ok === true,
      errorCode: result.errorCode ?? null,
      ms: result.ms ?? null,
      ...(delegated ? { tool: result.tool ?? null } : {}),
    });
    await appendRecord(ctx, {
      type: 'organ',
      title: `${organ.id} · organ.call(${delegated ? 'delegate' : 'exec'}:${result.ok ? 'ok' : 'fail'})`,
      at: new Date().toISOString(),
      data: { organ: organ.id, ability: abilityName, sideEffect, who, ok: result.ok === true, errorCode: result.errorCode ?? null },
      source: `organ:${organ.id}`,
    });
    if (!result.ok) {
      return {
        ok: false,
        errorCode: result.errorCode ?? 'EXEC_FAILED',
        message: result.message ?? '执行失败',
        data: { organ: organ.id, ability: abilityName, sideEffect, gate, exec: result },
      };
    }
    return {
      ok: true,
      organ: organ.id,
      ability: abilityName,
      sideEffect,
      who,
      gate: { verdict: gate.verdict, reason: gate.reason, by: gate.by },
      exec: result,
      ...(delegated ? { needsActor: true, message: result.message } : {}),
    };
  }

  // ── 只读：file 直读；http 可以 GET；cli / tool 不许（只读不该跑命令） ──
  if (entry.type === 'http') {
    if (dryRun) {
      return { ok: true, dryRun: true, organ: organ.id, ability: abilityName, entry: { type: 'http', url: entry.url ?? null } };
    }
    const result = await execHttp(entry, { ...input, content: undefined });
    await appendRecord(ctx, {
      type: 'organ',
      title: `${organ.id} · organ.call(http:${result.status ?? 'x'})`,
      at: new Date().toISOString(),
      data: { organ: organ.id, ability: abilityName, status: result.status ?? null, ok: result.ok === true },
      source: `organ:${organ.id}`,
    });
    if (!result.ok) {
      return {
        ok: false,
        errorCode: result.errorCode ?? 'EXEC_FAILED',
        message: result.message ?? `请求失败（HTTP ${result.status ?? '?'}）`,
        data: { organ: organ.id, ability: abilityName, exec: result },
      };
    }
    return { ok: true, organ: organ.id, ability: abilityName, entry: result.entry, status: result.status, body: result.body };
  }
  if (entry.type !== 'file') {
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_ENTRY',
      message: `只读能力只认 file / http；这张名片是 ${entry.type}（跑命令必须声明成 write 或 danger，先过门）`,
      data: { organ: organ.id, ability: abilityName, entryType: entry.type },
    };
  }

  const rawPath = typeof entry.path === 'string' ? entry.path : '';
  if (!rawPath) {
    return { ok: false, errorCode: 'ENTRY_FAILED', message: '名片缺 entry.path' };
  }
  const file = path.isAbsolute(rawPath) ? rawPath : path.join(organ.dir, rawPath);
  let info = null;
  try {
    info = await stat(file);
  } catch {
    info = null;
  }

  if (dryRun) {
    await appendRecord(ctx, {
      type: 'organ',
      title: `${organ.id} · organ.call(dry)`,
      at: new Date().toISOString(),
      data: { organ: organ.id, ability: abilityName, dryRun: true, exists: Boolean(info), size: info?.size ?? null },
      source: `organ:${organ.id}`,
    });
    return {
      ok: true,
      dryRun: true,
      organ: organ.id,
      ability: abilityName,
      entry: { type: entry.type, path: file },
      exists: Boolean(info),
      size: info?.size ?? null,
    };
  }

  if (!info || !info.isFile()) {
    return { ok: false, errorCode: 'ENTRY_FAILED', message: `文件不存在：${file}`, data: { organ: organ.id } };
  }
  if (info.size > MAX_FILE_BYTES) {
    return { ok: false, errorCode: 'ENTRY_FAILED', message: `文件太大（${info.size} 字节 > ${MAX_FILE_BYTES}）`, data: { organ: organ.id } };
  }
  const content = await readFile(file, 'utf8');
  await appendRecord(ctx, {
    type: 'organ',
    title: `${organ.id} · organ.call`,
    at: new Date().toISOString(),
    data: { organ: organ.id, ability: abilityName, bytes: info.size },
    source: `organ:${organ.id}`,
  });
  return {
    ok: true,
    organ: organ.id,
    ability: abilityName,
    entry: { type: entry.type, path: file },
    size: info.size,
    content,
  };
}
