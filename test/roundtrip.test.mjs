/**
 * 回归测试：改写 + 回滚必须能**完整往返**，包括被清空的思考块。
 *
 * 这个测试针对的是一个真实发生过的缺陷：早先的回滚只恢复正文，
 * 被清空的 `reasoning` 块永远回不来（因为它用「保留现有思考块」的语义去回滚）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  readEvents,
  messageText,
  reasoningText,
  rewriteAssistantText,
  restoreAssistantBlocks,
} from '../tools/session-store.mjs'

const file = process.argv[2]
if (file === undefined) throw new Error('usage: node roundtrip.test.mjs <日志副本>')

const seq = Number(process.argv[3] ?? 74)

const before = (() => {
  const { events } = readEvents(file)
  const event = events.find((item) => Number(item.seq) === seq)
  assert.ok(event !== undefined, `没有 seq=${String(seq)}`)
  return {
    text: messageText(event),
    reasoning: reasoningText(event),
    blockTypes: (event.data.message.content ?? []).map((block) => block.type),
  }
})()

console.log(`[0] 改写前：正文 ${String(before.text.length)} 字，思考 ${String(before.reasoning.length)} 字，块 ${before.blockTypes.join('+')}`)
assert.ok(before.reasoning.length > 0, '这个测试需要一个带思考块的目标')

// 1) 改写（默认清空思考块）
const rewritten = rewriteAssistantText(file, seq, '我无法完成这项翻译任务。')
assert.equal(rewritten.after, '我无法完成这项翻译任务。')
assert.ok(rewritten.clearedReasoning, '应记录清空了思考块')
assert.ok(Array.isArray(rewritten.beforeBlocks) && rewritten.beforeBlocks.length > 0, '应返回原始块快照')

const afterRewrite = (() => {
  const { events } = readEvents(file)
  const event = events.find((item) => Number(item.seq) === seq)
  return { text: messageText(event), reasoning: reasoningText(event) }
})()
assert.equal(afterRewrite.text, '我无法完成这项翻译任务。')
assert.equal(afterRewrite.reasoning.length, 0, '改写后思考块应为空')
console.log(`[1] 改写后：正文 ${String(afterRewrite.text.length)} 字，思考 ${String(afterRewrite.reasoning.length)} 字`)

// 2) 回滚（用原始块整体还原）
const restored = restoreAssistantBlocks(file, seq, rewritten.beforeBlocks)
const afterRestore = (() => {
  const { events } = readEvents(file)
  const event = events.find((item) => Number(item.seq) === seq)
  return { text: messageText(event), reasoning: reasoningText(event) }
})()

assert.equal(afterRestore.text, before.text, '正文必须逐字回到原文')
assert.equal(afterRestore.reasoning, before.reasoning, '思考块也必须逐字回到原文')
console.log(`[2] 回滚后：正文 ${String(afterRestore.text.length)} 字，思考 ${String(afterRestore.reasoning.length)} 字 —— 与改写前一致`)

// 3) 事件总数不变（改写是就地替换，不是增删事件）
const { events } = readEvents(file)
console.log(`[3] 事件总数：${String(events.length)}（${String(events.at(-1).seq)} 为末 seq）`)

console.log('\n往返测试通过：正文与思考块都能完整恢复。')
