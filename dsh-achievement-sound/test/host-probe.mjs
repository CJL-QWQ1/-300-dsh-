/**
 * 宿主半区探针：不启动 DSH，也不真的出声。
 *
 * 关键设计：把 `$DSH_HOME` 指向空临时目录，并让配置指向一个**不存在**的 wav，
 * 这样 resolveSoundFile 必定落空 —— 于是「订阅 session/event → 归类 → 开关 →
 * 冷却 → 解析文件 → 警告」整条链路都能验证，却不会 spawn 播放器（跑测试时不吵人）。
 *
 * 注意：本文件会 import lib/index.js，而它引了裸包 `@deepseek-ai/schemastery`，
 * 所以要在 profile 目录树里的副本中运行（工作区里解析不到裸包）。
 *
 * 运行：node test/host-probe.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-achv-probe-'));
// overrideDir() 是在 apply() 时才读的，所以这里改还来得及。
process.env.DSH_HOME = HOME;

// 注意：schemastery 的 schema 是「可调用」的 —— `Config({})` 直接返回带默认值的结果，
// 非法值会抛错；它没有 zod 那样的 `.parse()`（本探针最初就写错过这一点）。
const { Config, apply, name } = await import('../lib/index.js');
const { KIND_TASK_END, resolveSoundFile } = await import('../lib/sound.js');

const MISSING_END = path.join(HOME, 'missing-task-end.wav');
const MISSING_WAIT = path.join(HOME, 'missing-await-input.wav');
const QUESTION = { type: 'tool/call', data: { name: 'ask_user_question' } };
const TURN_END = { type: 'turn/end', data: {} };

/** 假宿主：只记录订阅，并提供手动派发。 */
function makeRoot() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    dispatch(event, payload) {
      const handler = handlers.get(event);
      if (handler) handler(payload.session, payload.data);
    },
  };
}

const fire = (root, data) => root.dispatch('session/event', { session: { id: 'probe' }, data });

// 收集宿主日志（插件统一走 console.warn 前缀）
const logs = [];
const originalWarn = console.warn;
console.warn = (text) => { logs.push(String(text)); };

function report(ok, label) {
  if (!ok) throw new Error(`断言失败：${label}`);
}

try {
  // —— 插件身份与配置默认值 ——
  report(name === 'achievement-sound', '插件名应为 achievement-sound');
  const defaults = Config({});
  report(defaults.enabled === true, '默认应启用');
  report(defaults.taskEnd === true, '任务完成音默认应开');
  report(defaults.awaitInput === true, '等待输入音默认应开');
  report(defaults.cooldownMs === 1200, '默认冷却应为 1200ms');
  report(defaults.playOnStart === false, '默认不该在启动时自检发声');
  report(defaults.taskEndFile === '', '默认不指定文件（走覆盖目录/随包默认）');
  report(defaults.debug === true, '诊断日志默认应开（宿主的 console.warn 常常读不到，没它就是盲调）');

  // —— 订阅与开关 ——
  const root = makeRoot();
  apply(root, Config({ taskEndFile: MISSING_END, awaitInputFile: MISSING_WAIT }));
  report(root.handlers.has('session/event'), '应订阅 session/event');

  const offRoot = makeRoot();
  apply(offRoot, Config({ enabled: false }));
  report(offRoot.handlers.size === 0, 'enabled=false 时不该订阅任何事件');

  // —— 归类：只有该响的事件才会走到解析文件那一步 ——
  logs.length = 0;
  fire(root, { type: 'tool/call', data: { name: 'read' } });
  fire(root, { type: 'tool/result', data: { name: 'ask_user_question' } });
  fire(root, { type: 'session/title', data: { title: 'x' } });
  fire(root, { type: 'approval/asked', data: { id: 'a1' } });
  report(logs.length === 0, `不该响的事件不应产生任何日志，实际：${JSON.stringify(logs)}`);

  // —— 缺文件时要说清楚是哪个文件、为什么 ——
  logs.length = 0;
  fire(root, TURN_END);
  report(logs.length === 1, `任务完成应尝试一次并报缺文件，实际 ${logs.length} 条`);
  report(logs[0].includes('[achievement-sound]'), '日志应带插件前缀');
  report(logs[0].includes('missing-task-end.wav'), '应指出缺失的具体文件');
  report(logs[0].includes('不存在'), '应说明原因是不存在');

  // 等待输入用**独立的 root**：上面那个 root 刚尝试过一次，1.2 秒冷却窗口会把这条吞掉
  // —— 那是正确行为，下面专门有一节验证它。
  logs.length = 0;
  const waitRoot = makeRoot();
  apply(waitRoot, Config({ taskEndFile: MISSING_END, awaitInputFile: MISSING_WAIT }));
  fire(waitRoot, QUESTION);
  report(logs.some((line) => line.includes('missing-await-input.wav')), '等待输入应指出它自己的文件');

  // —— 冷却窗口：并发子代理连着收尾时只响一次 ——
  // 观测方式：窗口内第二条被吞掉，所以"第二种音的缺失警告"根本不会出现。
  logs.length = 0;
  const coolRoot = makeRoot();
  apply(coolRoot, Config({ taskEndFile: MISSING_END, awaitInputFile: MISSING_WAIT }));
  fire(coolRoot, TURN_END);
  fire(coolRoot, TURN_END);
  fire(coolRoot, QUESTION);
  report(logs.filter((l) => l.includes('missing-task-end.wav')).length === 1, '冷却窗口内重复的 turn/end 只该尝试一次');
  report(logs.filter((l) => l.includes('missing-await-input.wav')).length === 0, '冷却窗口内第二种音也该被吞掉');

  // 冷却设为 0 时两种音都该尝试
  logs.length = 0;
  const noCoolRoot = makeRoot();
  apply(noCoolRoot, Config({ taskEndFile: MISSING_END, awaitInputFile: MISSING_WAIT, cooldownMs: 0 }));
  fire(noCoolRoot, TURN_END);
  fire(noCoolRoot, QUESTION);
  report(logs.some((l) => l.includes('missing-task-end.wav')), '冷却为 0 时任务完成音该尝试');
  report(logs.some((l) => l.includes('missing-await-input.wav')), '冷却为 0 时等待输入音也该尝试');

  // —— 单项开关 ——
  logs.length = 0;
  const quietRoot = makeRoot();
  apply(quietRoot, Config({ taskEnd: false, taskEndFile: MISSING_END, awaitInputFile: MISSING_WAIT }));
  fire(quietRoot, TURN_END);
  report(logs.length === 0, '关掉 taskEnd 后 turn/end 不该有任何动作');
  fire(quietRoot, QUESTION);
  report(logs.length === 1, '关掉 taskEnd 不该影响等待输入音');

  // —— 异常不许冒泡到会话事件流 ——
  logs.length = 0;
  fire(root, null);
  fire(root, undefined);
  fire(root, { type: 'turn/end' }); // 没有 data 也要能过
  report(true, '畸形事件不应抛异常');

  // —— 随包默认音确实存在，且是 SoundPlayer 能吃的格式 ——
  const assetDir = path.resolve(HERE, '..', 'assets');
  for (const kind of ['task-end', 'await-input']) {
    const got = resolveSoundFile(
      kind,
      {},
      { overrideDir: path.join(HOME, 'achievement-sound'), assetDir },
      (file) => fs.existsSync(file),
    );
    report(got.file.endsWith(`${kind}.wav`), `${kind} 应能从随包 assets 找到，实际 reason=${got.reason}`);
    const buf = fs.readFileSync(got.file);
    report(buf.toString('ascii', 0, 4) === 'RIFF', `${kind}.wav 应以 RIFF 开头`);
    report(buf.toString('ascii', 8, 12) === 'WAVE', `${kind}.wav 应是 WAVE 格式`);
    report(buf.readUInt16LE(20) === 1, `${kind}.wav 应是 PCM（SoundPlayer 只解 PCM）`);
    report(buf.readUInt16LE(22) === 2, `${kind}.wav 应是立体声`);
    report(buf.readUInt32LE(24) === 48000, `${kind}.wav 应是 48kHz`);
    report(buf.readUInt16LE(34) === 16, `${kind}.wav 应是 16bit`);
    report(buf.length > 44 + 4800, `${kind}.wav 不该是空壳（实际 ${buf.length} 字节）`);
    report(KIND_TASK_END === 'task-end', '种类常量应与文件名一致');
  }

  // —— 覆盖目录优先：丢一个 wav 进 $DSH_HOME/achievement-sound 就该用它 ——
  const overrideDir = path.join(HOME, 'achievement-sound');
  fs.mkdirSync(overrideDir, { recursive: true });
  fs.copyFileSync(path.join(assetDir, 'task-end.wav'), path.join(overrideDir, 'task-end.wav'));
  const overridden = resolveSoundFile('task-end', {}, { overrideDir, assetDir }, (f) => fs.existsSync(f));
  report(overridden.file === path.join(overrideDir, 'task-end.wav'), '覆盖目录应优先于随包默认');

  // —— 诊断日志：宿主的 console.warn 常常落不到能读的文件上，这个日志是唯一的可观测出口 ——
  // 上面那些 apply/fire 已经写过它了（debug 默认开），这里验证内容够不够定位问题。
  const logFile = path.join(overrideDir, 'diagnostic.log');
  report(fs.existsSync(logFile), '诊断日志应被写出来');
  const log = fs.readFileSync(logFile, 'utf8');
  report(log.includes('loaded pid='), '日志应记录加载与 pid');
  report(log.includes('subscribed session/event'), '日志应记录订阅成功');
  report(log.includes('fire kind=task-end'), '日志应记录放行了一次任务完成音');
  report(log.includes('reason=cooldown'), '日志应记录被冷却窗口挡下的那次');
  report(log.includes('不存在'), '日志应记录缺文件的原因');
  report(/^\d{4}-\d{2}-\d{2}T/m.test(log), '日志每行应带 ISO 时间戳');
} finally {
  console.warn = originalWarn;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 临时目录清不掉就算了 */ }
}

console.log('宿主半区探针通过：配置默认值 / 订阅与总开关 / 事件归类 / 缺文件原因 / 冷却窗口 / 单项开关 / 畸形事件 / 随包 wav 格式 / 覆盖目录优先 / 诊断日志');
