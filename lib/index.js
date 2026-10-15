/**
 * dsh-achievement-sound —— 宿主半区。
 *
 * 干一件事：DSH 里「任务完成」和「助手在等你回答」这两个时刻，用系统播放器放一声
 * 「成就解锁」风格的提示音。
 *
 * 为什么在宿主发声、不走浏览器：
 * - 浏览器半区的事件目录里**没有** agent/session 事件（只有 theme/locale/slots/connection），
 *   所以判断时机只能在宿主做；
 * - 宿主直接 spawn 系统播放器，DSH 页面关着也响，也不需要用户先点一下页面来解锁 AudioContext。
 *
 * 事件来源是 `session/event`（DSH 内部会话事件流），归类见 lib/sound.js。
 *
 * 为什么自带诊断日志（`debug`，默认开）：插件的 console.warn 在宿主进程里，
 * 有些部署根本落不到能读的文件上 —— 出问题时就是纯盲调。所以关键节点
 * （加载、事件采样、放行/跳过、spawn、子进程退出码与耗时）都会追加到
 * `$DSH_HOME/achievement-sound/diagnostic.log`，超过 64KB 自动砍掉前半段。
 * 其中「子进程耗时」是硬证据：`PlaySync()` 阻塞到播放结束，所以耗时 ≈ 冷启动 + 音频时长
 * 才说明声音真放完了（`detached: true` 那个坑就是这么测出来的，见 lib/sound.js）。
 *
 * @module dsh-achievement-sound
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import {
  KIND_AWAIT_INPUT,
  KIND_TASK_END,
  buildPlayCommand,
  classifyEvent,
  resolveSoundFile,
  shouldPlay,
} from './sound.js';

/** Cordis 插件名（Loader 诊断里显示）。 */
export const name = 'achievement-sound';

/** 随包默认音效目录。 */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(PACKAGE_DIR, '..', 'assets');

/** 默认冷却窗口（ms）。 */
const DEFAULT_COOLDOWN_MS = 1200;

/** 诊断日志上限：超过就只保留后半段，免得无限增长。 */
const LOG_CAP_BYTES = 64 * 1024;

/** 原始事件采样条数：足够看清事件词表，又不会把日志写爆。 */
const SAMPLE_LIMIT = 60;

/**
 * 宿主日志出口：统一走 stderr 前缀，和别的插件一样能在宿主日志里一眼分辨来源。
 * @param text - 一行消息。
 */
function warn(text) {
  try {
    console.warn(`[achievement-sound] ${text}`);
  } catch {
    // 日志出口本身坏掉时什么都不做。
  }
}

/**
 * 覆盖目录 `$DSH_HOME/achievement-sound/`。
 *
 * 把 `task-end.wav` / `await-input.wav` 丢进去就能换音：不用改配置，也不用重装插件。
 * @returns {string}
 */
function overrideDir() {
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'achievement-sound');
}

export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 任务完成（回合结束）时响。 */
  taskEnd: z.boolean().default(true),
  /** 助手停下来等你回答/选择时响。 */
  awaitInput: z.boolean().default(true),
  /** 任务完成音的 wav 绝对路径；留空 = 覆盖目录 > 随包默认。 */
  taskEndFile: z.string().default(''),
  /** 等待输入音的 wav 绝对路径；留空 = 覆盖目录 > 随包默认。 */
  awaitInputFile: z.string().default(''),
  /** 全局冷却窗口：并发子代理同时收尾时，窗口内只响一次。0 = 不冷却。 */
  cooldownMs: z.number().step(1).min(0).max(60_000).default(DEFAULT_COOLDOWN_MS),
  /** Windows 上用哪个 shell 宿主 SoundPlayer；留空 = 系统自带的 powershell.exe 5.1 绝对路径。 */
  windowsShell: z.string().default(''),
  /** 启动 1.5 秒后自检响一声。默认关：免得每次开 DSH 都吓一跳。 */
  playOnStart: z.boolean().default(false),
  /** 诊断日志（写到覆盖目录的 diagnostic.log）。0.1.x 默认开，稳定后可以关。 */
  debug: z.boolean().default(true),
});

/**
 * @param {import('@deepseek-ai/cordis').Context} root
 * @param {Record<string, unknown>} config - 已按 Config 解析过的配置。
 */
export function apply(root, config) {
  const cfg = config ?? {};
  const paths = { overrideDir: overrideDir(), assetDir: ASSET_DIR };
  const debug = cfg.debug !== false;
  const logFile = path.join(paths.overrideDir, 'diagnostic.log');

  /** 追加一行诊断日志；日志本身出任何问题都不能影响提示音。 */
  function dlog(text) {
    if (!debug) return;
    try {
      fs.mkdirSync(paths.overrideDir, { recursive: true });
      try {
        if (fs.statSync(logFile).size > LOG_CAP_BYTES) {
          const old = fs.readFileSync(logFile, 'utf8');
          fs.writeFileSync(logFile, old.slice(Math.ceil(old.length / 2)));
        }
      } catch {
        // 文件还不存在，不用轮转。
      }
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
    } catch {
      // 写不进去就算了。
    }
  }

  /** 同一类问题只抱怨一次，避免每条事件都刷一行日志。 */
  const warned = new Set();
  /** 上次真正发声的时间戳，用于全局冷却。 */
  let lastAt = 0;
  /** 原始事件采样计数。 */
  let sampled = 0;

  function warnOnce(key, text) {
    dlog(`warn ${key}: ${text}`);
    if (warned.has(key)) return;
    warned.add(key);
    warn(text);
  }

  function fileExists(file) {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }

  /** Windows shell 绝对路径（算一次就缓存）。 */
  let shellCache = '';

  /**
   * Windows 上优先 5.1：系统自带，且 `System.Media.SoundPlayer` 一定在（pwsh 7 不保证）。
   *
   * 用**绝对路径**而不是裸 `powershell.exe`：宿主进程的 PATH 有可能被裁剪过，
   * 裸名字会 ENOENT，而这种失败在盲调时最容易被误判成"事件没到"。
   */
  function windowsShell() {
    if (shellCache) return shellCache;
    const configured = String(cfg.windowsShell ?? '').trim();
    if (configured) {
      shellCache = configured;
    } else if (process.platform === 'win32') {
      const winDir = String(process.env.SystemRoot || process.env.windir || 'C:\\Windows');
      const candidate = path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      shellCache = fileExists(candidate) ? candidate : 'powershell.exe';
    } else {
      shellCache = 'powershell.exe';
    }
    return shellCache;
  }

  /** 首选播放器起不来时的退路：Linux 换 aplay，Windows 换 pwsh。 */
  function fallbackFor(file) {
    if (process.platform === 'linux') return buildPlayCommand('linux', file, { player: 'aplay' });
    if (process.platform === 'win32' && !/pwsh/i.test(windowsShell())) {
      return buildPlayCommand('win32', file, { powershell: 'pwsh' });
    }
    return null;
  }

  /**
   * 启动播放进程：不接管 stdio、不等待、不影响宿主。
   *
   * ⚠️ 不能加 `detached: true` —— 实测那样 PowerShell 会提前退出、声音出不来
   * （详见 lib/sound.js 里那张对照表）。`child.unref()` 已经足够让宿主不被吊住。
   *
   * @param command - buildPlayCommand 的结果。
   * @param file - wav 路径（仅用于失败时找退路）。
   * @param allowFallback - 是否允许再试一次退路（最多一次，避免来回重试）。
   * @param kind - 提示音种类（只为日志）。
   */
  function launch(command, file, allowFallback, kind) {
    const started = Date.now();
    let child;
    try {
      child = spawn(command.exe, command.args, command.spawn);
    } catch (error) {
      const message = String(error?.message ?? error);
      dlog(`spawn-throw kind=${kind} exe=${command.exe} ${message}`);
      const next = allowFallback ? fallbackFor(file) : null;
      if (next) {
        launch(next, file, false, kind);
        return;
      }
      warnOnce('spawn', `提示音播放失败（${command.exe}）：${message}`);
      return;
    }
    dlog(`spawn kind=${kind} exe=${command.exe} file=${file}`);
    child.on('error', (error) => {
      const message = String(error?.message ?? error);
      dlog(`spawn-error kind=${kind} exe=${command.exe} ${message}`);
      const next = allowFallback ? fallbackFor(file) : null;
      if (next) {
        launch(next, file, false, kind);
        return;
      }
      warnOnce('spawn', `提示音播放失败（${command.exe}）：${message}`);
    });
    // PlaySync 阻塞到播放结束，所以这个耗时是"声音有没有放完"的客观证据。
    child.on('exit', (code, signal) => {
      dlog(`exit kind=${kind} code=${code}${signal ? ` signal=${signal}` : ''} ms=${Date.now() - started}`);
    });
    child.unref();
  }

  /**
   * 放一声。
   * @param {string} kind - KIND_TASK_END | KIND_AWAIT_INPUT。
   * @returns {boolean} 是否成功起了播放进程。
   */
  function play(kind) {
    const resolved = resolveSoundFile(kind, cfg, paths, fileExists);
    if (!resolved.file) {
      warnOnce(`file:${kind}`, `${resolved.reason}，这次不响`);
      return false;
    }
    const command = buildPlayCommand(process.platform, resolved.file, {
      powershell: windowsShell(),
      player: 'paplay',
    });
    if (!command) {
      warnOnce('player', `平台 ${process.platform} 上没有可用的 wav 播放方式，提示音不会响`);
      return false;
    }
    launch(command, resolved.file, true, kind);
    return true;
  }

  const cooldownMs = Number(cfg.cooldownMs ?? DEFAULT_COOLDOWN_MS);

  dlog(`loaded pid=${process.pid} platform=${process.platform} node=${process.version}`);
  dlog(`paths override=${paths.overrideDir} asset=${ASSET_DIR}`);
  dlog(
    `config enabled=${cfg.enabled !== false} taskEnd=${cfg.taskEnd !== false} awaitInput=${cfg.awaitInput !== false}` +
      ` cooldownMs=${cooldownMs} playOnStart=${cfg.playOnStart === true} debug=${debug}` +
      ` shell=${process.platform === 'win32' ? windowsShell() : '(非 Windows)'}`,
  );

  if (cfg.enabled === false) {
    dlog('disabled：总开关是关的，不订阅任何事件');
    return;
  }

  // 会话事件流：turn/end = 任务完成，tool/call(ask_user_question) = 等你回答。
  root.on('session/event', (session, event) => {
    try {
      // 先采样一批原始事件：万一 DSH 换了事件词表，日志里能直接看出来。
      if (sampled < SAMPLE_LIMIT) {
        sampled += 1;
        const data = event?.data ?? {};
        const tool = String(data.name ?? data.toolName ?? '');
        dlog(`raw #${sampled} type=${String(event?.type ?? '(无 type)')}${tool ? ` name=${tool}` : ''}`);
      }
      const kind = classifyEvent(event);
      if (!kind) return;
      if (kind === KIND_TASK_END && cfg.taskEnd === false) {
        dlog(`skip kind=${kind} reason=taskEnd:off`);
        return;
      }
      if (kind === KIND_AWAIT_INPUT && cfg.awaitInput === false) {
        dlog(`skip kind=${kind} reason=awaitInput:off`);
        return;
      }
      const now = Date.now();
      if (!shouldPlay(lastAt, now, cooldownMs)) {
        dlog(`skip kind=${kind} reason=cooldown(${now - lastAt}ms < ${cooldownMs}ms)`);
        return;
      }
      // 先占住冷却窗口再播：即使 spawn 失败，也不要在窗口内反复重试、刷日志。
      lastAt = now;
      dlog(`fire kind=${kind}`);
      play(kind);
    } catch (error) {
      // 提示音是锦上添花：任何异常都不能冒泡到会话事件流里。
      const message = String(error?.message ?? error);
      dlog(`handler-error ${message}`);
      warn(`处理 session/event 出错：${message}`);
    }
  });

  dlog('subscribed session/event');

  if (cfg.playOnStart === true) {
    // 自检：启动后响一声，立刻知道通路通不通。
    dlog('playOnStart：1.5 秒后自检响一声');
    try {
      setTimeout(() => play(KIND_TASK_END), 1500);
    } catch {
      // 没有定时器就算了，不影响主功能。
    }
  }
}
