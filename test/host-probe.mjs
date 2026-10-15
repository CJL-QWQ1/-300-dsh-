/**
 * 宿主半区探针：用假的 Cordis 作用域跑一遍 apply()，验证
 *   - Config 的默认值能被解析
 *   - 路由注册 / index 注入行 / tapIndex 幂等
 *   - defineTool 能否接受这份工具定义（执行时还会按 output schema 校验）
 *   - 凭证解析 → 签名请求 → 归一化 → 落盘 的完整链路（网络被替换成桩）
 *   - 缺凭证时降级为 unconfigured 而不是抛错
 * 需要在能解析 @deepseek-ai/* 的目录里运行（例如 profile 目录下的临时副本）。
 * 用法：node test/host-probe.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/i, '$1'));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const SCRATCH = process.env.ACPROBE_SCRATCH || path.resolve(process.cwd(), '.ac-probe');
const WORKSPACE = path.join(SCRATCH, 'workspace');
const OUTSIDE = path.join(SCRATCH, 'explicit');
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

const FALLBACK_CONFIG = {
  accessKeyIdRef: 'ALIYUN_ACCESS_KEY_ID',
  accessKeySecretRef: 'ALIYUN_ACCESS_KEY_SECRET',
  endpoint: 'https://business.aliyuncs.com/',
  onlyAvailable: true,
  refreshMinutes: 0,
  autoFetchOnStart: false,
  widget: true,
  allowCredentialWrite: true,
  outputDir: '',
  outputSubdir: 'aliyun-coupon',
  markdownName: '代金券余额.md',
  jsonName: 'coupon-balance.json',
};

function makeScope(credValues) {
  const captured = { routes: [], tools: [], taps: [], events: [], intervals: [], timeouts: [], ctxEffects: 0 };
  const creds = new Map(credValues);
  const ctx = {
    webServer: {
      register: (route) => { captured.routes.push(route); return () => {}; },
      tapIndex: (transform) => { captured.taps.push(transform); return () => {}; },
    },
    credentials: {
      resolve: async (ref) => (creds.has(String(ref)) ? { value: creds.get(String(ref)) } : undefined),
      set: async (ref, value) => { creds.set(String(ref), value); },
      unset: async (ref) => { creds.delete(String(ref)); },
    },
    tools: { register: (tool) => { captured.tools.push(tool); return () => {}; } },
    timer: {
      interval: (callback, delay) => { captured.intervals.push(delay); return () => {}; },
      timeout: (callback, delay) => { captured.timeouts.push({ callback, delay }); return () => {}; },
    },
    workspaceRegistry: { list: () => [{ id: 'w1', path: WORKSPACE }] },
    connection: { requestRejection: () => undefined },
    effect: (body) => { captured.ctxEffects += 1; return body(); },
  };
  const root = {
    effect: (body) => body(),
    on: (event, listener) => { captured.events.push([event, listener]); return () => {}; },
    inject: (names, callback) => {
      for (const name of names) assert.ok(name in ctx, `注入清单里有宿主没有的服务：${name}`);
      callback(ctx);
    },
  };
  return { root, captured };
}

// 时间用相对值，免得这份探针在某天之后自己失效。
const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();
const payload = {
  Code: 'Success',
  Message: 'Successful！',
  RequestId: 'PROBE-REQ',
  Success: true,
  Data: {
    CashCoupon: [
      { CashCouponNo: 'Q-AAA', CashCouponId: 1, Balance: '100.00', NominalValue: '100.00', Status: 'Available', ExpiryTime: at(400), ApplicableProducts: '通用' },
      { CashCouponNo: 'Q-BBB', CashCouponId: 2, Balance: '49.90', NominalValue: '50.00', Status: 'Available', ExpiryTime: at(15), ApplicableProducts: '云数据库RDS' },
      { CashCouponNo: 'Q-CCC', CashCouponId: 3, Balance: '9.00', NominalValue: '9.00', Status: 'Expired', ExpiryTime: at(-400), ApplicableProducts: '通用' },
      { CashCouponNo: 'Q-DDD', CashCouponId: 4, Balance: '7.00', NominalValue: '7.00', Status: 'Available', ExpiryTime: at(-1), ApplicableProducts: '通用' },
    ],
  },
};

const upstream = [];
globalThis.fetch = async (url, init) => {
  upstream.push({ url, init });
  return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
};

const plugin = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'lib', 'index.js')).href);
assert.equal(plugin.name, 'aliyun-coupon');

// 1) Config 默认值（顺带确认 role('credential-ref') 不会让解析炸掉）
let config = FALLBACK_CONFIG;
if (typeof plugin.Config?.parse === 'function') {
  config = { ...FALLBACK_CONFIG, ...plugin.Config.parse({}) };
  assert.equal(config.widget, true, 'widget 默认应为 true');
  assert.equal(config.onlyAvailable, true, 'onlyAvailable 默认应为 true');
  assert.equal(config.markdownName, '代金券余额.md');
}

const exec = {
  agent: { session: { header: { cwd: WORKSPACE } } },
  signal: new AbortController().signal,
  options: {},
  context: {},
};

// —— 已配置凭证的正常链路 ——
const wired = makeScope([
  ['ALIYUN_ACCESS_KEY_ID', 'LTAIprobekey0000abcd'],
  ['ALIYUN_ACCESS_KEY_SECRET', 'probe-secret-should-never-leak'],
]);
plugin.apply(wired.root, config);

assert.equal(wired.captured.tools.length, 1, '工具应注册成功（defineTool 与 register 都没抛错）');
assert.equal(wired.captured.tools[0].name, 'aliyun_coupon_balance');
assert.equal(
  wired.captured.routes.map((route) => route.path).sort().join(','),
  '/dsh-aliyun-coupon/credentials,/dsh-aliyun-coupon/refresh,/dsh-aliyun-coupon/state,/dsh-aliyun-coupon/widget.js',
);
assert.equal(wired.captured.taps.length, 1, '应挂上 tapIndex');

const injectRow = wired.captured.events.find(([event]) => event === 'webserver/index-inject');
assert.ok(injectRow, '应订阅 webserver/index-inject');
const table = [];
injectRow[1](table);
assert.equal(table.length, 1);
assert.match(table[0].text, /\/dsh-aliyun-coupon\/widget\.js/);
assert.match(table[0].text, /onerror/, '注入行必须吞掉加载失败，不能拖累宿主启动');
injectRow[1](table);
assert.equal(table.length, 1, '重复收集注入表时不应重复加行');

const html = wired.captured.taps[0]('<html><body><div id="dsh-app"></div></body></html>');
assert.match(html, /<script defer src="\/dsh-aliyun-coupon\/widget\.js"><\/script>/);
assert.equal(wired.captured.taps[0](html), html, 'tapIndex 要幂等');

const result = await wired.captured.tools[0].execute({ outputDir: OUTSIDE }, exec);
assert.equal(result.status, 'ok');
assert.equal(result.totalBalance, 149.9, '只合计可用且未过期的两张券');
assert.equal(result.countedCount, 2);
assert.equal(result.totalCount, 4);
assert.match(result.summary, /149\.90/, `摘要里要有余额数字：${result.summary}`);
assert.match(result.summary, /到期/, '摘要里要提醒即将到期');

assert.equal(result.markdownPath, path.join(OUTSIDE, '代金券余额.md'), '显式 outputDir 应生效');
const markdown = fs.readFileSync(result.markdownPath, 'utf8');
assert.match(markdown, /149\.90/);
assert.ok(markdown.includes('Q-AAA') && markdown.includes('过期'), '明细表要含每张券与状态');
const json = JSON.parse(fs.readFileSync(result.jsonPath, 'utf8'));
assert.equal(json.totalBalance, 149.9);
assert.equal(json.coupons.length, 4);
assert.ok(!JSON.stringify(json).includes('probe-secret'), '文件里不得出现密钥');

// —— 上游请求 ——
const request = upstream.at(-1);
assert.equal(request.init.method, 'POST');
assert.match(request.init.body, /^AccessKeyId=[^&]+&Action=QueryCashCoupons&/);
assert.match(request.init.body, /&Signature=[^&]+$/);
assert.match(request.init.body, /Timestamp=\d{4}-\d\d-\d\dT\d\d%3A\d\d%3A\d\dZ/);
assert.ok(!request.init.body.includes('probe-secret-should-never-leak'), 'Secret 绝不能进请求体');
assert.ok(!request.url.href.includes('probe-secret'), 'Secret 绝不能进 URL');
assert.equal(request.url.href, 'https://business.aliyuncs.com/');

// —— 缓存复用：refresh:false 不再打上游 ——
const before = upstream.length;
const cached = await wired.captured.tools[0].execute({ refresh: false }, exec);
assert.equal(cached.totalBalance, 149.9);
assert.equal(upstream.length, before, 'refresh:false 应走缓存');
assert.equal(cached.markdownPath, path.join(OUTSIDE, '代金券余额.md'));

// —— 未配置凭证：降级而不是抛错，且默认写到会话工作区 ——
const bare = makeScope([]);
plugin.apply(bare.root, config);
const idle = await bare.captured.tools[0].execute({}, exec);
assert.equal(idle.status, 'unconfigured', `缺凭证应报未配置，实际：${idle.summary}`);
assert.match(idle.summary, /AccessKey/);
assert.equal(idle.totalBalance, 0);

// —— 状态路由：不含密钥，只给掩码 ——
const stateRoute = wired.captured.routes.find((route) => route.path === '/dsh-aliyun-coupon/state');
let code = 0;
let body = '';
await stateRoute.handler(
  { method: 'GET', headers: { host: '127.0.0.1:19387' } },
  { writeHead: (status) => { code = status; }, end: (text) => { body = text; } },
);
assert.equal(code, 200);
const view = JSON.parse(body);
assert.equal(view.maskedAccessKeyId, 'LTAI****abcd');
assert.equal(view.totalBalance, 149.9);
assert.ok(!body.includes('probe-secret-should-never-leak'), '状态接口不得回显 Secret');
assert.equal(view.configured.accessKeyId, true);
assert.equal(view.configured.accessKeySecret, true);

// —— 跨站请求要挡掉 ——
code = 0; body = '';
await stateRoute.handler(
  { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } },
  { writeHead: (status) => { code = status; }, end: (text) => { body = text; } },
);
assert.equal(code, 403, '跨站请求应被拒');

// —— 挂件脚本路由 ——
code = 0; body = '';
wired.captured.routes
  .find((route) => route.path === '/dsh-aliyun-coupon/widget.js')
  .handler({ method: 'GET', headers: {} }, { writeHead: (status) => { code = status; }, end: (text) => { body = text; } });
assert.equal(code, 200);
assert.ok(body.includes('dac-card'), '应把挂件脚本原样发出去');
// 调整大小功能必须在真正发出去的脚本里（宿主按 mtime 从磁盘读，改挂件不用重启）
assert.ok(body.includes('dac-grip'), '挂件脚本应带缩放手把手');
assert.ok(body.includes('--dac-scale'), '缩放应通过 --dac-scale 变量应用');
assert.ok(body.includes('dsh-aliyun-coupon:scale'), '缩放倍率应持久化到 localStorage');
// 位置钳制：一律按 right/bottom 算，缩放后才不会被拖出窗口
assert.ok(body.includes('clampOffsets'), '位置应统一用 clampOffsets 钳制');
assert.ok(!body.includes('window.innerWidth - 220'), '不应再留下写死 220/80 的旧钳制');
// 卡片上不再显示"已写入 …"那行长路径
assert.ok(!body.includes('已写入'), '挂件不应再显示"已写入 …"');
// 自定义背景
assert.ok(body.includes('dsh-aliyun-coupon:bg'), '背景设置应持久化到 localStorage');
assert.ok(body.includes('data:image/'), '背景应只接受 data:image/* 与 http(s)');
assert.ok(body.includes('toDataURL'), '本地图片应压缩后再存，避免撑爆 localStorage');

// —— 通过挂件保存 AccessKey 后要立刻刷新 ——
const writeScope = makeScope([]);
plugin.apply(writeScope.root, config);
const credRoute = writeScope.captured.routes.find((route) => route.path === '/dsh-aliyun-coupon/credentials');

function fakeReq(payloadText, headers = {}) {
  const stream = new EventEmitter();
  stream.method = 'POST';
  stream.headers = { host: '127.0.0.1:19387', 'content-type': 'application/json', ...headers };
  stream.destroy = () => {};
  setImmediate(() => {
    if (payloadText) stream.emit('data', Buffer.from(payloadText, 'utf8'));
    stream.emit('end');
  });
  return stream;
}

code = 0; body = '';
await credRoute.handler(
  fakeReq(''),
  { writeHead: (status) => { code = status; }, end: (text) => { body = text; } },
);
assert.equal(code, 400, '没有字段时应拒绝');

code = 0; body = '';
await credRoute.handler(
  fakeReq(JSON.stringify({ accessKeyId: 'LTAIsavedkey0000wxyz', accessKeySecret: 'another-secret' })),
  { writeHead: (status) => { code = status; }, end: (text) => { body = text; } },
);
assert.equal(code, 200, `保存凭证后应刷新成功：${body}`);
const saved = JSON.parse(body);
assert.equal(saved.status, 'ok');
assert.equal(saved.totalBalance, 149.9);
assert.equal(saved.maskedAccessKeyId, 'LTAI****wxyz');
assert.ok(!body.includes('another-secret'), '响应里绝不能出现 Secret');

// —— 权限不足要翻成可执行的中文（今天真实遇到的 NotAuthorized）——
globalThis.fetch = async () => ({
  ok: false,
  status: 400,
  async text() {
    return JSON.stringify({ Code: 'NotAuthorized', Message: 'This API is not authorized for caller.', RequestId: 'PROBE-400' });
  },
});
let surfaced = '';
try {
  await wired.captured.tools[0].execute({}, exec);
} catch (error) {
  surfaced = String(error?.message ?? error);
}
assert.match(surfaced, /AliyunBSSReadOnlyAccess/, `工具该把 NotAuthorized 讲成下一步动作：${surfaced}`);
assert.match(surfaced, /PROBE-400/, 'RequestId 要留在消息里，方便提工单');

console.log('宿主半区探针通过：Config / 工具注册 / 路由 / 注入 / 签名 / 落盘 / 缓存 / 未配置降级 / 信任校验 都符合预期');
fs.rmSync(SCRATCH, { recursive: true, force: true });
