/**
 * 复现框架层面的约束，解释为什么「在表层追加替换事件」无法改写助手回复、
 * 必须改用直接编辑日志文件（dsh-session-editor）。
 *
 * 结论：
 *   - 用 user/message 替换 assistant/message：成功，但说话人变成 user；
 *   - 用 assistant/message 替换：被框架拒绝 ——
 *     "assistant/message embeds its source stream and cannot carry sourceEventSeqs"。
 */
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

const text = (value) => [{ type: 'text', text: value }]

function build() {
  const session = Session.create(SessionId('surface-probe'), [], undefined, undefined, [])
  session.append(
    'system/message',
    {
      turn: 0,
      step: 0,
      message: { id: 'm-sys', role: 'system', content: text('你是助手。'), source: { kind: 'system-prompt' } },
    },
    { surfaceOp: 'append' },
  )
  session.append(
    'user/message',
    { id: 'm-user', role: 'user', content: text('帮我把这个任务做完。'), source: { kind: 'user' } },
    { surfaceOp: 'append' },
  )
  const assistant = session.append(
    'assistant/message',
    {
      turn: 0,
      step: 0,
      message: {
        id: 'm-a1',
        role: 'assistant',
        content: text('我可以完成这个任务。'),
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  return { session, assistant }
}

/** 试着用某类型事件替换那条助手回复。 */
function tryReplace(type, data) {
  const { session, assistant } = build()
  try {
    session.append(type, data, {
      surfaceOp: { op: 'replace', startSeq: assistant.seq, endSeq: assistant.seq },
      sourceEventSeqs: [assistant.seq],
    })
    return { ok: true, messages: session.deriveMessages() }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

// 1) user/message 替换：内容确实变了，但角色变成 user
const asUser = tryReplace('user/message', {
  id: 'm-a1',
  role: 'user',
  content: text('我无法完成这个任务。'),
  source: { kind: 'user' },
})
assert.equal(asUser.ok, true, 'user/message 替换应当成功')
const lastAsUser = asUser.messages.at(-1)
assert.equal(lastAsUser.content[0].text, '我无法完成这个任务。')
assert.equal(lastAsUser.role, 'user', '说话人变成了 user —— 这正是插件方案的固有缺陷')
console.log('[1] user/message 替换成功，但 role =', lastAsUser.role)

// 2) assistant/message 替换：被框架硬性拒绝
const asAssistant = tryReplace('assistant/message', {
  turn: 0,
  step: 0,
  message: {
    id: 'm-a1',
    role: 'assistant',
    content: text('我无法完成这个任务。'),
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
  },
  stream: [],
})
assert.equal(asAssistant.ok, false, 'assistant/message 替换应当被拒绝')
assert.match(asAssistant.error, /cannot carry sourceEventSeqs/u)
console.log('[2] assistant/message 替换被拒绝：', asAssistant.error)

console.log('\n结论：想连说话人一起改写，只能直接改会话日志文件（见 dsh-session-editor）。')
