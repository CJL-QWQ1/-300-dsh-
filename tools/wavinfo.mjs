/**
 * 检查一个 wav 能不能被本插件用（也就是 `Media.SoundPlayer` 能不能放）。
 *
 * 换音之前先跑一下，能省掉一轮盲猜：
 *   node tools/wavinfo.mjs C:\path\to\your.wav
 *   node tools/wavinfo.mjs                 # 检查随包的两个默认音
 *
 * 硬要求：RIFF/WAVE 容器 + PCM 编码（fmt 块 wFormatTag = 1）+ 绝对路径 + `.wav` 后缀。
 * SoundPlayer **不解** mp3、也不解 IEEE float / ADPCM 之类的 wav 变体；
 * 本机没有 ffmpeg，插件也不负责转码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeWavPath } from '../lib/sound.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 解析 RIFF 块，返回 {riff, chunks, fmt, dataBytes}。 */
function inspect(file) {
  const buf = fs.readFileSync(file);
  const out = { size: buf.length, riff: buf.toString('ascii', 0, 4), wave: buf.toString('ascii', 8, 12), chunks: [] };
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    out.chunks.push(`${id}(${size})`);
    if (id === 'fmt ') {
      out.fmt = {
        encoding: buf.readUInt16LE(offset + 8),
        channels: buf.readUInt16LE(offset + 10),
        rate: buf.readUInt32LE(offset + 12),
        byteRate: buf.readUInt32LE(offset + 16),
        bits: buf.readUInt16LE(offset + 22),
      };
    } else if (id === 'data') {
      out.dataBytes = size;
    }
    offset += 8 + size + (size % 2); // 块按 2 字节对齐
  }
  return out;
}

const ENCODING_NAMES = { 1: 'PCM', 3: 'IEEE float', 6: 'A-law', 7: 'µ-law', 17: 'ADPCM (IMA)', 65534: 'WAVE_FORMAT_EXTENSIBLE' };

function report(file) {
  const label = path.basename(file);
  console.log(`\n=== ${label} ===`);
  console.log(`路径：${file}`);
  if (!fs.existsSync(file)) {
    console.log('结论：❌ 文件不存在');
    return false;
  }
  const info = inspect(file);
  console.log(`大小：${info.size} 字节（${(info.size / 1024).toFixed(1)} KB）`);
  console.log(`容器：${info.riff}/${info.wave}  块：${info.chunks.join(' ')}`);

  const problems = [];
  if (!isSafeWavPath(file)) problems.push('路径不合法：必须是绝对的 .wav，且不含控制字符');
  if (info.riff !== 'RIFF' || info.wave !== 'WAVE') problems.push(`不是 RIFF/WAVE 容器（${info.riff}/${info.wave}）—— mp3 改后缀会这样`);
  if (!info.fmt) problems.push('没有 fmt 块');

  if (info.fmt) {
    const name = ENCODING_NAMES[info.fmt.encoding] ?? `未知(${info.fmt.encoding})`;
    const { channels, rate, bits, byteRate } = info.fmt;
    const seconds = info.dataBytes && byteRate ? info.dataBytes / byteRate : 0;
    console.log(`格式：${name}  声道=${channels}  采样率=${rate}Hz  位深=${bits}bit`);
    console.log(`时长：${seconds.toFixed(2)} 秒`);
    if (info.fmt.encoding !== 1) problems.push(`编码是 ${name}，SoundPlayer 只解 PCM`);
    if (seconds > 8) problems.push(`时长 ${seconds.toFixed(1)} 秒偏长，会盖住后面的提示（建议 1–2 秒）`);
  }

  if (problems.length) {
    console.log(`结论：❌ 不能直接用 —— ${problems.join('；')}`);
    return false;
  }
  console.log('结论：✅ 可以用。把它复制成覆盖目录里的 task-end.wav / await-input.wav 即可（不用改配置、不用重启）');
  return true;
}

const args = process.argv.slice(2);
const targets = args.length
  ? args.map((a) => path.resolve(a))
  : ['task-end', 'await-input'].map((kind) => path.resolve(HERE, '..', 'assets', `${kind}.wav`));

let allOk = true;
for (const file of targets) allOk = report(file) && allOk;
process.exit(allOk ? 0 : 1);
