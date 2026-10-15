/**
 * dsh-achievement-sound —— 纯逻辑层。
 *
 * 这里只做「判断」，不碰 fs / child_process：事件归类、冷却窗口、音频文件解析、
 * 播放命令构造。所有副作用都留在 index.js，因此本文件可以被单测完整覆盖。
 *
 * @module dsh-achievement-sound/sound
 */
import path from 'node:path';

/** 任务完成（一个回合结束）。 */
export const KIND_TASK_END = 'task-end';
/** 助手停下来等你回答/选择。 */
export const KIND_AWAIT_INPUT = 'await-input';

/** DSH 里「助手向你提问」用的工具名。 */
export const QUESTION_TOOL = 'ask_user_question';

/** 种类 -> 配置里指定文件的字段名。 */
const FILE_KEYS = {
  [KIND_TASK_END]: 'taskEndFile',
  [KIND_AWAIT_INPUT]: 'awaitInputFile',
};

/**
 * 把一条 session/event 归类成提示音种类；不需要响的返回 null。
 *
 * 只认两件事：
 * - `turn/end`            —— 回合结束，也就是「任务完成」；
 * - `tool/call` 且工具名是 ask_user_question —— 助手在等你回答。
 *
 * 授权（approval/asked）刻意不认：本会话审批是关闭的，响了也只是噪音；
 * 需要的话在配置里放开即可（见 index.js）。
 *
 * @param {{type?: string, data?: {name?: string, toolName?: string}} | null | undefined} event
 * @returns {string | null} KIND_* 或 null。
 */
export function classifyEvent(event) {
  const type = String(event?.type ?? '');
  if (type === 'turn/end') return KIND_TASK_END;
  if (type === 'tool/call') {
    const data = event?.data ?? {};
    const name = String(data.name ?? data.toolName ?? '');
    if (name === QUESTION_TOOL) return KIND_AWAIT_INPUT;
  }
  return null;
}

/**
 * 全局冷却判断。
 *
 * 为什么要冷却：`turn/end` 对**每个**会话都会发，并发子代理各自收尾时会在几十毫秒内
 * 连着来好几条；没有冷却就会响成一片。窗口内只认第一条。
 *
 * @param {number | null | undefined} lastAt - 上次真正发声的时间戳（ms）；
 *   `0`、负数或非数字都表示「还没响过」，一律放行 —— 调用方就是用 0 做初始值的，
 *   否则插件加载后的第一声会被自己的冷却窗口吃掉。
 * @param {number} now - 当前时间戳（ms）。
 * @param {number} cooldownMs - 冷却窗口；<=0 表示不冷却。
 * @returns {boolean}
 */
export function shouldPlay(lastAt, now, cooldownMs) {
  if (typeof lastAt !== 'number' || !Number.isFinite(lastAt) || lastAt <= 0) return true;
  const span = Number(cooldownMs);
  if (!Number.isFinite(span) || span <= 0) return true;
  return now - lastAt >= span;
}

/**
 * 路径白名单：必须是绝对的 `.wav`，且不含控制字符。
 *
 * 收紧的原因有两条：一是 `Media.SoundPlayer` 本来就只吃 PCM wav（mp3 放不出来，
 * 本机也没有 ffmpeg 可转）；二是这个路径最终会进 PowerShell 命令行，
 * 先用白名单挡掉换行之类的东西，再配合 -EncodedCommand，杜绝拼接注入。
 *
 * @param {unknown} file
 * @returns {boolean}
 */
export function isSafeWavPath(file) {
  const text = String(file ?? '');
  if (!text) return false;
  if (/[\u0000-\u001f\u007f]/.test(text)) return false;
  if (!path.isAbsolute(text)) return false;
  return /\.wav$/i.test(text);
}

/**
 * 解析某个种类该放哪个文件。
 *
 * 优先级：**配置指定 > `$DSH_HOME/achievement-sound/<kind>.wav` > 随包默认**。
 * 中间那层是「丢文件就能换音」的口子：不用改配置、不用重装插件。
 *
 * 一个刻意的取舍：**配置里显式指定了文件时，就只对那一个文件负责** ——
 * 它不存在或不合法就直接返回原因、不响，而不是悄悄退回默认音。
 * 否则路径写错时"还有声音"，问题会被藏起来，很难查。
 *
 * @param {string} kind - KIND_TASK_END | KIND_AWAIT_INPUT。
 * @param {Record<string, unknown>} config - 已解析的插件配置。
 * @param {{overrideDir?: string, assetDir?: string}} paths
 * @param {(file: string) => boolean} exists - 存在性谓词（注入进来，保持本函数可单测）。
 * @returns {{file: string, reason: string}} 命中的绝对路径；没有则 file 为空串、reason 说明为什么。
 */
export function resolveSoundFile(kind, config, paths, exists) {
  const key = FILE_KEYS[kind];
  const configured = key ? String(config?.[key] ?? '').trim() : '';

  if (configured) {
    if (!isSafeWavPath(configured)) {
      return { file: '', reason: `配置里指定的不是合法的绝对 .wav 路径：${configured}` };
    }
    let found = false;
    try {
      found = exists(configured);
    } catch {
      found = false;
    }
    return found
      ? { file: configured, reason: '' }
      : { file: '', reason: `配置里指定的文件不存在：${configured}` };
  }

  const candidates = [];
  if (paths?.overrideDir) candidates.push(path.join(paths.overrideDir, `${kind}.wav`));
  if (paths?.assetDir) candidates.push(path.join(paths.assetDir, `${kind}.wav`));
  for (const file of candidates) {
    if (!isSafeWavPath(file)) continue;
    try {
      if (exists(file)) return { file, reason: '' };
    } catch {
      // 探测本身抛异常（权限、路径过长…）就换下一个候选，不值得让整个提示音失败。
    }
  }
  return { file: '', reason: `找不到 ${kind}.wav（找过：${candidates.join(' ; ') || '无候选目录'}）` };
}

/**
 * PowerShell 单引号字符串转义：`'` -> `''`。
 *
 * 这里用 split/join 而不是 `/'/g`：正则字面量里的引号会把简单的括号探针骗成
 * "字符串没闭合"（test/braces.mjs 不识别正则），而 split/join 一样清楚。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapePowerShell(text) {
  return String(text).split("'").join("''");
}

/**
 * 编成 `-EncodedCommand` 需要的 UTF-16LE base64。
 *
 * 用 EncodedCommand 而不是把路径拼进 -Command：路径里的空格、引号、`$`、反引号
 * 全都不再需要关心，也就不存在拼接注入。
 *
 * @param {string} script
 * @returns {string}
 */
export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * 构造播放命令（不执行）。
 *
 * - Windows：系统自带的 `Media.SoundPlayer`（走 powershell.exe 5.1，实测冷启动约 300ms）。
 *   它只解 PCM wav，正好和 isSafeWavPath 的白名单一致。
 * - macOS：`afplay`。
 * - Linux：调用方探测到的播放器（paplay / aplay）。
 *
 * ⚠️ 返回的 `spawn` 里**绝对不能有 `detached: true`**。这是实测踩出来的坑
 * （`tools/diagnose.mjs`，同一台机器、同一批 wav）：
 *
 * | spawn 组合 | 音频时长 | 子进程存活 | 结果 |
 * | --- | --- | --- | --- |
 * | detached + stdio:'ignore' | 1000ms | 813ms | 声音出不来 |
 * | detached + stdio:'inherit' | 2000ms | 671ms | 声音出不来 |
 * | 非 detached + stdio:'ignore' | 1000ms | 1308ms | 正常 |
 * | 非 detached + stdio:'inherit' | 2000ms | 2298ms | 正常 |
 *
 * `PlaySync()` 会阻塞到播放结束，所以「存活时长 ≈ 冷启动 + 音频时长」才代表真播完了；
 * detached 那两行明显偏短。要让宿主不被播放进程吊住，`child.unref()` 就够了。
 *
 * @param {string} platform - `process.platform`。
 * @param {string} file - 已通过白名单的 wav 路径。
 * @param {{powershell?: string, player?: string}} available
 * @returns {{exe: string, args: string[], spawn: {stdio: 'ignore', windowsHide: true}} | null}
 */
export function buildPlayCommand(platform, file, available = {}) {
  if (!isSafeWavPath(file)) return null;
  // stdio 用 ignore：PowerShell 会往 stderr 吐 CLIXML 进度流，收着没用还脏日志。
  const spawnOptions = { stdio: 'ignore', windowsHide: true };
  if (platform === 'win32') {
    const shell = String(available.powershell || 'powershell.exe');
    const script = `(New-Object Media.SoundPlayer '${escapePowerShell(file)}').PlaySync()`;
    return {
      exe: shell,
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)],
      spawn: spawnOptions,
    };
  }
  if (platform === 'darwin') return { exe: 'afplay', args: [file], spawn: spawnOptions };
  if (platform === 'linux') {
    const exe = String(available.player || '');
    return exe ? { exe, args: [file], spawn: spawnOptions } : null;
  }
  return null;
}
