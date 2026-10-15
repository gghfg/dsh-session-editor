/**
 * dsh-session-editor 的本地图形界面服务。
 *
 * 只用 Node 内置模块：起一个只监听 127.0.0.1 的小 HTTP 服务，服务一个单页界面，
 * 并提供浏览会话 / 搜索回复 / 改写 / 版本回滚的 JSON 接口。
 *
 * 为什么必须是独立进程而不是 DSH 插件：改写的是磁盘上的会话日志，而 DSH 内存里
 * 还握着旧的事件列表，所以只能在 DSH 关闭时改。这个服务会在保存前检查 DSH 是否
 * 在运行，并要求显式确认。
 *
 * 用法：node server.mjs [--port=4319] [--no-open]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import {
  listAssistantMessages,
  listSessions,
  readEvents,
  restoreAssistantBlocks,
  rewriteAssistantText,
} from './tools/session-store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.join(HERE, 'web')
const HISTORY_FILE = path.join(HERE, '.edit-history.json')
const HOST = '127.0.0.1'

const portArg = process.argv.find((value) => value.startsWith('--port='))
const PORT = Number(portArg === undefined ? 4319 : portArg.slice('--port='.length))
const OPEN_BROWSER = !process.argv.includes('--no-open')

// 会话根目录可用 --sessions-root= 或环境变量 DSH_SESSIONS_ROOT 覆盖（便于对副本测试）。
const rootArg = process.argv.find((value) => value.startsWith('--sessions-root='))
if (rootArg !== undefined) process.env.DSH_SESSIONS_ROOT = rootArg.slice('--sessions-root='.length)

//#region 改写历史（可回滚）

/** 结构：{ [logFile]: Array<{ id, at, seq, messageId, before, after, backup }> } */
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`)
}

//#endregion

//#region 会话缓存

/** 按「路径 + mtime + 大小」缓存解析结果，避免每次刷新都重解压。 */
const messageCache = new Map()

function cachedMessages(row) {
  const key = `${row.file}|${String(row.mtime)}|${String(row.bytes)}`
  const cached = messageCache.get(key)
  if (cached !== undefined) return cached
  const messages = listAssistantMessages(row.file)
  // 只留少量条目，避免长时间运行后吃内存
  if (messageCache.size > 24) messageCache.clear()
  messageCache.set(key, messages)
  return messages
}

/** 带基本元信息的会话清单。 */
function sessionsWithMeta() {
  const archived = archivedSessionIds()
  return listSessions().map((row) => ({
    sessionId: row.sessionId,
    workspace: row.workspace,
    file: row.file,
    bytes: row.bytes,
    mtime: row.mtime,
    title: titleCache.get(row.file)?.title ?? null,
    // DSH 侧栏不显示被归档的会话，这里标出来免得又以为「记录丢了」
    archived: archived.has(row.sessionId),
  }))
}

/**
 * 读 DSH 的 workspace.json，取出被归档的会话 id。
 * 归档的会话不会出现在侧栏，这是「找不到某条记录」最常见的原因。
 */
function archivedSessionIds() {
  const file = path.join(process.env.USERPROFILE ?? '', '.dsh', 'storages', 'workspace.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return new Set(parsed?.global?.archivedSessionIds ?? [])
  } catch {
    return new Set()
  }
}

/** 按会话 id 或日志路径定位一行。 */
function findSession(key) {
  const rows = listSessions()
  return rows.find((row) => row.sessionId === key || row.file === key)
}

//#endregion

//#region 会话标题

/**
 * 只靠 sessionId 认不出会话，所以给每个会话算一个「开场白」标题：
 * 优先用会话里第一条用户消息（最接近 DSH 界面上显示的标题），
 * 没有用户消息就退回第一条有正文的助手回复。
 *
 * 解析一个大日志要几十毫秒，所以按「路径 + 大小 + mtime」缓存结果。
 */
const titleCache = new Map()
const TITLE_TTL_MS = 10_000

/** 从事件序列里挑一段像标题的文本。 */
function pickTitle(events) {
  const clean = (value) => value.replace(/\s+/gu, ' ').trim()
  const textOfBlocks = (blocks) =>
    (Array.isArray(blocks) ? blocks : [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text ?? '')
      .join('')

  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const text = clean(textOfBlocks(event.data.content))
    if (text.length > 0) return text.slice(0, 60)
  }
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const text = clean(textOfBlocks(event.data?.message?.content))
    if (text.length > 0) return `（助手）${text.slice(0, 56)}`
  }
  return null
}

/** 懒加载一个会话的标题；已算过且文件没变就直接返回。 */
function titleOf(row) {
  const stamp = `${String(row.bytes)}|${String(Math.floor(row.mtime / 1000))}`
  const cached = titleCache.get(row.file)
  if (cached !== undefined && cached.stamp === stamp) return cached.title
  if (cached !== undefined && Date.now() - cached.at < TITLE_TTL_MS) return cached.title
  let title = null
  try {
    title = pickTitle(readEvents(row.file).events)
  } catch {
    title = null
  }
  titleCache.set(row.file, { stamp, title, at: Date.now() })
  return title
}

//#endregion

//#region DSH 运行检测

/** 查一次进程表，判断 DSH 是否在运行。 */
function dshRunning() {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'tasklist' : 'ps'
    const args = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm=']
    execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        resolve(null) // 问不出来就说不知道，交给用户判断
        return
      }
      resolve(/DeepSeek[ -]Harness/iu.test(stdout) || /dsh\b/u.test(stdout))
    })
  })
}

//#endregion

//#region HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  response.end(text)
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw.length === 0 ? {} : JSON.parse(raw)
}

/** 服务 web/ 下的静态文件，路径必须留在该目录内。 */
function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/u, '')
  const target = path.join(WEB_ROOT, relative)
  if (!target.startsWith(WEB_ROOT)) {
    response.writeHead(403)
    response.end('forbidden')
    return
  }
  fs.readFile(target, (error, data) => {
    if (error !== null) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(data)
  })
}

async function handleApi(request, response, url) {
  const route = `${request.method ?? 'GET'} ${url.pathname}`

  if (route === 'GET /api/sessions') {
    const rows = sessionsWithMeta()
    const history = loadHistory()
    sendJson(response, 200, {
      ok: true,
      sessions: rows.map((row) => ({
        ...row,
        edits: (history[row.file] ?? []).length,
      })),
    })
    return
  }

  if (route === 'GET /api/health') {
    sendJson(response, 200, { ok: true, dshRunning: await dshRunning() })
    return
  }

  // 会话标题按需算：界面先把列表画出来，再逐个补标题，避免首屏等解析所有日志。
  if (route === 'GET /api/title') {
    const key = url.searchParams.get('session')
    const row = findSession(key)
    if (row === undefined) {
      sendJson(response, 404, { ok: false, error: `找不到会话 ${String(key)}` })
      return
    }
    sendJson(response, 200, { ok: true, title: titleOf(row) })
    return
  }

  if (route === 'GET /api/messages') {
    const key = url.searchParams.get('session')
    const row = findSession(key)
    if (row === undefined) {
      sendJson(response, 404, { ok: false, error: `找不到会话 ${String(key)}` })
      return
    }
    let messages
    try {
      messages = cachedMessages(row)
    } catch (error) {
      sendJson(response, 200, { ok: false, error: `解析日志失败：${error.message}` })
      return
    }
    const history = loadHistory()
    sendJson(response, 200, {
      ok: true,
      session: row,
      messages,
      history: history[row.file] ?? [],
    })
    return
  }

  if (route === 'POST /api/rewrite') {
    let body
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const row = findSession(body.session)
    if (row === undefined) {
      sendJson(response, 404, { ok: false, error: `找不到会话 ${String(body.session)}` })
      return
    }
    if (typeof body.text !== 'string' || body.text.length === 0) {
      sendJson(response, 400, { ok: false, error: '新文本不能为空' })
      return
    }
    try {
      const result = rewriteAssistantText(row.file, Number(body.seq), body.text, {
        keepReasoning: body.keepReasoning === true,
      })
      const history = loadHistory()
      const entry = {
        id: `${String(Date.now())}-${String(body.seq)}`,
        at: Date.now(),
        seq: Number(body.seq),
        messageId: result.messageId,
        before: result.before,
        after: result.after,
        clearedReasoning: result.clearedReasoning,
        backup: result.backup,
        // 回滚要靠它整体还原（含被清空的思考块）
        beforeBlocks: result.beforeBlocks,
      }
      history[row.file] = [entry, ...(history[row.file] ?? [])]
      saveHistory(history)
      messageCache.clear()
      sendJson(response, 200, { ok: true, result, entry })
    } catch (error) {
      sendJson(response, 200, { ok: false, error: error.message })
    }
    return
  }

  if (route === 'POST /api/rollback') {
    let body
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const row = findSession(body.session)
    if (row === undefined) {
      sendJson(response, 404, { ok: false, error: `找不到会话 ${String(body.session)}` })
      return
    }
    const history = loadHistory()
    const entries = history[row.file] ?? []
    const index = entries.findIndex((entry) => entry.id === body.id)
    if (index === -1) {
      sendJson(response, 404, { ok: false, error: '找不到这条改写记录' })
      return
    }
    const entry = entries[index]
    try {
      // 用最初记录的完整块还原 —— 只恢复文本会让被清空的思考块永久丢失。
      if (!Array.isArray(entry.beforeBlocks) || entry.beforeBlocks.length === 0) {
        sendJson(response, 200, {
          ok: false,
          error:
            '这条改写记录缺少原始块快照（是旧版本记下的），无法完整回滚。' +
            `请改用备份文件：${String(entry.backup)}`,
        })
        return
      }
      const result = restoreAssistantBlocks(row.file, entry.seq, entry.beforeBlocks)
      // 回滚后把这条记录从历史里摘掉
      history[row.file] = entries.filter((item) => item.id !== entry.id)
      saveHistory(history)
      messageCache.clear()
      sendJson(response, 200, { ok: true, result, entry })
    } catch (error) {
      sendJson(response, 200, { ok: false, error: error.message })
    }
    return
  }

  sendJson(response, 404, { ok: false, error: `未知接口 ${route}` })
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${String(PORT)}`)
  // 只服务本机：拒绝任何非回环来源的请求
  const remote = request.socket.remoteAddress ?? ''
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/u.test(remote)) {
    response.writeHead(403)
    response.end('loopback only')
    return
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(request, response, url).catch((error) => {
      sendJson(response, 500, { ok: false, error: error.message })
    })
    return
  }
  serveStatic(request, response, url.pathname)
})

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${String(PORT)}/`
  console.log('dsh-session-editor 图形界面已启动')
  console.log(`  ${url}`)
  console.log('  会话日志目录：', path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'))
  console.log('  按 Ctrl+C 退出')
  if (OPEN_BROWSER) {
    execFile('cmd', ['/c', 'start', '', url], () => {
      /* 打不开浏览器也不影响使用，地址已经打印 */
    })
  }
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${String(PORT)} 已被占用。换一个：node server.mjs --port=4320`)
  } else {
    console.error('服务启动失败：', error.message)
  }
  process.exitCode = 1
})

//#endregion
