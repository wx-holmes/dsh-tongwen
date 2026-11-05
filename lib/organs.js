// 器官系统 v0.4（0.4.0 起）：只认文件，不认函数。
// 名片：<插件目录>/organ.json；事件：名片 events.path 指向的 jsonl；门口：organ_call。
// 0.4.3（联动契约 v2）：write / danger 先写 gate 报备给安全插件，拿到裁决再决定放不放行；
// 执行器还没接之前，即使放行也只回「已放行、执行器未接」，不冒充执行。
import { readFile, readdir, mkdir, appendFile, writeFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const STATE_REL = path.join('logs', 'organs-state.json');
const RECORDS_REL = path.join('logs', '账本', 'data', 'records.jsonl');
const MAX_EVENTS_PER_ORGAN = 200;
const MAX_FILE_BYTES = 64 * 1024;

// 安全插件 gate 的约定（见 handoff/规范/联动契约.md 与 safety-kit/bin/watchdog.cjs 的 tickGate）：
// 我们写 <id>.request.json（含 organ / ability / sideEffect），它 200ms 扫一次回 <id>.ack.json。
// 它只认 sideEffect: write→allow、danger→deny、不认识→deny；契约写「超时=拒绝」，所以我们自己也兜底拒。
const DEFAULT_GATE_DIR = 'C:\\safety-kit\\state\\gate';
const DEFAULT_GATE_TIMEOUT_MS = 3000;
const GATE_POLL_MS = 100;

// 默认扫描两个插件根：书同文自己的插件目录 + bridge-kit 的插件目录。
// 可用配置 organs.roots 覆盖（分号分隔）。
export const DEFAULT_ROOTS = Object.freeze(['C:\\dsh-plugins', 'C:\\tools\\bridge-kit\\plugins']);

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
      const type = typeof evt.type === 'string' ? evt.type : 'unknown';
      await appendRecord(ctx, {
        type: 'organ',
        title: `${organ.id} · ${type}`,
        at: typeof evt.ts === 'string' ? evt.ts : new Date().toISOString(),
        data: {
          organ: organ.id,
          eventType: type,
          severity: evt.severity ?? null,
          subject: evt.subject ?? null,
          payload: evt.payload ?? null,
          trace: evt.trace ?? null,
          known: KNOWN_EVENT_TYPES.has(type),
        },
        source: `organ:${organ.id}`,
      });
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
  // 注意：这里只放 JSON 能无损表达的值（不要 undefined），否则宿主会拒绝工具回执。
  const rows = organs.map((o) => {
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
    };
    if (Array.isArray(o.invalid) && o.invalid.length) row.invalid = o.invalid;
    return row;
  });
  return { ok: true, roots: rootsOf(config), count: rows.length, organs: rows };
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

/** 门口：按名片路由一个能力。v0 只放行 file + read（dryRun 只探路不读）。 */
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

  if (sideEffect === 'danger' || sideEffect === 'write') {
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        needsGate: true,
        organ: organ.id,
        ability: abilityName,
        sideEffect,
        gateDir: gateDirOf(config),
      };
    }
    const gate = await askGate(config, organ.id, abilityName, sideEffect);
    await appendRecord(ctx, {
      type: 'organ',
      title: `${organ.id} · organ.call(gate:${gate.verdict})`,
      at: new Date().toISOString(),
      data: {
        organ: organ.id,
        ability: abilityName,
        sideEffect,
        gate: { verdict: gate.verdict, reason: gate.reason, by: gate.by, timeout: gate.timeout },
      },
      source: `organ:${organ.id}`,
    });
    if (gate.verdict !== 'allow') {
      return {
        ok: false,
        errorCode: 'GATE_DENIED',
        message: `安全插件拒绝「${abilityName}」：${gate.reason}`,
        data: { organ: organ.id, ability: abilityName, sideEffect, gate },
      };
    }
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_ENTRY',
      message: '安全插件已放行，但执行器还没接（当前只执行 file + read，动作类等 0.5 的执行器）',
      data: { organ: organ.id, ability: abilityName, sideEffect, entryType: entry.type ?? null, gate },
    };
  }
  if (entry.type !== 'file') {
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_ENTRY',
      message: `v0 只认 entry.type=file，这张名片是 ${entry.type}`,
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
