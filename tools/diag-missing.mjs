/**
 * 对比同一会话的三个日志版本，找出到底少了什么。
 * 用法：node diag-missing.mjs <目录>
 */
import fs from 'node:fs'
import path from 'node:path'
import { readEvents, messageText, summarize } from './session-store.mjs'

const dir = process.argv[2]
if (dir === undefined) throw new Error('usage: node diag-missing.mjs <会话目录>')

const files = fs
  .readdirSync(dir)
  .filter((name) => name.startsWith('session.v4.jsonl'))
  .sort()

const loaded = []
for (const name of files) {
  const file = path.join(dir, name)
  try {
    const { events } = readEvents(file)
    loaded.push({ name, file, events, bytes: fs.statSync(file).size })
  } catch (error) {
    loaded.push({ name, file, events: null, error: error.message, bytes: fs.statSync(file).size })
  }
}

console.log('=== 各版本概览 ===')
for (const item of loaded) {
  if (item.events === null) {
    console.log(`${item.name.padEnd(34)} ${String(item.bytes).padStart(7)}B  ❌ 解析失败: ${item.error}`)
    continue
  }
  const events = item.events
  const count = (type) => events.filter((e) => e.type === type).length
  console.log(
    `${item.name.padEnd(34)} ${String(item.bytes).padStart(7)}B  事件 ${String(events.length).padStart(4)}` +
      ` | user ${String(count('user/message')).padStart(3)}` +
      ` | assistant ${String(count('assistant/message')).padStart(3)}` +
      ` | tool/call ${String(count('tool/call')).padStart(3)}` +
      ` | tool/result ${String(count('tool/result')).padStart(3)}` +
      ` | 末 seq ${String(events.at(-1)?.seq)}`,
  )
}

console.log('\n=== 以最早（最全）的版本为基准，比较各版本缺失的 seq ===')
const baseline = loaded.filter((item) => item.events !== null).sort((a, b) => b.events.length - a.events.length)[0]
const baseSeqs = new Set(baseline.events.map((e) => Number(e.seq)))
console.log(`基准: ${baseline.name}（${String(baseline.events.length)} 个事件）`)

for (const item of loaded) {
  if (item.events === null || item === baseline) continue
  const seqs = new Set(item.events.map((e) => Number(e.seq)))
  const missing = [...baseSeqs].filter((seq) => !seqs.has(seq)).sort((a, b) => a - b)
  console.log(`\n--- ${item.name} 缺失 ${String(missing.length)} 个 seq ---`)
  const byType = new Map()
  for (const seq of missing) {
    const event = baseline.events.find((e) => Number(e.seq) === seq)
    byType.set(event.type, (byType.get(event.type) ?? 0) + 1)
  }
  console.log('  按类型:', [...byType].map(([t, n]) => `${t}×${String(n)}`).join(', '))
  for (const seq of missing.slice(0, 30)) {
    console.log('   ', summarize(baseline.events.find((e) => Number(e.seq) === seq)))
  }
  if (missing.length > 30) console.log(`    …还有 ${String(missing.length - 30)} 个`)
}

console.log('\n=== 基准版本里的用户消息（用于判断「你的话」是否还在） ===')
for (const event of baseline.events) {
  if (event.type !== 'user/message') continue
  const kind = event.data?.source?.kind ?? '?'
  const text = messageText({ data: { content: event.data.content ?? [] } }).replace(/\s+/gu, ' ').slice(0, 60)
  console.log(`  #${String(event.seq).padStart(4)} [${kind}] ${text}`)
}
