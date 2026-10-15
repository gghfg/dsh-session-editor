/**
 * 复刻 DSH 自己的帧扫描器（@deepseek-ai/dsh-session-persistence-jsonl 的
 * scanZstdFrames），用来判断一个日志文件在 **DSH 眼里**是否结构完整。
 *
 * 这段逻辑是逐字节解析 zstd 帧结构的：魔数、帧描述符、块头、块负载、checksum。
 * 任何一处不符就抛错，或在帧中途 EOF 时判定为 torn tail（DSH 会据此**截断**文件）。
 *
 * 用法：node scan-frames.mjs <日志文件>
 */
import fs from 'node:fs'

const ZSTD_MAGIC = 4247762216

/** 与 DSH 完全一致的帧扫描：返回完整帧区间与「尾部不完整帧」的起点。 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

for (const file of process.argv.slice(2)) {
  const buffer = fs.readFileSync(file)
  console.log(`\n=== ${file.split('\\').pop()} ===`)
  console.log(`物理大小 ${String(buffer.length)} 字节`)
  try {
    const { frames, tornStart } = scanZstdFrames(buffer)
    console.log(`DSH 扫描到完整帧: ${String(frames.length)}`)
    if (frames.length > 0) {
      const last = frames.at(-1)
      console.log(`  最后一帧区间: [${String(last.start)}, ${String(last.end)})`)
      console.log(`  帧结束后剩余字节: ${String(buffer.length - last.end)}`)
    }
    if (tornStart === undefined) {
      console.log('✅ DSH 认为这个文件结构完整，不会截断')
    } else {
      console.log(`❌ DSH 判定尾部不完整（torn tail），起点 ${String(tornStart)}`)
      console.log(`   → DSH 启动时会把这个文件截断到 ${String(tornStart)} 字节，丢掉后面全部内容`)
      const tail = buffer.subarray(tornStart, Math.min(buffer.length, tornStart + 24))
      console.log(`   尾部起始字节: ${tail.toString('hex')}`)
    }
  } catch (error) {
    console.log(`❌ DSH 扫描直接抛错: ${error.message}`)
    console.log('   → 这个会话会被 DSH 判为损坏')
  }
}
