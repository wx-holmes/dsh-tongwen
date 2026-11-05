/**
 * 错误码表 —— 规格 §15.2 冻结，禁止新增未登记的码。
 *
 * 每个码只带三样东西：是否阻断该次操作、降级影响、给用户看的一句话提示。
 * 提示只能陈述客观现象（§1.3 铁律 A：只报告不评价）。
 */

/**
 * @typedef {object} ErrorCodeSpec
 * @property {string} code
 * @property {string} trigger  什么情况下用这个码
 * @property {boolean} blocking 是否阻断该次操作
 * @property {string} degrade   降级影响说明
 * @property {string} message   面向用户的客观提示模板
 */

/** @type {Readonly<Record<string, ErrorCodeSpec>>} */
export const ERROR_CODES = Object.freeze({
  E_DISK_FULL: Object.freeze({
    code: 'E_DISK_FULL',
    trigger: '写 tmp / append / rename 时空间不足',
    blocking: true,
    degrade: '影响 audit → L1；影响运行区 → L2',
    message: '磁盘空间不足，写入未完成：{target}',
  }),
  E_PERMISSION: Object.freeze({
    code: 'E_PERMISSION',
    trigger: '无权限读 / 写 / 建锁',
    blocking: true,
    degrade: '顶层档不可写 → L1；audit 不可写 → L1；fallback 失败 → L2',
    message: '无写入权限：{target}',
  }),
  E_LOCK_TIMEOUT: Object.freeze({
    code: 'E_LOCK_TIMEOUT',
    trigger: '获取锁超时',
    blocking: true,
    degrade: '不升级',
    message: '等待锁超时：{resource}；未执行写入',
  }),
  E_STALE_LOCK: Object.freeze({
    code: 'E_STALE_LOCK',
    trigger: '锁的 acquiredAt / mtime 超时',
    blocking: false,
    degrade: '不升级，进 open lock_stale',
    message: '检测到疑似残留锁：{resource}，创建于 {time}',
  }),
  E_HASH_FAILED: Object.freeze({
    code: 'E_HASH_FAILED',
    trigger: '读文件失败 / I/O 错误',
    blocking: false,
    degrade: '该条标 failed；超阈值整份交接 degraded',
    message: '无法计算哈希：{path}（{reason}）',
  }),
  E_RENAME_FAILED: Object.freeze({
    code: 'E_RENAME_FAILED',
    trigger: 'tmp + rename 失败 / 跨设备',
    blocking: true,
    degrade: '快照失败保留 pending',
    message: '写入提交失败：{target}（{reason}）',
  }),
  E_INDEX_CORRUPT: Object.freeze({
    code: 'E_INDEX_CORRUPT',
    trigger: '索引损坏判定命中',
    blocking: false,
    degrade: '不升级（可重建）',
    message: '索引文件损坏，已保留旧文件并按真实目录重建',
  }),
  E_IO: Object.freeze({
    code: 'E_IO',
    trigger: 'EIO / EBUSY / ETXTBSY',
    blocking: true,
    degrade: '持续 → L1',
    message: 'I/O 异常：{target}（{reason}）',
  }),
  E_TIMEOUT: Object.freeze({
    code: 'E_TIMEOUT',
    trigger: 'self 扫描超时',
    blocking: false,
    degrade: '不升级（partial）',
    message: '扫描未完成（超时），结果不完整',
  }),
  E_LIMIT_EXCEEDED: Object.freeze({
    code: 'E_LIMIT_EXCEEDED',
    trigger: '超 maxFiles / maxDepth / treeHash / 批量 / limit',
    blocking: true,
    degrade: '不升级（批量需确认）',
    message: '超过上限：{limit}，已停止',
  }),
  E_NOT_FOUND: Object.freeze({
    code: 'E_NOT_FOUND',
    trigger: '产物 / 目标不存在',
    blocking: false,
    degrade: '不升级',
    message: '不存在：{path}',
  }),
  E_VALIDATION_BLOCKING: Object.freeze({
    code: 'E_VALIDATION_BLOCKING',
    trigger: '字段非法 / 路径越界 / schema 非法 / section 非法 / taskId 格式非法',
    blocking: true,
    degrade: '不升级（待确认类：用户确认后放行，审计 confirmed=true）',
    message: '校验未通过：{field}（{reason}）',
  }),
  E_VALIDATION_WARN: Object.freeze({
    code: 'E_VALIDATION_WARN',
    trigger: '配置非法回退 / 方向链断裂 / 索引重复 / typeSlug 回填',
    blocking: false,
    degrade: '不升级；按 §15.4 落点进 open-items，无落点只审计',
    message: '校验未通过（不阻断）：{object}（{reason}）',
  }),
  E_RESTORE_CONFLICT: Object.freeze({
    code: 'E_RESTORE_CONFLICT',
    trigger: '恢复目标已存在',
    blocking: true,
    degrade: '不升级',
    message: '恢复目标已存在：{path}；未覆盖',
  }),
  E_DEGRADED_READONLY: Object.freeze({
    code: 'E_DEGRADED_READONLY',
    trigger: '降级态（L1/L2）下请求业务写',
    blocking: true,
    degrade: '不升级',
    message: '当前为降级只读（{level}），写入拒绝',
  }),
})

/**
 * 组装一个带码的错误。
 * @param {string} code 必须已在 ERROR_CODES 内
 * @param {Record<string, string>} [vars] 提示模板里的占位
 * @returns {Error & {code: string, blocking: boolean, degrade: string}}
 */
export function pluginError(code, vars = {}) {
  const spec = ERROR_CODES[code]
  if (!spec) {
    // 未登记的错误码本身就是实现错误（§14.1 最后一条）。
    throw new Error(`未登记的错误码：${code}。规格 §15.2 禁止新增未登记的码。`)
  }
  const message = spec.message.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `?${key}?`))
  const error = new Error(message)
  error.code = spec.code
  error.blocking = spec.blocking
  error.degrade = spec.degrade
  return error
}

/**
 * 未覆盖的 errno → 统一归 E_IO 并需要审计 unknownErrno（§15.2 末行）。
 * @param {unknown} error
 * @param {string} target
 */
export function classifyErrno(error, target) {
  const code = String(/** @type {any} */ (error)?.code ?? '')
  const map = {
    ENOSPC: 'E_DISK_FULL',
    EACCES: 'E_PERMISSION',
    EPERM: 'E_PERMISSION',
    EROFS: 'E_PERMISSION',
    EIO: 'E_IO',
    EBUSY: 'E_IO',
    ETXTBSY: 'E_IO',
    ENOENT: 'E_NOT_FOUND',
    ENOTDIR: 'E_NOT_FOUND',
    EXDEV: 'E_RENAME_FAILED',
  }
  const mapped = map[code]
  const result = mapped
    ? { code: mapped, known: true }
    : { code: 'E_IO', known: false }
  return {
    ...result,
    errno: code || 'unknown',
    target,
    message: String(/** @type {any} */ (error)?.message ?? error),
  }
}
