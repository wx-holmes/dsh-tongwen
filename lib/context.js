/**
 * 运行上下文 —— 把「档根」与九档绝对路径收在一处。
 *
 * 规格从头到尾说「顶层」「档根」，但没定义相对于什么（这是规格的缺口）。
 * 已与用户裁决：root = 盘根 `C:\`，九档直接铺在盘根下。
 * root 由插件配置（cordis.patch.yml）传入，不进 settings.json ——
 * 它是安装位置，不是运行参数，§15.1 的 33 个字段里没有它是对的。
 */

import path from 'node:path'
import { BUCKET_KEYS, bucketByPhysical, assertKnownBucket } from './buckets.js'
import { pluginError } from './errors.js'

/** 插件自己在 config 档下的运行区名（§2.2 冻结路径）。 */
export const PLUGIN_DIR_NAME = 'tongwen-tonggui'

/** 结构版本常量（§6.2 / §11.2 冻结值）。 */
export const STRUCTURE_VERSION = '9档-v1'
export const INDEX_SCHEMA_VERSION = 1
export const SNAPSHOT_SCHEMA_VERSION = '1.0'
export const RUNTIME_STATE_SCHEMA_VERSION = '1.0'

/**
 * @typedef {object} PluginContext
 * @property {string} root               档根绝对路径
 * @property {(key: string) => string} bucketDir      九档某档的绝对路径
 * @property {string} configDir          config/plugins/tongwen-tonggui
 * @property {string} indexFile          handoff/index.machine.json
 * @property {string} readmeFile         handoff/README.md
 * @property {string} directionsFile     handoff/directions.jsonl
 * @property {string} openItemsFile      handoff/open-items.jsonl
 * @property {string} projectsDir        handoff/projects（跨会话项目白板，扩展）
 * @property {string} inboxFile          handoff/inbox.jsonl（跨会话请求信箱，扩展）
 * @property {string} handoffSelfDir     handoff/self
 * @property {string} journalsDir        handoff/self/journals
 * @property {string} reportsDir         handoff/self/reports
 * @property {string} versionsDir        archive/versions
 * @property {string} trashDir           archive/trash
 * @property {string} restoredDir        archive/restored
 * @property {string} recoveryLogFile    archive/trash/recovery-log.jsonl
 * @property {string} auditDir           logs/audit
 * @property {string} locksDir           config/plugins/tongwen-tonggui/locks
 * @property {string} snapshotFile       config/plugins/tongwen-tonggui/self-snapshot.json
 * @property {string} runtimeStateFile   config/plugins/tongwen-tonggui/runtime-state.json
 * @property {string} currentFile        config/plugins/tongwen-tonggui/current.json
 * @property {string} settingsFile       config/plugins/tongwen-tonggui/settings.json
 * @property {string} pluginVersionsDir  config/plugins/tongwen-tonggui/versions
 */

/**
 * 规整 root：必须是绝对路径；去掉盘符根可能带的尾部反斜杠歧义。
 * @param {string} rawRoot
 * @returns {string}
 */
export function normalizeRoot(rawRoot) {
  const value = String(rawRoot ?? '').trim()
  if (!value) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'root',
      reason: '插件配置 root 为空。九档需要一个明确的档根，不猜。',
    })
  }
  if (!path.isAbsolute(value)) {
    throw pluginError('E_VALIDATION_BLOCKING', {
      field: 'root',
      reason: `插件配置 root 必须是绝对路径，收到：${value}`,
    })
  }
  const resolved = path.resolve(value)
  // 盘根 `C:\` resolve 后是 `C:\`，join 时会正确拼接子项，无需特殊处理。
  return resolved
}

/**
 * 由 root 造出全部约定路径。
 * @param {string} rawRoot
 * @returns {PluginContext}
 */
export function createContext(rawRoot) {
  const root = normalizeRoot(rawRoot)

  /** @param {string} key */
  const bucketDir = (key) => {
    const bucket = bucketByPhysical(key)
    if (!bucket) {
      // assertKnownBucket 只给理由；这里统一折成可返回的校验错误
      throw pluginError('E_VALIDATION_BLOCKING', {
        field: 'bucket',
        reason: assertKnownBucket(key).reason ?? `未知档位：${key}`,
      })
    }
    return path.join(root, bucket.physical)
  }

  const join = (key, ...rest) => path.join(bucketDir(key), ...rest)
  const pluginRoot = join('config', 'plugins', PLUGIN_DIR_NAME)

  return {
    root,
    bucketDir,
    bucketKeys: BUCKET_KEYS,

    configDir: pluginRoot,
    indexFile: join('handoff', 'index.machine.json'),
    readmeFile: join('handoff', 'README.md'),
    directionsFile: join('handoff', 'directions.jsonl'),
    openItemsFile: join('handoff', 'open-items.jsonl'),
    projectsDir: join('handoff', 'projects'),
    inboxFile: join('handoff', 'inbox.jsonl'),
    handoffSelfDir: join('handoff', 'self'),
    journalsDir: join('handoff', 'self', 'journals'),
    reportsDir: join('handoff', 'self', 'reports'),

    versionsDir: join('archive', 'versions'),
    trashDir: join('archive', 'trash'),
    restoredDir: join('archive', 'restored'),
    recoveryLogFile: join('archive', 'trash', 'recovery-log.jsonl'),

    auditDir: join('logs', 'audit'),

    locksDir: path.join(pluginRoot, 'locks'),
    snapshotFile: path.join(pluginRoot, 'self-snapshot.json'),
    runtimeStateFile: path.join(pluginRoot, 'runtime-state.json'),
    currentFile: path.join(pluginRoot, 'current.json'),
    settingsFile: path.join(pluginRoot, 'settings.json'),
    pluginVersionsDir: path.join(pluginRoot, 'versions'),
  }
}

/**
 * 把物理档名解析成档 key；不是九档就返回 null（用于扫描时过滤）。
 * @param {string} name
 */
export function bucketKeyOfPhysical(name) {
  const bucket = bucketByPhysical(name)
  return bucket ? bucket.key : null
}

/**
 * 生成一次运行内单调的时间戳目录名：`YYYY-MM-DD_HHmmss`。
 * 只用于 trash/restored 目录，**不得**用作实例主名（§14.1 硬禁止）。
 * @param {Date} [now]
 */
export function timestampDirName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}
