/**
 * 生成随包默认提示音 —— 纯代码合成，不采样任何现成音效。
 *
 * 为什么自己合成而不是打包一段"Steam 成就音"：那段录音是 Valve 的素材，
 * 我不能把它分发进插件里。这里用钟声的非谐波泛音列 + 指数衰减合成一个
 * 同风格的「成就解锁」音：明亮的上行三音 + 高频微光尾音。
 *
 * 用法：node tools/gen-chime.mjs   （输出 assets/task-end.wav、assets/await-input.wav）
 * 想换音色就改下面的 NOTE / addBell 参数，重跑一次即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 48_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'assets');

/** 音名 -> 频率（十二平均律，A4=440）。 */
const NOTE = {
  G5: 783.99,
  C6: 1046.5,
  E6: 1318.51,
  G6: 1567.98,
  C7: 2093.0,
};

/** @returns {Float64Array} 交织立体声缓冲区。 */
function makeBuffer(seconds) {
  return new Float64Array(Math.ceil(seconds * RATE) * 2);
}

/**
 * 叠一个钟/铃声。泛音列用非整数倍（0.5 / 1 / 2 / 2.76 / 5.4 / 8.93），
 * 这是金属敲击声"明亮且不闷"的关键；每个泛音各自指数衰减。
 */
function addBell(out, freq, options = {}) {
  const { at = 0, duration = 1.6, gain = 1, pan = 0 } = options;
  const partials = [
    { r: 0.5, a: 0.3, d: 1.6 },
    { r: 1.0, a: 1.0, d: 2.6 },
    { r: 2.0, a: 0.5, d: 3.8 },
    { r: 2.76, a: 0.32, d: 4.8 },
    { r: 5.4, a: 0.16, d: 6.4 },
    { r: 8.93, a: 0.07, d: 8.0 },
  ];
  const start = Math.floor(at * RATE);
  const n = Math.min(Math.floor(duration * RATE), out.length / 2 - start);
  const left = 1 - pan * 0.3;
  const right = 1 + pan * 0.3;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.005); // 5ms 起音，否则会有爆音
    let sample = 0;
    for (const p of partials) {
      sample += p.a * Math.exp(-p.d * t) * Math.sin(2 * Math.PI * freq * p.r * t);
    }
    sample *= attack * gain;
    const idx = (start + i) * 2;
    out[idx] += sample * left;
    out[idx + 1] += sample * right;
  }
}

/** 高频微光尾音：带一点颤动，模仿成就音里那层"闪光"。 */
function addShimmer(out, freq, options = {}) {
  const { at = 0, duration = 1.2, gain = 0.12, vibrato = 6 } = options;
  const start = Math.floor(at * RATE);
  const n = Math.min(Math.floor(duration * RATE), out.length / 2 - start);
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const wobble = 1 + 0.004 * Math.sin(2 * Math.PI * vibrato * t);
    const env = Math.min(1, t / 0.02) * Math.exp(-3.2 * t);
    const sample = gain * env * Math.sin(2 * Math.PI * freq * wobble * t);
    const idx = (start + i) * 2;
    out[idx] += sample * 0.8;
    out[idx + 1] += sample * 1.0;
  }
}

/** 归一化到峰值 peak，避免叠加后削波。 */
function normalize(out, peak = 0.89) {
  let max = 0;
  for (let i = 0; i < out.length; i += 1) {
    const v = Math.abs(out[i]);
    if (v > max) max = v;
  }
  if (!max) return;
  const k = peak / max;
  for (let i = 0; i < out.length; i += 1) out[i] *= k;
}

/** 写 16-bit PCM 立体声 wav（44 字节标准头）。 */
function writeWav(file, out) {
  const frames = out.length / 2;
  const data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + frames * 4, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); // fmt 块长度
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(2, 22); // 立体声
  data.writeUInt32LE(RATE, 24);
  data.writeUInt32LE(RATE * 4, 28); // 字节率
  data.writeUInt16LE(4, 32); // 块对齐
  data.writeUInt16LE(16, 34); // 位深
  data.write('data', 36);
  data.writeUInt32LE(frames * 4, 40);
  let offset = 44;
  for (let i = 0; i < out.length; i += 1) {
    const v = Math.max(-1, Math.min(1, out[i]));
    data.writeInt16LE(Math.round(v * 32_767), offset);
    offset += 2;
  }
  fs.writeFileSync(file, data);
  return { bytes: data.length, seconds: frames / RATE };
}

// —— 任务完成：上行三音 C6 → E6 → G6 + 微光，约 2 秒 ——
const taskEnd = makeBuffer(2.0);
addBell(taskEnd, NOTE.C6, { at: 0.0, duration: 1.5, gain: 0.85, pan: -0.5 });
addBell(taskEnd, NOTE.E6, { at: 0.11, duration: 1.5, gain: 0.9, pan: 0.1 });
addBell(taskEnd, NOTE.G6, { at: 0.22, duration: 1.7, gain: 1.0, pan: 0.5 });
addShimmer(taskEnd, NOTE.C7, { at: 0.3, duration: 1.4, gain: 0.1 });
normalize(taskEnd);

// —— 等待输入：短促两音 G5 → C6，约 1 秒，明显比完成音"轻" ——
const awaitInput = makeBuffer(1.0);
addBell(awaitInput, NOTE.G5, { at: 0.0, duration: 0.7, gain: 0.9, pan: -0.3 });
addBell(awaitInput, NOTE.C6, { at: 0.13, duration: 0.8, gain: 1.0, pan: 0.3 });
normalize(awaitInput, 0.8);

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [file, buffer] of [['task-end.wav', taskEnd], ['await-input.wav', awaitInput]]) {
  const info = writeWav(path.join(OUT_DIR, file), buffer);
  console.log(`  ${file}  ${info.bytes} 字节  ${info.seconds.toFixed(2)} 秒  ${RATE}Hz/16bit/立体声`);
}
console.log(`已写入 ${OUT_DIR}`);
