/**
 * 九档白名单 —— 编译期常量，永不来自运行时输入。
 *
 * 规格 §2.1 / §15.8：九档名单与中文名已冻结。
 * 这里同时也是「层 0 保护」和「档归属校验」的唯一真相来源。
 *
 * 物理名是 ASCII 小写，中文名只用于显示（规格 §3.1 双名制）。
 */

/**
 * @typedef {object} Bucket
 * @property {number} index   档位序号（1-9，展示顺序）
 * @property {string} physical 物理目录名（ASCII，小写）
 * @property {string} display  中文显示名
 * @property {string} role     职责（写进 README 与简报）
 */

/** @type {readonly Bucket[]} */
export const BUCKET_LIST = Object.freeze([
  Object.freeze({ index: 1, physical: 'handoff', display: '交接', role: '交接 / 索引 / 用户报告' }),
  Object.freeze({ index: 2, physical: 'created', display: '创造', role: 'dsh 任务产出' }),
  Object.freeze({ index: 3, physical: 'downloads', display: '下载', role: '联网拉取物' }),
  Object.freeze({ index: 4, physical: 'incoming', display: '外来', role: '用户投喂 / 外部导入' }),
  Object.freeze({ index: 5, physical: 'scratch', display: '临时', role: '中间产物 / 可弃草稿' }),
  Object.freeze({ index: 6, physical: 'archive', display: '归档', role: '软删落点 / 版本备份 / 恢复' }),
  Object.freeze({ index: 7, physical: 'logs', display: '日志', role: 'append-only 审计' }),
  Object.freeze({ index: 8, physical: 'config', display: '配置', role: '插件版本 / 快照 / 清单' }),
  Object.freeze({ index: 9, physical: 'self', display: '自身', role: 'AI 自身文件（只收纳报告，不解析内容）' }),
])

/** 物理名集合，用于 O(1) 判定。 */
export const BUCKET_KEYS = Object.freeze(BUCKET_LIST.map((b) => b.physical))

const BY_PHYSICAL = new Map(BUCKET_LIST.map((b) => [b.physical, b]))
const BY_DISPLAY = new Map(BUCKET_LIST.map((b) => [b.display, b]))

/**
 * 按物理名取档定义；不认识就是 undefined（调用方必须停下问用户，禁止猜）。
 * @param {string} physical
 * @returns {Bucket | undefined}
 */
export function bucketByPhysical(physical) {
  return BY_PHYSICAL.get(String(physical ?? '').toLowerCase())
}

/**
 * 按中文显示名取档定义。
 * @param {string} display
 * @returns {Bucket | undefined}
 */
export function bucketByDisplay(display) {
  return BY_DISPLAY.get(String(display ?? '').trim())
}

/**
 * 是否九档之一（大小写不敏感，Windows 语义）。
 * @param {string} name
 * @returns {boolean}
 */
export function isBucketName(name) {
  return BY_PHYSICAL.has(String(name ?? '').toLowerCase())
}

/**
 * 新建第 10 档是本规格的第一条绝对禁止（§14.1）。
 * 这里给调用方一个明确的拒绝理由，而不是静默返回 undefined。
 * @param {string} name
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function assertKnownBucket(name) {
  const key = String(name ?? '').toLowerCase()
  if (BY_PHYSICAL.has(key)) return { ok: true }
  return {
    ok: false,
    reason: `「${name}」不在九档白名单内；九档之外不允许新建顶层档（需要新分类时在九档内建二级目录）`,
  }
}

/**
 * 九档里允许作为「恢复目标」的集合（规格 §4.9 restore）。
 * 从 versions 恢复时 targetBucket 必须显式指定且落在此集合内。
 */
export const RESTORE_TARGET_BUCKETS = Object.freeze([
  'created', 'incoming', 'scratch', 'downloads', 'handoff',
])

export const RESTORE_FORBIDDEN_BUCKETS = Object.freeze([
  'archive', 'logs', 'config', 'self',
])
