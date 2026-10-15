/**
 * 帧级诊断：逐帧解压一个 session.v4.jsonl.zstd，报告每帧是否可解、解出多少字节、
 * 以及末尾是否有解析不了的残留。用于定位「改写后 DSH 丢掉整个会话」的原因。
 *
 * 用法：node diag-frames.mjs <日志文件>
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import { frameOffsets } from './session-store.mjs'

const file = process.argv[2]
if (file === undefined) throw new Error('usage: node diag-frames.mjs <日志文件>')

const buf = fs.readFileSync(file)
const offsets = frameOffsets(buf)
console.log(`文件: ${file}`)
console.log(`物理大小: ${String(buf.length)} 字节，魔数出现 ${String(offsets.length)} 次`)

let decoded = 0
let failed = 0
let decodedBytes = 0
const failures = []
const sizes = []

for (let index = 0; index < offsets.length; index += 1) {
  const start = offsets[index]
  const end = offsets[index + 1]
  try {
    const out = zlib.zstdDecompressSync(buf.subarray(start, end))
    decoded += 1
    decodedBytes += out.length
    sizes.push(out.length)
  } catch (error) {
    failed += 1
    failures.push({ index, start, end, len: end - start, code: error.code })
  }
}

console.log(`可解帧: ${String(decoded)}  不可解帧: ${String(failed)}  解出总字节: ${String(decodedBytes)}`)
if (sizes.length > 0) {
  const biggest = sizes.reduce((max, value, index) => (value > sizes[max] ? index : max), 0)
  console.log(`最大帧: #${String(biggest)} ${String(sizes[biggest])} 字节`)
}

if (failures.length > 0) {
  console.log('\n不可解的帧：')
  for (const item of failures.slice(0, 10)) {
    const slice = buf.subarray(item.start, Math.min(item.end, item.start + 16))
    console.log(
      `  #${String(item.index)} 区间 [${String(item.start)}, ${String(item.end)}) 长度 ${String(item.len)}` +
        `  ${item.code ?? ''}  头部: ${slice.toString('hex')}`,
    )
  }
  if (failures.length > 10) console.log(`  …还有 ${String(failures.length - 10)} 个`)
}

// 关键：文件末尾是否有多余字节（最后一个可解帧之后）
const lastOffset = offsets.at(-1)
const tailLength = buf.length - lastOffset
const tail = buf.subarray(lastOffset)
const zeroCount = tail.filter((byte) => byte === 0).length
console.log(`\n最后一段: 起始 ${String(lastOffset)}，长度 ${String(tailLength)}，其中零字节 ${String(zeroCount)}`)
if (tailLength > 0) {
  console.log(`  头部 32 字节: ${tail.subarray(0, 32).toString('hex')}`)
  console.log(`  尾部 32 字节: ${tail.subarray(Math.max(0, tail.length - 32)).toString('hex')}`)
  // 文本里能读出什么
  const printable = tail.toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff]/gu, '.')
  console.log(`  可读片段: ${printable.slice(0, 120)}`)
}
