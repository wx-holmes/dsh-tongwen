/**
 * JSON 写盘统一走这里：把非 ASCII 字符转成 \uXXXX 转义，落到磁盘是纯 ASCII。
 *
 * 为什么要这样：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 读文件，
 * UTF-8 中文会被读成乱码，甚至把引号搅乱，让 ConvertFrom-Json 直接报
 * 「Invalid object passed in」；写成纯 ASCII 后，5.1 和 Node 都能正常解析，
 * 解析出来的中文内容一个字都不差。
 *
 * 只影响存储形式，不影响语义：JSON.parse 之后仍然是原来的字符串。
 */
export function jsonText(value, indent = 2) {
  const text = JSON.stringify(value, null, indent);
  if (text === undefined) return undefined;
  return text.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
