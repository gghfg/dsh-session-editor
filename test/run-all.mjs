/**
 * 一次跑完所有测试。
 *
 * 需要一个真实会话日志做「改写 → 回滚」的往返验证，所以这里会自己找一个
 * 带思考块的助手回复、复制到临时目录再测，**绝不改动原日志**。
 *
 * 用法：
 *   node test/run-all.mjs                    自动挑一个会话
 *   node test/run-all.mjs <日志文件> <seq>   指定日志与目标 seq
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { listSessions, readEvents, reasoningText } from '../tools/session-store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

/** 找一个「带思考块、且有正文」的助手回复当往返测试目标。 */
function pickTarget(file) {
  const { events } = readEvents(file)
  const candidates = events.filter(
    (event) =>
      event.type === 'assistant/message' &&
      reasoningText(event).trim().length > 0 &&
      (event.data.message.content ?? []).some((block) => block?.type === 'text'),
  )
  return candidates.length === 0 ? undefined : Number(candidates.at(-1).seq)
}

function run(title, script, args) {
  process.stdout.write(`\n=== ${title} ===\n`)
  if (!fs.existsSync(script)) {
    console.log(`跳过：找不到 ${path.relative(ROOT, script)}`)
    return null
  }
  const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' })
  const ok = result.status === 0
  console.log(ok ? `✅ ${title}` : `❌ ${title}（退出码 ${String(result.status)}）`)
  return ok
}

const results = []

// 框架约束复现：不需要外部数据
results.push(run('框架约束（surface 替换）', path.join(ROOT, 'tools', 'surface-test.mjs'), []))

// 「改写核心逻辑」与「/rewrite 命令路径」两组测试针对的是姊妹项目
// dsh-plugin-reply-rewrite（一个 DSH 插件，不在本发行包里）。开发商里两份
// 源码同在时顺带跑一遍，发行包里则自动跳过。
const PLUGIN = path.join(ROOT, '..', 'dsh-plugin-reply-rewrite')
const PLUGIN_TESTS = [
  ['改写核心逻辑（插件）', path.join(PLUGIN, 'test', 'core.test.mjs'), path.join(PLUGIN, 'src', 'core.mjs')],
  ['/rewrite 命令路径（插件）', path.join(PLUGIN, 'test', 'host.test.mjs'), path.join(PLUGIN, 'lib', 'index.mjs')],
]
for (const [title, script, dependency] of PLUGIN_TESTS) {
  if (!fs.existsSync(script) || !fs.existsSync(dependency)) {
    console.log(`\n跳过「${title}」：需要姊妹项目 dsh-plugin-reply-rewrite（不在本包里）`)
    continue
  }
  results.push(run(title, script, []))
}

// 往返测试：找一个真实会话，复制后测
const explicitFile = process.argv[2]
let source = explicitFile
let seq = process.argv[3] === undefined ? undefined : Number(process.argv[3])

if (source === undefined) {
  for (const row of listSessions()) {
    try {
      const candidate = pickTarget(row.file)
      if (candidate !== undefined) {
        source = row.file
        seq = candidate
        break
      }
    } catch {
      /* 这个会话读不了就跳过 */
    }
  }
}

if (source === undefined) {
  console.log('\n⚠️  找不到可用的真实会话日志，跳过往返测试。')
  console.log('    （没装 DSH、或所有会话都没有带思考块的助手回复）')
  console.log('    手动指定：node test/run-all.mjs <日志文件> <seq>')
} else {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-editor-test-'))
  const copy = path.join(tempDir, 'session.v4.jsonl.zstd')
  fs.copyFileSync(source, copy)
  console.log(`\n往返测试用的副本：${copy}`)
  console.log(`  来源会话：${path.basename(path.dirname(source))}  目标 seq：${String(seq)}`)
  results.push(run('改写 → 回滚往返', path.join(ROOT, 'test', 'roundtrip.test.mjs'), [copy, String(seq)]))
  fs.rmSync(tempDir, { recursive: true, force: true })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${failed === 0 ? '全部通过' : `${String(failed)} 项失败`}（共 ${String(results.length)} 项）`)
process.exitCode = failed === 0 ? 0 : 1
