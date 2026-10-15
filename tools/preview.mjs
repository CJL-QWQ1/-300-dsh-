/**
 * 试听工具：走插件真正会走的那条路（lib/sound.js 的 buildPlayCommand + spawn），
 * 而不是另写一份播放逻辑 —— 这样"能听到"就等价于"插件通路是通的"。
 *
 * 用法：
 *   node tools/preview.mjs                 # 放任务完成音
 *   node tools/preview.mjs await-input     # 放等待输入音
 *   node tools/preview.mjs C:\some\a.wav   # 放指定文件
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlayCommand, isSafeWavPath } from '../lib/sound.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2] || 'task-end';
const file = path.isAbsolute(arg) || arg.endsWith('.wav')
  ? path.resolve(arg)
  : path.resolve(HERE, '..', 'assets', `${arg}.wav`);

if (!isSafeWavPath(file)) {
  console.error(`路径不合法（必须是绝对的 .wav，且不含控制字符）：${file}`);
  process.exit(1);
}

const command = buildPlayCommand(process.platform, file, {
  powershell: 'powershell.exe',
  player: 'paplay',
});
if (!command) {
  console.error(`平台 ${process.platform} 上没有可用的 wav 播放方式`);
  process.exit(1);
}

const encoded = command.args[command.args.length - 1] || '';
console.log(`播放：${file}`);
console.log(`命令：${command.exe} ${command.args.slice(0, -1).join(' ')} <EncodedCommand ${encoded.length} 字符>`);

// 这里故意用 stdio:'inherit' 并等它结束：能看到退出码，也方便连续试听。
// 插件运行时用 command.spawn（stdio:'ignore'，且**不带 detached** —— 带了 PowerShell
// 会提前退出、声音出不来，实测数据见 lib/sound.js 的对照表）。
const child = spawn(command.exe, command.args, { stdio: 'inherit', windowsHide: true });
child.on('error', (error) => {
  console.error(`启动失败：${String(error?.message ?? error)}`);
  process.exit(1);
});
child.on('exit', (code) => {
  console.log(code === 0 ? '播放完成（退出码 0）' : `播放进程退出码 ${code}`);
});
