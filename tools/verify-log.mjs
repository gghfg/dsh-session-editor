/**
 * 离线验证：一段 session.v4 JSONL 事件序列能不能被 DSH 自己的会话校验器接受，
 * 以及模型会看到哪些消息。
 *
 * 用法：
 *   node verify-log.mjs <会话日志文件> [期望在历史里出现的文本]
 */
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { readLogText, messageText } from './session-store.mjs'

const [file, expectText] = process.argv.slice(2)
if (file === undefined) throw new Error('usage: node verify-log.mjs <日志文件> [期望文本]')

const text = readLogText(file)
const lines = text.split('\n').filter((line) => line.trim().length > 0)

/** 第一行是会话头，其余是事件。 */
const headerLine = JSON.parse(lines[0])
if (headerLine.type !== 'session') throw new Error('第一行不是 session 头')
const rawEvents = lines.slice(1).map((line) => JSON.parse(line))

console.log(`头: version=${String(headerLine.version)} id=${headerLine.id} cwd=${headerLine.cwd}`)
console.log(`事件行数: ${String(rawEvents.length)}  首个 seq: ${String(rawEvents[0]?.seq)}  末个 seq: ${String(rawEvents.at(-1)?.seq)}`)

/** 还原成恢复器要的形态：事件体 + 顶层 surface 元数据。 */
const restoreEvents = rawEvents.map((raw) => {
  const { seq, time, type, data, ignorable, surfaceOp, sourceEventSeqs } = raw
  const event = { type, seq, time, data }
  if (ignorable !== undefined) event.ignorable = ignorable
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
  if (sourceEventSeqs !== undefined) event.sourceEventSeqs = sourceEventSeqs
  return event
})

const header = {
  version: headerLine.version,
  id: headerLine.id,
  createdAt: headerLine.createdAt,
  ...(headerLine.cwd === undefined ? {} : { cwd: headerLine.cwd }),
  ...(headerLine.parentSession === undefined ? {} : { parentSession: headerLine.parentSession }),
  ...(headerLine.isSeeded === undefined ? {} : { isSeeded: headerLine.isSeeded }),
  ...(headerLine.origin === undefined ? {} : { origin: headerLine.origin }),
  ...(headerLine.delegationDepth === undefined ? {} : { delegationDepth: headerLine.delegationDepth }),
  ...(headerLine.agentPreset === undefined ? {} : { agentPreset: headerLine.agentPreset }),
}

let session
try {
  session = Session.fromRestore(
    SessionId(headerLine.id),
    restoreEvents,
    header,
    SessionLogOffset(0),
    'detached',
    [],
  )
  console.log('\n✅ 恢复通过：会话日志能被校验器接受')
} catch (error) {
  console.log('\n❌ 恢复失败：', error.message)
  process.exitCode = 1
  process.exit()
}

const messages = session.deriveMessages()
console.log(`\n模型会看到 ${String(messages.length)} 条消息。最后 8 条：`)
for (const message of messages.slice(-8)) {
  const blocks = (message.content ?? []).map((block) => block.type).join('+')
  const body = messageText({ data: { message } }).replace(/\s+/gu, ' ').slice(0, 90)
  console.log(`  ${message.role.padEnd(9)} [${blocks}] ${body}`)
}

if (expectText !== undefined) {
  const found = messages.some((message) => messageText({ data: { message } }).includes(expectText))
  console.log(`\n${found ? '✅' : '❌'} 历史里${found ? '出现' : '没有出现'}期望文本：${JSON.stringify(expectText)}`)
  if (!found) process.exitCode = 1
}
