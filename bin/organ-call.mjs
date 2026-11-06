#!/usr/bin/env node
/**
 * 0.5.14：书同文能力的对外执行入口（CLI）。
 *
 * 为什么要有它：0.5.8 起「手」是公共那一双，但只有书同文自己能伸手——
 * 别的器官/别的时空想用我们的能力，得先开一个 DSH 会话去点 organ_call。
 * 这条命令把同一个门口搬到命令行：名片 → 门（安全插件）→ 公共那只手 → 回执，
 * 一步不少，痕迹还是落在 logs/organs-exec.jsonl 里。
 *
 * 用法（结果是一行 JSON，成功 ok:true，失败 ok:false + errorCode）：
 *   node bin\organ-call.mjs --ability blackhole.index.read
 *   node bin\organ-call.mjs --ability tongwen.note.append --content "一行字" --who blackhole
 *   node bin\organ-call.mjs --ability bridge-kit.chat.send --args "{\"messages\":[\"hi\"]}" --dry-run
 *
 * 参数：
 *   --ability <名>      能力名（必填）
 *   --content <文本>    写文件的内容 / http 的请求体
 *   --args <JSON>       跑命令的参数数组，或派单给工具的参数对象
 *   --who <名字>        这一下是谁请求的（默认 cli:<pid>），会写进痕迹与派单回执
 *   --timeout <毫秒>    本次最长等待
 *   --root <路径>       交接根目录，默认 ./tongwen
 *   --roots <路径;路径>  去哪找器官名片（分号分隔），默认与插件一致
 *   --dry-run           只探路：不落盘、不过门、不返回内容
 *   --pretty            缩进输出（给人看；机器读请用默认单行）
 *
 * 退出码：0 = 成功；1 = 失败（输出里带 errorCode 与 message）。
 */
import process from 'node:process'
import { organCall } from '../lib/organs.js'

const DEFAULT_ROOT = './tongwen'

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, who: `cli:${process.pid}` }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      const v = argv[i + 1]
      i += 1
      return v
    }
    switch (a) {
      case '--ability':
        out.ability = next()
        break
      case '--content':
        out.content = next()
        break
      case '--args':
        out.argsRaw = next()
        break
      case '--who':
        out.who = next()
        break
      case '--timeout':
        out.timeoutMs = Number(next())
        break
      case '--root':
        out.root = next()
        break
      case '--roots':
        out.roots = next()
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--pretty':
        out.pretty = true
        break
      case '--help':
      case '-h':
        out.help = true
        break
      default:
        out.unknown = out.unknown ?? []
        out.unknown.push(a)
    }
  }
  return out
}

function parseArgsValue(raw) {
  if (raw === undefined) return undefined
  const text = String(raw).trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch (err) {
    return { __parseError: String(err?.message ?? err) }
  }
}

function usage() {
  return [
    '书同文 · 器官能力对外入口（0.5.14）',
    '',
    '  node bin\\organ-call.mjs --ability <能力名> [选项]',
    '',
    '选项：',
    '  --content <文本>   写文件的内容 / http 请求体',
    '  --args <JSON>      命令参数数组，或派单给工具的参数对象',
    '  --who <名字>       谁请求的这一下（写进痕迹与派单回执）',
    '  --timeout <毫秒>   本次最长等待',
    '  --root <路径>      交接根目录，默认 ./tongwen',
    '  --roots <路径;路径> 去哪找器官名片（分号分隔）',
    '  --dry-run          只探路，不动手',
    '  --pretty           缩进输出',
    '',
    '出口口径：只读直接做；会改东西的先过安全插件的门（./safety-kit/state/gate），',
    '门批了才落到公共那只手；动手前先在 logs/organs-exec.jsonl 留一行。',
    '结果是 JSON：成功 ok:true；失败 ok:false + errorCode + message。',
  ].join('\n')
}

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (!opt.ability) {
    process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'E_ARGUMENT', message: '缺少 --ability；用 --help 看用法' })}\n`)
    return 1
  }

  const input = { ability: opt.ability, dryRun: opt.dryRun === true }
  if (opt.content !== undefined) input.content = opt.content
  if (opt.timeoutMs !== undefined && Number.isFinite(opt.timeoutMs)) input.timeoutMs = opt.timeoutMs
  if (opt.argsRaw !== undefined) {
    const args = parseArgsValue(opt.argsRaw)
    if (args && typeof args === 'object' && '__parseError' in args) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, errorCode: 'E_ARGUMENT', message: `--args 不是合法 JSON：${args.__parseError}` })}\n`,
      )
      return 1
    }
    input.args = args
  }

  // 运行时最小形状：ctx.root（痕迹与账本落盘的地方）+ config（名片根可换，门仍走安全插件默认目录）
  const runtime = {
    ctx: { root: opt.root, sessionId: opt.who },
    config: opt.roots ? { 'organs.roots': opt.roots } : {},
    sessionId: opt.who,
  }

  let result
  try {
    result = await organCall(runtime, input)
  } catch (err) {
    result = { ok: false, errorCode: 'CALL_FAILED', message: String(err?.stack ?? err) }
  }
  const text = opt.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)
  process.stdout.write(`${text}\n`)
  return result?.ok === true ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err?.stack ?? err}\n`)
    process.exit(1)
  },
)
