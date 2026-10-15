/**
 * 多帧 zstd 读取器。
 *
 * DSH 的 session.v4.jsonl.zstd 是**逐帧追加**的（实测当前会话有 201 个 zstd 帧），
 * 而 Node 的 zstdDecompressSync / createZstdDecompress 都只认单帧，遇到第二帧就报
 * `Unknown frame descriptor`。这里按魔数切帧、逐帧解压再拼起来。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 列出所有帧起始偏移。 */
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

/**
 * 尽力解出一个 zstd 帧。帧边界由「下一帧的魔数位置」给出——实测这才是
 * 正确切法：Node 对多帧输入只返回第一帧，所以必须逐帧喂。
 *
 * @returns {{text: string, end: number}}
 */
function decodeFrame(buf, start, end) {
  if (end !== undefined) {
    return { text: zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'), end }
  }
  // 兜底：没有下一帧魔数，用二分收缩找结束位置
  let lo = start + 4
  let hi = buf.length
  let best = null
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(start, mid)).toString('utf8')
      best = { text, end: mid }
      lo = mid + 1
    } catch {
      hi = mid - 1
    }
  }
  if (best === null) throw new Error(`无法解出 zstd 帧（起始偏移 ${String(start)}）`)
  return best
}

/** 读出全部帧的拼接文本。 */
export function readAllFrames(buf) {
  const offsets = frameOffsets(buf)
  if (offsets.length === 0) throw new Error('文件里没有 zstd 帧')
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = offsets[index + 1]
    try {
      parts.push(decodeFrame(buf, start, end).text)
    } catch {
      /* 单帧解不出就跳过，不让整段失败 */
    }
  }
  return parts.join('')
}

if (process.argv[1]?.endsWith('zstd-frames.mjs')) {
  const file = process.argv[2]
  const buf = fs.readFileSync(file)
  const offsets = frameOffsets(buf)
  console.log(`文件字节数: ${String(buf.length)}  帧数: ${String(offsets.length)}`)
  const text = readAllFrames(buf)
  console.log(`拼接后字符数: ${String(text.length)}`)
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  console.log(`行数: ${String(lines.length)}`)
  for (const line of lines.slice(-8)) {
    const event = JSON.parse(line)
    console.log(`  #${String(event.seq)} ${event.type}`)
  }
}
