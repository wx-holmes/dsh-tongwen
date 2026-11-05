/**
 * 配置总表 —— 规格 §15.1 冻结字段名，§11.4 冻结校验语义。
 *
 * 插件只读 settings.json；用户/安装器写。启动时读一次，无 reload。
 * 非法值回退默认并告警；未知字段忽略并审计；跨字段约束违反时两字段一起回退。
 */

/** @typedef {{type: 'int'|'num'|'bool'|'str', default: any, min?: number, max?: number, enum?: readonly string[]}} FieldSpec */

/** @type {Readonly<Record<string, FieldSpec>>} */
export const CONFIG_SPEC = Object.freeze({
  'report.triggerJournalCount': Object.freeze({ type: 'int', default: 20, min: 1, max: 10_000 }),
  'report.triggerDays': Object.freeze({ type: 'int', default: 7, min: 1, max: 3_650 }),

  // 版本备份保留份数（0.3.12）：默认从 5 提到 10——这是插件里唯一会真删旧文件的路径，
  // 安全插件（safety-kit）要求「不可永久删除」，先把保留窗口放大，S1 后再改走执行器。
  'archive.keepVersionsK': Object.freeze({ type: 'int', default: 10, min: 1, max: 1_000 }),
  'archive.trashRetentionDays': Object.freeze({ type: 'int', default: 0, min: 0, max: 36_500 }),

  'safety.batchFileThreshold': Object.freeze({ type: 'int', default: 50, min: 1, max: 100_000 }),
  'safety.batchSizeThresholdMB': Object.freeze({ type: 'int', default: 100, min: 1, max: 1_048_576 }),

  // 过期文件清扫（只出报告，不自动删；删要主人点头）
  'housekeeping.auditDays': Object.freeze({ type: 'int', default: 90, min: 7, max: 3650 }),
  'housekeeping.ledgerDays': Object.freeze({ type: 'int', default: 180, min: 7, max: 3650 }),
  'housekeeping.trashDays': Object.freeze({ type: 'int', default: 90, min: 7, max: 3650 }),
  'housekeeping.scratchDays': Object.freeze({ type: 'int', default: 14, min: 1, max: 3650 }),
  'housekeeping.reportEveryDays': Object.freeze({ type: 'int', default: 7, min: 1, max: 365 }),

  // 器官系统（0.4.0）：只认文件不认函数。roots 用分号分隔，默认扫书同文插件目录与 bridge-kit 插件目录。
  'organs.enabled': Object.freeze({ type: 'bool', default: true }),
  'organs.roots': Object.freeze({ type: 'str', default: 'C:\\dsh-plugins;C:\\tools\\bridge-kit\\plugins' }),
  // 安全插件 gate（0.4.3）：write / danger 类先写报备文件等裁决；超时按拒绝（契约口径）。
  'organs.gateDir': Object.freeze({ type: 'str', default: 'C:\\safety-kit\\state\\gate' }),
  'organs.gateTimeoutMs': Object.freeze({ type: 'int', default: 3_000, min: 200, max: 10_000 }),
  'selfScan.timeoutMs': Object.freeze({ type: 'int', default: 30_000, min: 1_000, max: 300_000 }),
  'selfScan.maxFiles': Object.freeze({ type: 'int', default: 10_000, min: 100, max: 1_000_000 }),
  'selfScan.maxDepth': Object.freeze({ type: 'int', default: 32, min: 1, max: 256 }),
  'selfScan.followSymlinks': Object.freeze({ type: 'bool', default: false }),
  'selfScan.hashMaxFileMB': Object.freeze({ type: 'int', default: 64, min: 1, max: 10_240 }),
  'selfScan.skipHashMB': Object.freeze({ type: 'int', default: 1_024, min: 1, max: 1_048_576 }),
  // 补记/基线统计范围（0.3.7）：self 只统计自己的日记区，handoff 统计整个交接区。
  'selfScan.scope': Object.freeze({
    type: 'str', default: 'handoff', enum: Object.freeze(['self', 'handoff']),
  }),

  'heartbeat.intervalMs': Object.freeze({ type: 'int', default: 60_000, min: 5_000, max: 3_600_000 }),

  'task.allowGeneratedTaskId': Object.freeze({ type: 'bool', default: true }),
  'task.defaultTaskIdScope': Object.freeze({
    type: 'str', default: 'unknown', enum: Object.freeze(['global', 'session', 'unknown']),
  }),

  'handoff.artifactTreeMaxFiles': Object.freeze({ type: 'int', default: 1_000, min: 1, max: 100_000 }),
  'handoff.artifactTreeMaxMB': Object.freeze({ type: 'int', default: 256, min: 1, max: 10_240 }),
  'handoff.artifactHashFailWarnRatio': Object.freeze({ type: 'num', default: 0.2, min: 0, max: 1 }),

  'direction.maxLineKB': Object.freeze({ type: 'int', default: 32, min: 1, max: 256 }),
  'direction.quoteMaxChars': Object.freeze({ type: 'int', default: 200, min: 1, max: 1_000 }),
  'direction.warnBrokenLink': Object.freeze({ type: 'bool', default: true }),

  'openItems.maxActive': Object.freeze({ type: 'int', default: 200, min: 1, max: 10_000 }),
  'openItems.summaryMaxChars': Object.freeze({ type: 'int', default: 200, min: 50, max: 1_000 }),

  'degraded.auditFallbackRetry': Object.freeze({ type: 'int', default: 1, min: 0, max: 5 }),
  'audit.lockTimeoutMs': Object.freeze({ type: 'int', default: 2_000, min: 200, max: 10_000 }),
  'audit.maxFileMB': Object.freeze({ type: 'int', default: 100, min: 1, max: 10_240 }),
  'audit.retentionDays': Object.freeze({ type: 'int', default: 0, min: 0, max: 36_500 }),

  lockAcquireTimeoutMs: Object.freeze({ type: 'int', default: 10_000, min: 1_000, max: 120_000 }),
  lockStaleMs: Object.freeze({ type: 'int', default: 300_000, min: 60_000, max: 3_600_000 }),
  'eventDedup.maxIds': Object.freeze({ type: 'int', default: 1_000, min: 100, max: 100_000 }),

  'tools.listHandoffsDefaultLimit': Object.freeze({ type: 'int', default: 20, min: 1, max: 100 }),
  'tools.listHandoffsMaxLimit': Object.freeze({ type: 'int', default: 100, min: 1, max: 1_000 }),
  'tools.inspectMaxKB': Object.freeze({ type: 'int', default: 256, min: 1, max: 10_240 }),
})

/**
 * 跨字段约束（§11.4）：违反时两字段都回退默认，审计 config.invalid 写 constraintViolated。
 */
const CONSTRAINT_SPECS = Object.freeze([
  Object.freeze({
    name: 'skipHashMB >= hashMaxFileMB',
    fields: Object.freeze(['selfScan.skipHashMB', 'selfScan.hashMaxFileMB']),
    check: (v) => v['selfScan.skipHashMB'] >= v['selfScan.hashMaxFileMB'],
  }),
  Object.freeze({
    name: 'listHandoffsMaxLimit >= listHandoffsDefaultLimit',
    fields: Object.freeze(['tools.listHandoffsMaxLimit', 'tools.listHandoffsDefaultLimit']),
    check: (v) => v['tools.listHandoffsMaxLimit'] >= v['tools.listHandoffsDefaultLimit'],
  }),
])

/**
 * 取点号路径的值。
 * @param {Record<string, any>} obj
 * @param {string} dotted
 */
function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj)
}

/**
 * 按 CONFIG_SPEC 从原始 settings 派生运行期配置，同时收集问题。
 *
 * @param {unknown} raw settings.json 解析结果（可为 null / 非对象）
 * @returns {{values: Record<string, any>, issues: Array<{kind: string, field?: string, reason: string}>}}
 */
export function resolveConfig(raw) {
  /** @type {Record<string, any>} */ const values = {}
  const issues = []

  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, any>} */ (raw)
    : {}

  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    issues.push({ kind: 'corrupt', reason: 'settings.json 不是对象，整体回退默认' })
  }

  for (const [field, spec] of Object.entries(CONFIG_SPEC)) {
    const given = getPath(source, field)
    if (given === undefined) {
      values[field] = spec.default
      continue
    }
    const verdict = checkField(field, spec, given)
    if (verdict.ok) {
      values[field] = given
    } else {
      values[field] = spec.default
      issues.push({ kind: 'invalid', field, reason: verdict.reason })
    }
  }

  // 未知字段只报告，不影响取值。
  for (const field of flattenKeys(source)) {
    if (!(field in CONFIG_SPEC)) {
      issues.push({ kind: 'unknownField', field, reason: '不在配置总表内，已忽略' })
    }
  }

  // 跨字段约束：两个字段一起回退默认。
  for (const constraint of CONSTRAINT_SPECS) {
    if (!constraint.check(values)) {
      for (const field of constraint.fields) {
        values[field] = CONFIG_SPEC[field].default
      }
      issues.push({
        kind: 'invalid',
        field: constraint.fields.join(' + '),
        reason: `constraintViolated: ${constraint.name}；两字段均回退默认`,
      })
    }
  }

  return { values, issues }
}

/**
 * 单字段校验。
 * @param {string} field
 * @param {FieldSpec} spec
 * @param {unknown} given
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkField(field, spec, given) {
  if (spec.type === 'bool') {
    return typeof given === 'boolean'
      ? { ok: true }
      : { ok: false, reason: `应是布尔值，实际 ${typeof given}` }
  }
  if (spec.type === 'str') {
    if (typeof given !== 'string') return { ok: false, reason: `应是字符串，实际 ${typeof given}` }
    if (spec.enum && !spec.enum.includes(given)) {
      return { ok: false, reason: `取值必须是 ${spec.enum.join(' / ')}` }
    }
    return { ok: true }
  }
  // int / num
  if (typeof given !== 'number' || !Number.isFinite(given)) {
    return { ok: false, reason: `应是数字，实际 ${typeof given}` }
  }
  if (spec.type === 'int' && !Number.isInteger(given)) {
    return { ok: false, reason: '应是整数' }
  }
  if (spec.min !== undefined && given < spec.min) {
    return { ok: false, reason: `不得小于 ${spec.min}` }
  }
  if (spec.max !== undefined && given > spec.max) {
    return { ok: false, reason: `不得大于 ${spec.max}` }
  }
  return { ok: true }
}

/**
 * 把嵌套对象压平成点号键，只用于「未知字段」检测。
 * @param {Record<string, any>} obj
 * @param {string} [prefix]
 * @returns {string[]}
 */
function flattenKeys(obj, prefix = '') {
  const out = []
  for (const [key, value] of Object.entries(obj ?? {})) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...flattenKeys(value, dotted))
    } else {
      out.push(dotted)
    }
  }
  return out
}
