#!/usr/bin/env node
/**
 * 合体体检：扫所有器官名片，按「头 / 手 / 脚 / 心」四点给出矩阵。
 *
 *   node scripts/check-organs.mjs          表格
 *   node scripts/check-organs.mjs --json   JSON
 *
 * 0.5.10 起「心」真的量（health 文件的 mtime 对比 ttl），「手」看有没有真用过
 * （logs/organs-exec.jsonl 里该器官最近一条）。名片上写着 ≠ 活着，得量。
 *
 * 退出码：0 = 全部至少接了头+脚；1 = 有器官缺头或缺脚（硬要求）。
 * 依据：handoff/手册/插件的自我管理.md
 */
import { scanOrgans, connectPointsOf, probeHeart, lastExecOf } from '../lib/organs.js';

const jsonMode = process.argv.includes('--json');

const ctx = { root: 'A:\\tongwen' };
const organs = await scanOrgans(ctx, {});
const execs = await lastExecOf(ctx);
const now = Date.now();

const rows = await Promise.all(organs.map(async (organ) => {
  const connect = connectPointsOf(organ.card);
  return {
    id: String(organ.id),
    name: typeof organ.card?.name === 'string' ? organ.card.name : String(organ.id),
    version: organ.card?.version ?? null,
    kind: organ.card?.kind ?? null,
    dir: organ.dir,
    connect,
    heart: await probeHeart(organ.card, now, organ.dir),
    lastExec: execs[String(organ.id)] ?? null,
    invalid: Array.isArray(organ.invalid) && organ.invalid.length ? organ.invalid : [],
  };
}));

const byKey = (key) => rows.filter((row) => !row.connect.missing.includes(key)).length;
const hardBroken = rows.filter(
  (row) => row.connect.missing.includes('head') || row.connect.missing.includes('foot'),
);
const stale = rows.filter((row) => row.heart.present && (row.heart.missing || row.heart.alive === false));

const beat = (ms) => {
  if (ms === null || ms === undefined) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.round(s / 60)}分前`;
  if (s < 86400) return `${Math.round(s / 3600)}小时前`;
  return `${Math.round(s / 86400)}天前`;
};

if (jsonMode) {
  console.log(JSON.stringify({
    count: rows.length,
    rows,
    hardBroken: hardBroken.map((r) => r.id),
    staleHeart: stale.map((r) => r.id),
  }, null, 2));
} else {
  const pad = (text, width) => {
    const value = String(text ?? '');
    return value + ' '.repeat(Math.max(0, width - [...value].length));
  };
  console.log('合体矩阵（头=只读状态 手=能动手 脚=事件 心=health）\n');
  console.log(`${pad('器官', 20)}${pad('版本', 8)}${pad('头', 4)}${pad('手', 4)}${pad('脚', 4)}${pad('心', 4)}${pad('脉搏', 10)}${pad('手用过', 22)}缺点`);
  console.log('─'.repeat(96));
  for (const row of rows) {
    const mark = (key) => (row.connect.missing.includes(key) ? '·' : '✓');
    const missing = row.connect.missing.length
      ? row.connect.missing.map((key) => ({ head: '头', hand: '手', foot: '脚', heart: '心' })[key]).join('')
      : '—';
    const pulse = !row.heart.present
      ? '未登记'
      : row.heart.missing
        ? '文件没了'
        : row.heart.alive
          ? beat(row.heart.ageMs)
          : `停跳 ${beat(row.heart.ageMs)}`;
    const used = row.lastExec
      ? `${row.lastExec.ability ?? '?'} ${row.lastExec.phase ?? ''}`.trim().slice(0, 20)
      : '没动过';
    console.log(`${pad(row.id, 20)}${pad(row.version ?? '-', 8)}${pad(mark('head'), 4)}${pad(mark('hand'), 4)}${pad(mark('foot'), 4)}${pad(mark('heart'), 4)}${pad(pulse, 10)}${pad(used, 22)}${missing}`);
  }
  console.log('─'.repeat(96));
  console.log(`共 ${rows.length} 个器官：头 ${byKey('head')} / 手 ${byKey('hand')} / 脚 ${byKey('foot')} / 心 ${byKey('heart')}`);
  if (hardBroken.length) {
    console.log(`\n✗ 缺硬要求（头或脚）：${hardBroken.map((r) => r.id).join('、')}`);
  } else {
    console.log('\n✓ 所有器官都至少接了头 + 脚');
  }
  if (stale.length) {
    console.log(`⚠ 心不跳了（health 没了或超过 ttl 没刷新）：${stale.map((r) => r.id).join('、')}`);
  } else {
    console.log('✓ 登记了 health 的器官脉搏都在 ttl 内');
  }
}

process.exit(hardBroken.length ? 1 : 0);
