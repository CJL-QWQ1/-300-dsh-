/**
 * 纯逻辑自测：不启动宿主、不放声音，只验证 lib/sound.js 的判断。
 *
 * 运行：node test/selftest.mjs
 * 想真的听一声：node tools/preview.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  KIND_AWAIT_INPUT,
  KIND_TASK_END,
  QUESTION_TOOL,
  buildPlayCommand,
  classifyEvent,
  encodePowerShellCommand,
  escapePowerShell,
  isSafeWavPath,
  resolveSoundFile,
  shouldPlay,
} from '../lib/sound.js';

const DIR = os.tmpdir();
const wav = (name) => path.join(DIR, name);
const decoded = (command) => Buffer.from(command.args[command.args.length - 1], 'base64').toString('utf16le');

let passed = 0;
const failures = [];

/** 跑一条断言，失败不中断，最后统一报。 */
function test(label, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${label}：${String(error?.message ?? error)}`);
  }
}

// —— 事件归类 ——
test('turn/end 归类为任务完成', () => {
  assert.equal(classifyEvent({ type: 'turn/end', data: {} }), KIND_TASK_END);
});

test('ask_user_question 的 tool/call 归类为等待输入', () => {
  assert.equal(classifyEvent({ type: 'tool/call', data: { name: QUESTION_TOOL } }), KIND_AWAIT_INPUT);
});

test('toolName 这个别名也认（不同 DSH 版本字段名可能不同）', () => {
  assert.equal(classifyEvent({ type: 'tool/call', data: { toolName: 'ask_user_question' } }), KIND_AWAIT_INPUT);
});

test('别的工具调用不响', () => {
  assert.equal(classifyEvent({ type: 'tool/call', data: { name: 'read' } }), null);
  assert.equal(classifyEvent({ type: 'tool/result', data: { name: QUESTION_TOOL } }), null);
});

test('授权事件不在默认范围内（用户没选它）', () => {
  assert.equal(classifyEvent({ type: 'approval/asked', data: { id: 'a1' } }), null);
});

test('垃圾输入不抛异常、也不响', () => {
  assert.equal(classifyEvent(undefined), null);
  assert.equal(classifyEvent(null), null);
  assert.equal(classifyEvent({}), null);
  assert.equal(classifyEvent({ type: 42, data: null }), null);
});

test('提问工具名锁定为 ask_user_question（改名会静默失效，所以要钉住）', () => {
  assert.equal(QUESTION_TOOL, 'ask_user_question');
});

// —— 冷却窗口 ——
test('第一次一定响', () => {
  assert.equal(shouldPlay(0, 1_000, 1200), true);
  assert.equal(shouldPlay(null, 1_000, 1200), true);
  assert.equal(shouldPlay(undefined, 1_000, 1200), true);
});

test('冷却窗口内不响，窗口外才响', () => {
  assert.equal(shouldPlay(1_000, 1_500, 1200), false);
  assert.equal(shouldPlay(1_000, 2_199, 1200), false);
  assert.equal(shouldPlay(1_000, 2_200, 1200), true);
});

test('冷却设为 0 或非法值时等于不冷却', () => {
  assert.equal(shouldPlay(1_000, 1_000, 0), true);
  assert.equal(shouldPlay(1_000, 1_000, Number.NaN), true);
});

// —— 路径白名单 ——
test('只接受绝对的 .wav 路径', () => {
  assert.equal(isSafeWavPath(wav('a.wav')), true);
  assert.equal(isSafeWavPath(wav('A.WAV')), true);
  assert.equal(isSafeWavPath('assets/task-end.wav'), false, '相对路径不行');
  assert.equal(isSafeWavPath(wav('a.mp3')), false, 'SoundPlayer 只吃 wav');
  assert.equal(isSafeWavPath(''), false);
  assert.equal(isSafeWavPath(undefined), false);
});

test('含控制字符的路径一律拒绝（它最终会进命令行）', () => {
  assert.equal(isSafeWavPath(wav('a\nb.wav')), false);
  assert.equal(isSafeWavPath(`${wav('a.wav')}\u0000`), false);
});

// —— 文件解析优先级 ——
const existsSome = (...names) => (file) => names.some((n) => file.endsWith(n));

test('配置指定的文件优先于覆盖目录与随包默认', () => {
  const got = resolveSoundFile(
    KIND_TASK_END,
    { taskEndFile: wav('configured.wav') },
    { overrideDir: DIR, assetDir: DIR },
    existsSome('configured.wav', 'task-end.wav'),
  );
  assert.equal(got.file, wav('configured.wav'));
  assert.equal(got.reason, '');
});

test('覆盖目录优先于随包默认（丢文件就能换音）', () => {
  const override = path.join(DIR, 'override');
  const assets = path.join(DIR, 'assets');
  const got = resolveSoundFile(
    KIND_TASK_END,
    {},
    { overrideDir: override, assetDir: assets },
    (file) => file === path.join(override, 'task-end.wav') || file === path.join(assets, 'task-end.wav'),
  );
  assert.equal(got.file, path.join(override, 'task-end.wav'));
});

test('哪儿都没有时返回原因，由调用方决定怎么抱怨', () => {
  const got = resolveSoundFile(KIND_TASK_END, {}, { overrideDir: DIR, assetDir: DIR }, () => false);
  assert.equal(got.file, '');
  assert.match(got.reason, /找不到 task-end\.wav/);
});

test('配置里写了非法路径时不响，并说明原因', () => {
  const got = resolveSoundFile(
    KIND_AWAIT_INPUT,
    { awaitInputFile: 'relative.mp3' },
    { overrideDir: DIR, assetDir: DIR },
    existsSome('await-input.wav'),
  );
  assert.equal(got.file, '');
  assert.match(got.reason, /不是合法的绝对 \.wav/);
});

test('配置指定的文件不存在时不偷偷退回默认音（否则配置写错会被藏起来）', () => {
  const got = resolveSoundFile(
    KIND_TASK_END,
    { taskEndFile: wav('missing.wav') },
    { overrideDir: DIR, assetDir: DIR },
    existsSome('task-end.wav'), // 默认音明明在，也不该用它
  );
  assert.equal(got.file, '');
  assert.match(got.reason, /不存在/);
  assert.match(got.reason, /missing\.wav/);
});

test('存在性谓词抛异常时换下一个候选，不让提示音整体失败', () => {
  const override = path.join(DIR, 'override');
  const assets = path.join(DIR, 'assets');
  const got = resolveSoundFile(KIND_TASK_END, {}, { overrideDir: override, assetDir: assets }, (file) => {
    if (file.startsWith(override)) throw new Error('EACCES');
    return file === path.join(assets, 'task-end.wav');
  });
  assert.equal(got.file, path.join(assets, 'task-end.wav'));
});

// —— PowerShell 编码 ——
test("单引号按 PowerShell 规则转义成两个单引号", () => {
  assert.equal(escapePowerShell("a'b"), "a''b");
  assert.equal(escapePowerShell('no quotes'), 'no quotes');
});

test('EncodedCommand 是 UTF-16LE base64，能原样解回来', () => {
  const script = "(New-Object Media.SoundPlayer 'C:\\a b\\c.wav').PlaySync()";
  const encoded = encodePowerShellCommand(script);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script);
});

// —— 播放命令 ——
test('Windows 用 powershell.exe + EncodedCommand，命令里是 PlaySync', () => {
  const command = buildPlayCommand('win32', wav('task-end.wav'), { powershell: 'powershell.exe' });
  assert.equal(command.exe, 'powershell.exe');
  assert.deepEqual(command.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.deepEqual(command.spawn, { stdio: 'ignore', windowsHide: true });
  const script = decoded(command);
  assert.match(script, /Media\.SoundPlayer/);
  assert.match(script, /\.PlaySync\(\)/);
});

test('路径里有空格、引号、中文也能安全进命令（这正是用 EncodedCommand 的原因）', () => {
  const tricky = path.join(DIR, "视频 之类'sound.wav");
  assert.equal(isSafeWavPath(tricky), true);
  const script = decoded(buildPlayCommand('win32', tricky, { powershell: 'powershell.exe' }));
  assert.ok(script.includes("''"), '单引号应被转义');
  assert.ok(script.includes('视频 之类'), '中文与空格应原样保留');
});

test('windowsShell 可以换成 pwsh', () => {
  const command = buildPlayCommand('win32', wav('a.wav'), { powershell: 'pwsh' });
  assert.equal(command.exe, 'pwsh');
});

test('macOS 用 afplay，Linux 用调用方探测到的播放器', () => {
  assert.deepEqual(buildPlayCommand('darwin', wav('a.wav'), {}), {
    exe: 'afplay',
    args: [wav('a.wav')],
    spawn: { stdio: 'ignore', windowsHide: true },
  });
  assert.equal(buildPlayCommand('linux', wav('a.wav'), { player: 'aplay' }).exe, 'aplay');
});

// 回归钉子：这条是实测踩出来的坑，别再改回去。
// tools/diagnose.mjs 的对照数据（同一台机器、同一批 wav）：
//   detached + stdio:'ignore'    1000ms 的音频只活了  813ms  → 声音出不来
//   detached + stdio:'inherit'   2000ms 的音频只活了  671ms  → 声音出不来
//   非 detached + stdio:'ignore' 1000ms 的音频活了   1308ms  → 正常
//   非 detached + stdio:'inherit'2000ms 的音频活了   2298ms  → 正常
// PlaySync() 阻塞到播放结束，所以"存活时长 ≈ 冷启动 + 音频时长"才是真放完了。
test('绝不能带 detached：实测会让 PowerShell 提前退出、声音出不来', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const command = buildPlayCommand(platform, wav('a.wav'), { powershell: 'powershell.exe', player: 'aplay' });
    assert.ok(command, `${platform} 应该能构造出命令`);
    assert.equal(command.detached, undefined, `${platform} 的命令里不该有 detached`);
    assert.equal(command.spawn.detached, undefined, `${platform} 的 spawn 选项里不该有 detached`);
    assert.equal(command.spawn.stdio, 'ignore', `${platform} 应该用 stdio:'ignore'（PowerShell 会吐 CLIXML 进度流）`);
    assert.equal(command.spawn.windowsHide, true, `${platform} 应该隐藏窗口`);
  }
});

test('Linux 没探测到播放器、或平台不认识、或文件不合法时返回 null', () => {
  assert.equal(buildPlayCommand('linux', wav('a.wav'), {}), null);
  assert.equal(buildPlayCommand('haiku', wav('a.wav'), {}), null);
  assert.equal(buildPlayCommand('win32', wav('a.mp3'), { powershell: 'powershell.exe' }), null);
  assert.equal(buildPlayCommand('win32', '', { powershell: 'powershell.exe' }), null);
});

if (failures.length) {
  console.error(`\n${failures.length} 项失败：`);
  for (const line of failures) console.error(`  ✗ ${line}`);
  process.exit(1);
}
console.log(`\n${passed} 项自测全部通过（事件归类 / 冷却 / 路径白名单 / 文件优先级 / PowerShell 编码 / 播放命令 / spawn 参数）`);
