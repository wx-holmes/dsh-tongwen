/**
 * 命名规范 —— 规格 §3 冻结。
 *
 * 双名制：物理名 ASCII 小写（目录/文件名），显示名 UTF-8（中文优先）。
 * 本模块只负责「把一段输入变成合法的物理名」，不负责决定叫什么（那是 §3.3 问用户的事）。
 */

import { createHash } from 'node:crypto'

/** §3.1 保留名（Windows 设备名），大小写不敏感。 */
export const RESERVED_NAMES = Object.freeze([
  'con', 'nul', 'aux', 'prn',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

const RESERVED_SET = new Set(RESERVED_NAMES)

/** §3.1 物理名长度上限。 */
export const PHYSICAL_MAX_LENGTH = 48
/** §3.4 typeSlug 长度上限。 */
export const TYPE_SLUG_MAX_LENGTH = 32
/** 显示名长度上限。 */
export const DISPLAY_MAX_LENGTH = 64

/**
 * Windows 路径总长保守阈值。规格要求「检查完整路径长度，超限缩短实例名；仍超限 → 停下问用户」。
 * 取 240 是为了给 `<实例>.machine.md`（+17）和临时文件后缀留余量。
 */
export const FULL_PATH_MAX_LENGTH = 240

/**
 * 把任意输入转成物理名（§3.2 第 1–6 步）。
 * 不做去重、不检查保留名（那是分步之后的动作）。
 * @param {string} input
 * @param {number} [maxLength]
 * @returns {string}
 */
export function slugifyBase(input, maxLength = PHYSICAL_MAX_LENGTH) {
  const lowered = String(input ?? '').toLowerCase()
  const replaced = lowered.replace(/[^a-z0-9]/g, '-')
  const collapsed = replaced.replace(/-+/g, '-')
  const trimmed = collapsed.replace(/^-+|-+$/g, '')
  return trimmed.slice(0, maxLength)
}

/**
 * 保留名规避（§3.2 第 7 步）。
 * 追加 `-file` 会变长，所以先回缩到上限减后缀长度，保证最终仍 ≤ 上限。
 * @param {string} slug
 * @param {number} [maxLength]
 * @param {string} [suffix]
 * @returns {string}
 */
export function avoidReservedName(slug, maxLength = PHYSICAL_MAX_LENGTH, suffix = '-file') {
  if (!RESERVED_SET.has(slug)) return slug
  const room = maxLength - suffix.length
  const head = slug.slice(0, Math.max(1, room)).replace(/-+$/g, '')
  return `${head}${suffix}`
}

/**
 * 同类型重名 → 追加 -2 / -3 / …（§3.2 第 8 步）。
 * 调用方负责「复用不新建」：只有确实要新建时才调这里。
 * @param {string} base 已经过 slugifyBase + avoidReservedName 的名字
 * @param {Set<string> | Iterable<string>} used 已占用的物理名（大小写不敏感）
 * @param {number} [maxLength]
 * @returns {string}
 */
export function dedupeSlug(base, used, maxLength = PHYSICAL_MAX_LENGTH) {
  const taken = new Set([...used].map((s) => String(s).toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 10000; n += 1) {
    const suffix = `-${n}`
    const head = base.slice(0, Math.max(1, maxLength - suffix.length)).replace(/-+$/g, '')
    const candidate = `${head}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  // 到 9999 万级还没空位，说明目录已经失控，交给调用方停下问用户。
  return base
}

/**
 * 完整物理名生成（§3.2 第 1–7 步，不含去重）。
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  return avoidReservedName(slugifyBase(input))
}

/**
 * 完整路径长度校验（§3.2 第 9 步）。
 * @param {string} absolutePath
 * @returns {{ok: true} | {ok: false, reason: string, length: number}}
 */
export function checkFullPathLength(absolutePath) {
  const length = String(absolutePath).length
  if (length <= FULL_PATH_MAX_LENGTH) return { ok: true }
  return {
    ok: false,
    length,
    reason: `完整路径 ${length} 字符，超过 ${FULL_PATH_MAX_LENGTH}；规格要求缩短实例名，仍超限则停下问用户`,
  }
}

/**
 * typeSlug 生成（§3.4 五步）。
 *
 * 硬约束：禁止拼音转换、禁止时间戳主名、禁止把 displayName 直接当目录名、
 * 禁止 `type + '交接'` 作目录名。
 *
 * @param {string} displayName 类型显示名（UTF-8）
 * @param {Array<{typeDisplayName: string, typeSlug: string}>} [existingTypes] 索引里的 types[]
 * @param {Set<string> | Iterable<string>} [usedSlugs] 已知全部 typeSlug（用于冲突追加）
 * @returns {{typeSlug: string, reused: boolean}}
 */
export function typeSlugFor(displayName, existingTypes = [], usedSlugs = []) {
  const display = String(displayName ?? '').trim()

  // 第 1 步：索引已有该 displayName → 复用它的 slug。
  for (const entry of existingTypes) {
    if (String(entry?.typeDisplayName ?? '').trim() === display) {
      return { typeSlug: entry.typeSlug, reused: true }
    }
  }

  // 第 2 步：小写 → 非 [a-z0-9] 替换 - → 折叠 → 去首尾 → 截 32。
  let slug = slugifyBase(display, TYPE_SLUG_MAX_LENGTH)

  // 第 3 步：结果为空 → type- + SHA-256(NFC(displayName)) 前 8 位。
  if (slug === '') {
    const digest = createHash('sha256').update(display.normalize('NFC'), 'utf8').digest('hex')
    slug = `type-${digest.slice(0, 8)}`
  }

  // 第 4 步：保留名 → 追加 -type。
  slug = avoidReservedName(slug, TYPE_SLUG_MAX_LENGTH, '-type')

  // 额外硬约束：禁止 `type + '交接'` 形式的目录名。
  if (slug.endsWith('交接')) {
    slug = `${slug.slice(0, Math.max(1, TYPE_SLUG_MAX_LENGTH - 5))}-type`
  }

  // 第 5 步：与不同 displayName 的 slug 冲突 → 追加 -2 / -3。
  const taken = new Set([...usedSlugs].map((s) => String(s).toLowerCase()))
  for (const entry of existingTypes) {
    const other = String(entry?.typeDisplayName ?? '').trim()
    if (other !== display && entry?.typeSlug) taken.add(String(entry.typeSlug).toLowerCase())
  }
  if (taken.has(slug.toLowerCase())) {
    return { typeSlug: dedupeSlug(slug, taken, TYPE_SLUG_MAX_LENGTH), reused: false }
  }

  return { typeSlug: slug, reused: false }
}
