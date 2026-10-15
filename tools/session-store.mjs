/**
 * DSH 会话日志读写工具：查看 / 搜索 / 改写「助手回复」。
 *
 * 为什么能改：模型每一步看到的历史来自会话事件日志，而日志就是磁盘上的
 * `~/.dsh/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd`。改掉里面某条
 * `assistant/message` 的文本块，下次恢复会话时模型看到的就是新文本，而且
 * **说话人仍然是 assistant**（这是它相对「追加替换事件」方案的关键优势：
 * 框架不允许用替换事件改写 assistant/message，但直接改日志没有这个限制）。
 *
 * 实测要点：日志是**逐帧追加**的 zstd（当前会话 600+ 帧）。Node 的
 * `zstdDecompressSync` 对多帧输入只返回第一帧，必须按「魔数位置切帧」逐帧
 * 解压再拼接，否则只能读到一行会话头。
 *
 * 命令行：
 *   node session-store.mjs list   [工作区目录名] [条数]   列出会话（最近优先）
 *   node session-store.mjs stat   <日志文件>
 *   node session-store.mjs last   <日志文件> [条数]
 *   node session-store.mjs find   <日志文件> <关键词>      在助手回复里搜关键词，给出 seq 与 id
 *   node session-store.mjs text   <日志文件> <seq>         打印某条消息的文本
 *   node session-store.mjs dump   <日志文件> <seq>         打印某条事件的完整 JSON
 *   node session-store.mjs rewrite <日志文件> <seq> <新文本> [--keep-reasoning]
 *
 * rewrite 会：备份原文件 → 替换文本块（默认同时清空旧的 reasoning 块）→
 * 整体重压写回 → 删除该会话的投影缓存，避免陈旧缓存干扰。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 可用环境变量 DSH_SESSIONS_ROOT 覆盖，便于对副本做测试而不碰真实日志。 */
const SESSIONS_ROOT =
  process.env.DSH_SESSIONS_ROOT ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
const PROJ_CACHE_ROOT = path.join(
  process.env.USERPROFILE ?? '',
  '.dsh',
  'storages',
  'session_projcache',
  'sessions',
)
const LOG_NAME = 'session.v4.jsonl.zstd'

//#region 多帧 zstd 读写

/** 所有 zstd 帧的起始偏移。 */
export function frameOffsets(buf) {
  const offsets = []
  let index = 0
  for (;;) {
    const found = buf.indexOf(MAGIC, index)
    if (found === -1) break
    offsets.push(found)
    index = found + 1
  }
  return offsets
}

/** 读出日志的全部文本（跨全部 zstd 帧）。 */
export function readLogText(file) {
  const buf = fs.readFileSync(file)
  const offsets = frameOffsets(buf)
  if (offsets.length === 0) throw new Error(`不是 zstd 帧文件：${file}`)
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = offsets[index + 1]
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      /* 单帧坏了就跳过，不让整段失败 */
    }
  }
  return parts.join('')
}

/** 读出全部事件（保持原行文本，写回时逐行替换）。 */
export function readEvents(file) {
  const text = readLogText(file)
  const events = []
  const lines = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      events.push(JSON.parse(line))
      lines.push(line)
    } catch {
      /* 忽略解不出的残行 */
    }
  }
  return { text, lines, events }
}

/**
 * 写回日志，**严格模仿 DSH 自己的编码方式**：每一行一个独立、带 checksum 的
 * zstd 帧，拼成一个「多帧容器」。
 *
 * 这不是审美问题。DSH 的持久化后端
 * （`@deepseek-ai/dsh-session-persistence-jsonl`）是这样写的：
 *
 *   - `compressZstdFrame()` 用 `ZSTD_c_checksumFlag = 1` 压每一批事件；
 *   - `scanZstdFrames()` 逐字节解析帧结构，据此决定「这个日志是否完整」，
 *     尾部不完整时会把文件**截断**到最后一个完整帧；
 *   - `appendLines()` 以 `open(path, "a")` 追加新帧。
 *
 * 所以一个不带 checksum 的整文件单帧，虽然能被 Node 解压、也能被
 * `scanZstdFrames` 解析，但和 DSH 平时写出来的东西不是同一种形状。为了不给
 * 后端留下任何「意外形状」，这里逐行逐帧、带 checksum 地写。
 */
export function writeEvents(file, lines) {
  const frames = lines.map((line) =>
    zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    }),
  )
  fs.writeFileSync(file, Buffer.concat(frames))
  return lines.reduce((total, line) => total + Buffer.byteLength(line, 'utf8') + 1, 0)
}

//#endregion

//#region 事件读取辅助

/** 事件里面向模型的文本。 */
export function messageText(event) {
  const blocks = event?.data?.message?.content ?? event?.data?.content ?? []
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** 事件里 assistant 的思考文本。 */
export function reasoningText(event) {
  const blocks = event?.data?.message?.content ?? []
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'reasoning')
    .map((block) => block.text ?? '')
    .join('')
}

/** 一行摘要。 */
export function summarize(event) {
  const seq = typeof event.seq === 'number' ? `#${String(event.seq).padStart(4)}` : '#----'
  const head = `${seq} ${event.type ?? '(header)'}`
  if (event.type === 'assistant/message') {
    const kinds = [...new Set((event.data.message.content ?? []).map((b) => b.type))].join('+')
    const body = messageText(event).replace(/\s+/gu, ' ').slice(0, 64)
    return `${head} [${kinds}] id=${event.data.message.id} ${body}`
  }
  if (event.type === 'user/message') {
    return `${head} id=${event.data.id} ${messageText(event).replace(/\s+/gu, ' ').slice(0, 64)}`
  }
  return head
}

/** 列出某条会话里的助手回复。 */
export function listAssistantMessages(file) {
  const { events } = readEvents(file)
  return events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => ({
      seq: Number(event.seq),
      messageId: event.data.message.id,
      text: messageText(event),
      reasoning: reasoningText(event),
      blockTypes: [...new Set((event.data.message.content ?? []).map((b) => b.type))],
      // 界面靠它区分「真回答」和「驱动工具的过程轮」
      hasTool: (event.data.message.content ?? []).some((b) => b.type !== 'text' && b.type !== 'reasoning'),
      time: event.time,
    }))
}

//#endregion

//#region 改写

/**
 * 就地改写一条 assistant/message。
 *
 * @param file - 会话日志路径。
 * @param seq - 目标事件的 seq。
 * @param newText - 新的回复文本。
 * @param options - `keepReasoning` 为 true 时保留旧思考块（默认清空，避免
 *   「思考里说能做、回复里说不能做」这种自相矛盾）。
 */
export function rewriteAssistantText(file, seq, newText, options = {}) {
  const { lines, events } = readEvents(file)
  const index = events.findIndex((event) => Number(event.seq) === seq)
  if (index === -1) throw new Error(`没有 seq=${String(seq)} 的事件`)
  const event = events[index]
  if (event.type !== 'assistant/message') {
    throw new Error(`seq=${String(seq)} 是 ${event.type}，只能改写 assistant/message`)
  }
  const before = messageText(event)
  const beforeReasoning = reasoningText(event)
  // 保留原始块的**完整拷贝**。回滚时必须拿它整体还原：只恢复文本是不够的，
  // 思考块一旦被清空就再也写不回来（这正是早先版本回滚失败的原因）。
  const beforeBlocks = JSON.parse(JSON.stringify(event.data.message.content ?? []))
  const blocks = event.data.message.content ?? []
  if (!blocks.some((block) => block?.type === 'text')) {
    throw new Error('这条消息没有文本块（可能只有工具调用），改写会破坏结构')
  }

  let replacedText = false
  let clearedReasoning = false
  event.data.message.content = blocks.map((block) => {
    if (block?.type === 'text') {
      if (replacedText) return { ...block, text: '' }
      replacedText = true
      return { ...block, text: newText }
    }
    if (block?.type === 'reasoning' && options.keepReasoning !== true) {
      clearedReasoning = true
      return { ...block, text: '' }
    }
    return block
  })

  lines[index] = JSON.stringify(event)
  const backup = `${file}.bak-${String(Date.now())}`
  fs.copyFileSync(file, backup)
  const written = writeEvents(file, lines)

  // 投影缓存里若残留旧内容，会让一些界面投影读出与日志不一致的值。
  const sessionId = path.basename(path.dirname(file))
  const cache = path.join(PROJ_CACHE_ROOT, `${sessionId}.json`)
  let cacheRemoved = false
  if (fs.existsSync(cache)) {
    fs.rmSync(cache)
    cacheRemoved = true
  }

  return {
    before,
    beforeReasoning,
    beforeBlocks,
    after: newText,
    clearedReasoning,
    backup,
    written,
    messageId: event.data.message.id,
    cacheRemoved,
  }
}

/**
 * 用一整组原始块还原一条助手消息（回滚用）。
 *
 * 与 `rewriteAssistantText` 的区别：这里不做文本替换，而是把 `blocks` 原样
 * 写回，所以被改写时清空的思考块也能一并恢复。
 *
 * @param file - 会话日志路径。
 * @param seq - 目标事件的 seq。
 * @param blocks - 最初记录的 `beforeBlocks`。
 */
export function restoreAssistantBlocks(file, seq, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('没有可用的原始块记录，无法回滚（这条改写记录缺少 beforeBlocks）')
  }
  const { lines, events } = readEvents(file)
  const index = events.findIndex((event) => Number(event.seq) === seq)
  if (index === -1) throw new Error(`没有 seq=${String(seq)} 的事件`)
  const event = events[index]
  if (event.type !== 'assistant/message') {
    throw new Error(`seq=${String(seq)} 是 ${event.type}，不是助手消息`)
  }
  const current = messageText(event)
  event.data.message.content = JSON.parse(JSON.stringify(blocks))
  lines[index] = JSON.stringify(event)
  const backup = `${file}.bak-${String(Date.now())}`
  fs.copyFileSync(file, backup)
  const written = writeEvents(file, lines)

  const sessionId = path.basename(path.dirname(file))
  const cache = path.join(PROJ_CACHE_ROOT, `${sessionId}.json`)
  let cacheRemoved = false
  if (fs.existsSync(cache)) {
    fs.rmSync(cache)
    cacheRemoved = true
  }

  return {
    restoredFrom: current,
    restoredTo: messageText(event),
    restoredReasoningLength: reasoningText(event).length,
    backup,
    written,
    cacheRemoved,
  }
}

//#endregion

//#region 会话发现

/** 列出全部会话日志，最近修改优先。 */
export function listSessions(workspaceName) {
  const rows = []
  if (!fs.existsSync(SESSIONS_ROOT)) return rows
  for (const workspace of fs.readdirSync(SESSIONS_ROOT)) {
    if (workspaceName !== undefined && workspace !== workspaceName) continue
    const workspaceDir = path.join(SESSIONS_ROOT, workspace)
    if (!fs.statSync(workspaceDir).isDirectory()) continue
    for (const sessionId of fs.readdirSync(workspaceDir)) {
      const file = path.join(workspaceDir, sessionId, LOG_NAME)
      if (!fs.existsSync(file)) continue
      const stat = fs.statSync(file)
      rows.push({ workspace, sessionId, file, bytes: stat.size, mtime: stat.mtimeMs })
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime)
}

//#endregion

//#region 命令行

const isMain =
  process.argv[1] !== undefined && import.meta.url === `file:///${process.argv[1].replace(/\\/gu, '/')}`

if (isMain) {
  const [command, ...rest] = process.argv.slice(2)
  const flags = new Set(rest.filter((value) => value.startsWith('--') && !value.includes('=')))
  // 注意：工作区目录名本身就以 `--` 开头（例如 --C-Users-...--），
  // 所以位置参数不能简单地按「是否以 -- 开头」过滤，必须排除已知开关。
  const positional = rest.filter((value) => {
    if (value.startsWith('--keep-reasoning')) return false
    if (value.startsWith('--workspace=')) return false
    if (value.startsWith('--limit=')) return false
    if (value.startsWith('--text=')) return false
    return true
  })
  const optionOf = (name) => {
    const hit = rest.find((value) => value.startsWith(`--${name}=`))
    return hit === undefined ? undefined : hit.slice(name.length + 3)
  }

  if (command === undefined) {
    console.log(
      [
        '用法：',
        '  session-store.mjs list   [--workspace=<工作区目录名>] [--limit=<条数>]',
        '  session-store.mjs stat   <日志文件>',
        '  session-store.mjs last   <日志文件> [条数]',
        '  session-store.mjs find   <日志文件> <关键词>',
        '  session-store.mjs text   <日志文件> <seq>',
        '  session-store.mjs dump   <日志文件> <seq>',
        '  session-store.mjs rewrite <日志文件> <seq> --text="新文本" [--keep-reasoning]',
        '',
        '提示：新文本推荐用 --text="…" 传入。直接写位置参数在 PowerShell 里遇到中文或',
        '空格时可能被分词，甚至误建出重定向文件（这个坑我踩过）。',
      ].join('\n'),
    )
  } else if (command === 'list') {
    const rows = listSessions(optionOf('workspace'))
    const limit = Number(optionOf('limit') ?? 20)
    if (rows.length === 0) {
      console.log('没有找到会话日志。')
    }
    for (const row of rows.slice(0, limit)) {
      console.log(
        `${new Date(row.mtime).toLocaleString()}  ${String(Math.round(row.bytes / 1024)).padStart(5)}KB  ${row.sessionId}`,
      )
      console.log(`    ${row.workspace}`)
      console.log(`    ${row.file}`)
    }
  } else if (command === 'stat') {
    const { events } = readEvents(positional[0])
    const counts = new Map()
    for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
    console.log(`文件: ${positional[0]}`)
    console.log(`事件数: ${String(events.length)}  最后 seq: ${String(events.at(-1)?.seq)}`)
    console.log('类型统计:')
    for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${type.padEnd(26)} ${String(count)}`)
    }
  } else if (command === 'last') {
    const { events } = readEvents(positional[0])
    for (const event of events.slice(-Number(positional[1] ?? 25))) console.log(summarize(event))
  } else if (command === 'find') {
    const needle = positional[1]
    if (needle === undefined) throw new Error('缺少关键词')
    let hits = 0
    for (const item of listAssistantMessages(positional[0])) {
      const inText = item.text.includes(needle)
      const inReasoning = item.reasoning.includes(needle)
      if (!inText && !inReasoning) continue
      hits += 1
      console.log(
        `#${String(item.seq).padStart(4)} [${item.blockTypes.join('+')}] (${inText ? 'text' : 'reasoning'}) id=${item.messageId}`,
      )
      console.log(`    ${item.text.replace(/\s+/gu, ' ').slice(0, 110)}`)
    }
    console.log(`命中 ${String(hits)} 条`)
  } else if (command === 'rewrite') {
    // 文本既可以用位置参数给，也可以用 --text=<新文本> 给。
    // 后者在 PowerShell 里更安全：中文或含空格的位置参数有被分词误重定向的风险。
    const newText = optionOf('text') ?? positional[2]
    if (newText === undefined) {
      throw new Error('缺少新文本。用：rewrite <日志文件> <seq> --text="新文本"')
    }
    const result = rewriteAssistantText(positional[0], Number(positional[1]), newText, {
      keepReasoning: flags.has('--keep-reasoning'),
    })
    console.log(`已改写 seq=${positional[1]} id=${result.messageId}`)
    console.log(`  原文本: ${JSON.stringify(result.before.slice(0, 140))}`)
    console.log(`  新文本: ${JSON.stringify(result.after.slice(0, 140))}`)
    if (result.clearedReasoning) console.log('  已清空旧的思考块（加 --keep-reasoning 可保留）')
    console.log(`  备份: ${result.backup}`)
    if (result.cacheRemoved) console.log('  已删除该会话的投影缓存')
  } else if (command === 'text' || command === 'dump') {
    const { events } = readEvents(positional[0])
    const seq = Number(positional[1])
    const hit = events.find((event) => Number(event.seq) === seq)
    if (hit === undefined) throw new Error(`没有 seq=${String(seq)}`)
    console.log(command === 'dump' ? JSON.stringify(hit, null, 2) : JSON.stringify(messageText(hit)))
  } else {
    throw new Error(`未知命令：${command}`)
  }
}

//#endregion
