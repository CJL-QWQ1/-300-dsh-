/**
 * 诊断：把几种 spawn 组合各放一次，长短交替，用「退出码 + 子进程存活时长 + 你的耳朵」
 * 三方对齐，确认插件运行时该用哪种启动方式。
 *
 * 为什么时长就是证据：`Media.SoundPlayer.PlaySync()` 会阻塞到播放结束，所以
 * 「存活时长 ≈ PowerShell 冷启动(~300ms) + 音频时长」才代表声音真放完了；
 * 明显偏短 = 被截断或根本没出声。这个脚本当初就是靠它抓出 `detached: true` 的坑。
 *
 * 顺序（每个之间隔 1.5 秒）：
 *   1 短(1.0s) detached + stdio:'ignore'        ← 0.1.0 用的，已知放不出来
 *   2 短(1.0s) command.spawn + unref            ← 插件现在真正用的
 *   3 长(2.0s) command.spawn + unref            ← 同上，换个音频再验一次
 *   4 长(2.0s) 非 detached + stdio:'inherit'    ← preview.mjs 用的，参照组
 *
 * 用法：
 *   node tools/diagnose.mjs              # 诊断「已安装到 profile 的那一份」
 *   node tools/diagnose.mjs .            # 诊断工作区源码（装之前先验）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// 已安装副本的位置：优先用宿主注入的 DSH_PROFILE_DIR，否则退回默认 profile 路径。
// （这里原先写死了某台机器的绝对路径 —— 公开仓库里不该有那种东西。）
const PROFILE_DIR =
  String(process.env.DSH_PROFILE_DIR || '').trim() || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const INSTALLED = path.join(PROFILE_DIR, 'node_modules', 'dsh-achievement-sound');
const pluginDir = path.resolve(process.argv[2] || INSTALLED);
const { buildPlayCommand, resolveSoundFile } = await import(
  pathToFileURL(path.join(pluginDir, 'lib', 'sound.js')).href
);

const exists = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

const dshHome = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
const paths = { overrideDir: path.join(dshHome, 'achievement-sound'), assetDir: path.join(pluginDir, 'assets') };

console.log(`诊断目标：${pluginDir}`);
console.log(`覆盖目录：${paths.overrideDir}（存在=${fs.existsSync(paths.overrideDir)}）`);
console.log(`随包目录：${paths.assetDir}（存在=${fs.existsSync(paths.assetDir)}）`);

const files = {};
for (const kind of ['await-input', 'task-end']) {
  const resolved = resolveSoundFile(kind, {}, paths, exists);
  if (!resolved.file) {
    console.error(`${kind} 解析失败：${resolved.reason}`);
    process.exit(1);
  }
  files[kind] = resolved.file;
  console.log(`${kind} => ${resolved.file}`);
}

/** Windows shell：和插件一样优先绝对路径，PATH 被裁剪时也不会 ENOENT。 */
function shellPath() {
  const winDir = String(process.env.SystemRoot || process.env.windir || 'C:\\Windows');
  const candidate = path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return exists(candidate) ? candidate : 'powershell.exe';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 启动一次并等它退出（最多 20 秒，结束后清掉定时器，不拖住脚本）。 */
function attempt(label, kind, spec) {
  const command = buildPlayCommand(process.platform, files[kind], {
    powershell: shellPath(),
    player: 'paplay',
  });
  if (!command) return Promise.resolve({ label, kind, code: null, ms: 0, errored: '构造不出播放命令' });
  const usePluginOptions = spec === 'plugin';
  const options = usePluginOptions ? { ...command.spawn } : spec;
  return new Promise((resolve) => {
    const started = Date.now();
    let errored = '';
    let settled = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ label, kind, code, ms: Date.now() - started, errored });
    };
    const child = spawn(command.exe, command.args, options);
    child.on('error', (error) => {
      errored = String(error?.message ?? error);
      finish(null);
    });
    child.on('exit', (code) => finish(code));
    if (usePluginOptions) child.unref(); // 插件就是这么做的
    timer = setTimeout(() => finish(null), 20_000);
  });
}

const variants = [
  ['1 短 detached+ignore（0.1.0 的用法）', 'await-input', { detached: true, stdio: 'ignore', windowsHide: true }],
  ['2 短 插件实际参数 command.spawn+unref', 'await-input', 'plugin'],
  ['3 长 插件实际参数 command.spawn+unref', 'task-end', 'plugin'],
  ['4 长 非detached+inherit（preview 参照）', 'task-end', { stdio: 'inherit', windowsHide: true }],
];

const expect = { 'await-input': 1000, 'task-end': 2000 };
console.log('\n开始逐个播放（每个之间隔 1.5 秒）：\n');
for (const [label, kind, spec] of variants) {
  const result = await attempt(label, kind, spec);
  const want = expect[kind];
  const verdict = result.errored
    ? `启动失败：${result.errored}`
    : result.ms >= want + 150
      ? '时长吻合，播完了'
      : `只有 ${result.ms}ms（音频 ${want}ms）=> 被截断或没出声`;
  console.log(`  ${label}: 退出码=${result.code} 耗时=${result.ms}ms  ${verdict}`);
  await sleep(1500);
}

console.log('\n结论要和「你实际听到几声」对齐：');
console.log('  第 1 声应该听不到（这就是 0.1.0 不响的原因）；');
console.log('  第 2、3 声是插件现在真正用的参数，能听到就说明修好了。');
