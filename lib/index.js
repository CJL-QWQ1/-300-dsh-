/**
 * dsh-aliyun-coupon —— 宿主半区。
 *
 * 职责：
 * 1. 用 AccessKey 调阿里云官方 `BssOpenApi/QueryCashCoupons`（与「费用与成本 → 代金券」
 *    页面同源的数据），得到每张代金券的余额；
 * 2. 把可用余额合计写成两份文件：给人看的 `代金券余额.md` 与给程序读的
 *    `coupon-balance.json`；
 * 3. 通过 webServer 路由把快照喂给浏览器挂件，并在 index.html 注入挂件脚本；
 * 4. 注册模型可见工具 `aliyun_coupon_balance`，并可选定时自动刷新。
 *
 * 数据链路里唯一的密钥来源是 DSH credentials 服务（引用名可在配置里改），
 * 任何对外接口都只回传「是否已配置」与掩码后的 AccessKey ID。
 *
 * @module dsh-aliyun-coupon
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import {
  ACTION,
  API_VERSION,
  DEFAULT_ENDPOINT,
  buildSignedRequest,
  hintForCode,
  normalizeCoupons,
  renderJson,
  renderMarkdown,
  renderSummary,
} from './core.js';

/** Cordis 插件名（Loader 诊断里显示）。 */
export const name = 'aliyun-coupon';

/** 路由与注入用的统一前缀，避免和别的插件撞路径。 */
const ROUTE = '/dsh-aliyun-coupon';
/** 挂件脚本的包内位置。 */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_FILE = path.resolve(PACKAGE_DIR, '..', 'widget', 'aliyun-coupon-widget.js');
/** 控制台代金券页面，只作为报告里的出处标注。 */
const CONSOLE_PAGE = 'https://billing-cost.console.aliyun.com/coupons/coupon';
/** 上游请求超时。 */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * 宿主日志出口。DSH 没有 `ctx.logger` 这个注入名，插件统一走 stderr 前缀，
 * 这样 `dsh` 的宿主日志里能一眼分辨来源，且不会因为服务名变化而整体失败。
 * @param text - 一行消息。
 */
function warn(text) {
  try {
    console.warn(`[aliyun-coupon] ${text}`);
  } catch {
    // 日志出口本身坏掉时什么都不做。
  }
}

export const Config = z.object({
  accessKeyIdRef: z.string().role('credential-ref').default('ALIYUN_ACCESS_KEY_ID'),
  accessKeySecretRef: z.string().role('credential-ref').default('ALIYUN_ACCESS_KEY_SECRET'),
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  onlyAvailable: z.boolean().default(true),
  refreshMinutes: z.number().step(1).min(0).default(60),
  autoFetchOnStart: z.boolean().default(true),
  widget: z.boolean().default(true),
  allowCredentialWrite: z.boolean().default(true),
  outputDir: z.string().default(''),
  outputSubdir: z.string().default('aliyun-coupon'),
  markdownName: z.string().default('代金券余额.md'),
  jsonName: z.string().default('coupon-balance.json'),
});

/**
 * 挂载插件。分两段的原因与鲸鱼挂件一致：桌面端的 index 注入表只在宿主启动时收集一次，
 * 所以注入行的注册必须尽早发生，不能被服务就绪等待推迟。
 * @param root - 未收窄的 Cordis 上下文。
 * @param config - 已按 {@link Config} 校验过的配置。
 */
export function apply(root, config) {
  /** 最近一次快照与状态；挂件读的就是它。 */
  const live = {
    status: 'idle',
    snapshot: null,
    lastError: null,
    files: { markdown: '', json: '', dir: '' },
    updatedAt: '',
  };
  let refreshChain = Promise.resolve();

  root.effect(() => {
    if (!config.widget) return;
    root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return;
        for (const row of table) {
          if (!row) continue;
          const text = typeof row.text === 'string' ? row.text : '';
          if (row.kind === 'script-src' && row.src === `${ROUTE}/widget.js`) return;
          if (row.kind === 'script' && text.includes(`${ROUTE}/widget.js`)) return;
        }
        // 内联行而不是 script-src：页面解释器对 script-src 的加载失败会 reject 整个启动流程，
        // 而本插件是可选装可卸载的，路由在不在都不该影响宿主起不起来。
        table.push({
          kind: 'script',
          placement: 'body',
          text: `(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;`
            + `var s=document.createElement("script");s.src="${ROUTE}/widget.js";s.onerror=function(){};`
            + `d.appendChild(s)}catch(e){}})()`,
        });
      } catch {
        // 注入表结构变化时静默跳过：挂件是锦上添花，不能拖累宿主。
      }
    });
  });

  root.inject(['webServer', 'credentials', 'tools', 'timer', 'workspaceRegistry', 'connection'], (ctx) => {
    // —— 凭证 ——
    const readRef = (raw, fallback) => {
      const value = String(raw ?? '').trim() || fallback;
      return isCredentialRefName(value) ? credentialRef(value) : credentialRef(fallback);
    };

    async function resolveCreds() {
      const idRef = readRef(config.accessKeyIdRef, 'ALIYUN_ACCESS_KEY_ID');
      const secretRef = readRef(config.accessKeySecretRef, 'ALIYUN_ACCESS_KEY_SECRET');
      const [idRecord, secretRecord] = await Promise.all([
        ctx.credentials.resolve(idRef).catch(() => undefined),
        ctx.credentials.resolve(secretRef).catch(() => undefined),
      ]);
      return {
        idRef,
        secretRef,
        accessKeyId: idRecord?.value?.trim() || '',
        accessKeySecret: secretRecord?.value?.trim() || '',
      };
    }

    function mask(value) {
      const text = String(value ?? '');
      if (text.length <= 8) return text ? `${text.slice(0, 2)}****` : '';
      return `${text.slice(0, 4)}****${text.slice(-4)}`;
    }

    // —— 输出目录 ——
    function sessionCwd(exec) {
      try {
        const cwd = exec?.agent?.session?.header?.cwd;
        return typeof cwd === 'string' && cwd ? cwd : '';
      } catch {
        return '';
      }
    }

    function firstWorkspaceRoot() {
      try {
        const list = ctx.workspaceRegistry?.list?.() ?? [];
        const head = Array.isArray(list) ? list[0] : undefined;
        return typeof head?.path === 'string' ? head.path : '';
      } catch {
        return '';
      }
    }

    function resolveOutputDir({ exec, override } = {}) {
      const base = sessionCwd(exec) || firstWorkspaceRoot() || process.cwd();
      const raw = String(override || config.outputDir || '').trim();
      if (raw) return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
      return path.join(base, String(config.outputSubdir || 'aliyun-coupon').replace(/^[/\\]+/, ''));
    }

    async function writeFiles(snapshot, { exec, override } = {}) {
      const dir = resolveOutputDir({ exec, override });
      const mdPath = path.join(dir, String(config.markdownName || '代金券余额.md'));
      const jsonPath = path.join(dir, String(config.jsonName || 'coupon-balance.json'));
      await fsp.mkdir(dir, { recursive: true });
      const stamp = { pageUrl: CONSOLE_PAGE };
      await fsp.writeFile(mdPath, renderMarkdown(snapshot, stamp), 'utf8');
      live.files = { ...live.files, markdown: mdPath, dir };
      await fsp.writeFile(jsonPath, renderJson(snapshot, stamp), 'utf8');
      live.files = { ...live.files, json: jsonPath };
      return { markdown: mdPath, json: jsonPath };
    }

    // —— 上游调用 ——
    const hmacBase64 = (key, text) => crypto.createHmac('sha1', key).update(text, 'utf8').digest('base64');

    async function callAliyun(creds, { signal } = {}) {
      if (!creds.accessKeyId || !creds.accessKeySecret) {
        const error = new Error('尚未配置阿里云 AccessKey');
        error.kind = 'unconfigured';
        throw error;
      }
      const endpoint = String(config.endpoint || DEFAULT_ENDPOINT).trim();
      let url;
      try {
        url = new URL(endpoint);
      } catch {
        throw new Error(`endpoint 不是合法 URL：${endpoint}`);
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('endpoint 必须使用 http 或 https');
      }
      const signed = buildSignedRequest({
        accessKeyId: creds.accessKeyId,
        accessKeySecret: creds.accessKeySecret,
        action: ACTION,
        version: API_VERSION,
        hmac: hmacBase64,
      });
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          Accept: 'application/json',
        },
        body: signed.body,
        signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        const error = new Error(`阿里云返回非 JSON（HTTP ${response.status}）：${text.slice(0, 180)}`);
        error.kind = 'upstream';
        throw error;
      }
      if (!response.ok) {
        const hint = hintForCode(payload?.Code);
        const error = new Error(
          `HTTP ${response.status} Code=${payload?.Code ?? ''} Message=${payload?.Message ?? ''} RequestId=${payload?.RequestId ?? ''}`
            + (hint ? ` —— ${hint}` : ''),
        );
        error.kind = 'upstream';
        error.code = String(payload?.Code ?? '');
        throw error;
      }
      return payload;
    }

    /**
     * 拉取 + 归一化 + 写文件；并发调用串到同一条链上，避免两个刷新同时写同一份文件。
     * @param options - 单次刷新选项。
     * @returns 最近一次快照。
     */
    function refresh(options = {}) {
      const run = async () => {
        live.status = 'fetching';
        try {
          const creds = await resolveCreds();
          const payload = await callAliyun(creds, { signal: options.signal });
          const snapshot = normalizeCoupons(payload, {
            onlyAvailable: options.onlyAvailable ?? Boolean(config.onlyAvailable),
          });
          live.snapshot = snapshot;
          live.lastError = null;
          try {
            await writeFiles(snapshot, options);
          } catch (error) {
            live.lastError = {
              message: `写入文件失败：${error?.message ?? String(error)}`,
              at: new Date().toISOString(),
              kind: 'file',
            };
          }
          live.status = 'ok';
          live.updatedAt = new Date().toISOString();
          return snapshot;
        } catch (error) {
          const kind = error?.kind === 'unconfigured' ? 'unconfigured' : 'error';
          live.status = kind;
          live.updatedAt = new Date().toISOString();
          live.lastError = {
            message: String(error?.message ?? error),
            at: live.updatedAt,
            kind,
            code: error?.code ?? '',
          };
          if (kind === 'error') throw error;
          return live.snapshot;
        }
      };
      refreshChain = refreshChain.then(run, run);
      return refreshChain;
    }

    // —— 状态视图（挂件与工具共用） ——
    async function statusView() {
      const creds = await resolveCreds();
      const snapshot = live.snapshot;
      return {
        status: live.status,
        configured: {
          accessKeyId: creds.accessKeyId.length > 0,
          accessKeySecret: creds.accessKeySecret.length > 0,
        },
        credentialRefs: {
          accessKeyId: String(creds.idRef),
          accessKeySecret: String(creds.secretRef),
        },
        maskedAccessKeyId: mask(creds.accessKeyId),
        totalBalance: snapshot?.totalBalance ?? null,
        totalBalanceText: snapshot ? snapshot.totalBalance.toFixed(2) : '',
        countedCount: snapshot?.countedCount ?? 0,
        totalCount: snapshot?.totalCount ?? 0,
        expiringSoon: (snapshot?.expiringSoon ?? []).map((coupon) => ({
          no: coupon.no,
          balance: coupon.balance,
          daysLeft: coupon.daysLeft,
        })),
        coupons: (snapshot?.coupons ?? []).map((coupon) => ({
          no: coupon.no,
          balance: coupon.balance,
          nominal: coupon.nominal,
          status: coupon.status,
          expiryTime: coupon.expiryTime,
          daysLeft: coupon.daysLeft ?? null,
        })),
        fetchedAt: snapshot?.fetchedAt ?? '',
        requestId: snapshot?.requestId ?? '',
        updatedAt: live.updatedAt,
        lastError: live.lastError,
        files: live.files,
        config: {
          onlyAvailable: Boolean(config.onlyAvailable),
          refreshMinutes: config.refreshMinutes,
          endpoint: String(config.endpoint || DEFAULT_ENDPOINT),
          allowCredentialWrite: Boolean(config.allowCredentialWrite),
        },
        consolePage: CONSOLE_PAGE,
      };
    }

    // —— HTTP ——
    /**
     * 三层信任校验（挂件是同源浏览器请求，因此跨站的一律拒）：
     * ① 自己的轻量校验：`Sec-Fetch-Site: cross-site` 直接拒；带 `Origin` 时必须与 `Host` 同源；
     * ② 宿主栅栏存在就委托它（里面还有浏览器鉴权 401），语义原样使用；
     * ③ 宿主栅栏抛异常按拒绝处理（fail-closed）；方法不存在（老版本 DSH）时只靠 ①。
     * @param req - Node 请求对象。
     * @returns `0` 表示放行，否则是要回写的状态码。
     */
    function trustRejection(req) {
      const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase();
      if (site === 'cross-site') return 403;
      const origin = req.headers?.origin;
      if (origin) {
        try {
          if (new URL(origin).host.toLowerCase() !== String(req.headers?.host ?? '').toLowerCase()) return 403;
        } catch {
          return 403;
        }
      }
      const fence = ctx.connection?.requestRejection;
      if (typeof fence !== 'function') return 0;
      try {
        const code = fence.call(ctx.connection, req);
        if (code === undefined || code === null || code === false) return 0;
        return typeof code === 'number' ? code : 403;
      } catch (error) {
        warn(`宿主信任栅栏异常，已按拒绝处理：${error?.message ?? error}`);
        return 403;
      }
    }

    function send(res, code, body, type = 'application/json; charset=utf-8') {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    }

    function readBody(req, limit = 8192) {
      return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > limit) {
            reject(new Error('请求体过大'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    }

    let widgetCache = null;
    function widgetJs() {
      try {
        const stat = fs.statSync(WIDGET_FILE);
        if (widgetCache && widgetCache.mtimeMs === stat.mtimeMs) return widgetCache.text;
        const text = fs.readFileSync(WIDGET_FILE, 'utf8');
        widgetCache = { text, mtimeMs: stat.mtimeMs };
        return text;
      } catch {
        return widgetCache?.text ?? '';
      }
    }

    const routes = [
      {
        kind: 'exact',
        path: `${ROUTE}/widget.js`,
        handler: (req, res) => {
          send(res, 200, widgetJs(), 'application/javascript; charset=utf-8');
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE}/state`,
        handler: async (req, res) => {
          const rejected = trustRejection(req);
          if (rejected !== 0) return send(res, rejected, `{"error":"rejected","status":${rejected}}`);
          if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"error":"method"}');
          try {
            send(res, 200, JSON.stringify(await statusView()));
          } catch (error) {
            send(res, 500, `{"error":${JSON.stringify(String(error?.message ?? error))}}`);
          }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE}/refresh`,
        handler: async (req, res) => {
          const rejected = trustRejection(req);
          if (rejected !== 0) return send(res, rejected, `{"error":"rejected","status":${rejected}}`);
          if (req.method !== 'POST') return send(res, 405, '{"error":"method"}');
          try {
            await refresh();
            send(res, 200, JSON.stringify(await statusView()));
          } catch (error) {
            send(res, 502, JSON.stringify({
              error: String(error?.message ?? error),
              status: live.status,
            }));
          }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE}/credentials`,
        handler: async (req, res) => {
          if (!config.allowCredentialWrite) return send(res, 403, '{"error":"disabled"}');
          const rejected = trustRejection(req);
          if (rejected !== 0) return send(res, rejected, `{"error":"rejected","status":${rejected}}`);
          if (req.method !== 'POST') return send(res, 405, '{"error":"method"}');
          try {
            const body = JSON.parse((await readBody(req)) || '{}');
            const { idRef, secretRef } = await resolveCreds();
            const writes = [];
            for (const [ref, value] of [
              [idRef, body?.accessKeyId],
              [secretRef, body?.accessKeySecret],
            ]) {
              if (typeof value !== 'string') continue;
              const trimmed = value.trim();
              writes.push(trimmed.length === 0
                ? ctx.credentials.unset(ref)
                : ctx.credentials.set(ref, trimmed));
            }
            if (writes.length === 0) return send(res, 400, '{"error":"no fields"}');
            await Promise.all(writes);
            await refresh();
            send(res, 200, JSON.stringify(await statusView()));
          } catch (error) {
            send(res, 400, JSON.stringify({ error: String(error?.message ?? error) }));
          }
        },
      },
    ];

    const disposers = [];
    for (const route of routes) {
      try {
        disposers.push(ctx.webServer.register(route));
      } catch (error) {
        warn(`aliyun-coupon: 路由 ${route.path} 注册失败：${error?.message ?? error}`);
      }
    }

    if (config.widget) {
      try {
        disposers.push(ctx.webServer.tapIndex((html) => {
          if (typeof html !== 'string' || html.includes(`${ROUTE}/widget.js`)) return html;
          const tag = `<script defer src="${ROUTE}/widget.js"></script>`;
          return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : `${html}${tag}`;
        }));
      } catch (error) {
        warn(`aliyun-coupon: index 注入失败：${error?.message ?? error}`);
      }
    }

    // —— 模型可见工具 ——
    try {
      disposers.push(ctx.tools.register(defineTool({
      name: 'aliyun_coupon_balance',
      timeoutMs: FETCH_TIMEOUT_MS + 10_000,
      description: '查询阿里云代金券余额（官方 BssOpenApi QueryCashCoupons，与费用与成本控制台同源），并把余额写入工作区文件 aliyun-coupon/代金券余额.md 与 coupon-balance.json。用户问代金券、优惠券余额或阿里云账户赠送额度时使用。',
      parameters: {
        refresh: {
          type: 'boolean',
          description: '默认 true：重新调用接口并覆盖写文件。false：只返回已有快照（没有快照时会先拉取）。',
        },
        outputDir: {
          type: 'string',
          description: '可选：覆盖输出目录。绝对路径直接用；相对路径基于当前会话工作区。',
        },
        onlyAvailable: {
          type: 'boolean',
          description: '可选：覆盖统计口径。true 只合计可用且未过期的券，false 合计全部券的余额。',
        },
      },
      output: {
        schema: {
          type: 'object',
          // dsh-tools 的值 schema DSL 要求对象根显式声明 openness，且 required 写在每个属性上。
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, enum: ['ok', 'unconfigured', 'error'], description: '本次调用的结果状态' },
            summary: { type: 'string', required: true, description: '多行中文摘要，直接可读' },
            totalBalance: { type: 'number', required: true, description: '按口径合计的代金券可用余额（元）' },
            countedCount: { type: 'integer', required: true, description: '计入合计的券张数' },
            totalCount: { type: 'integer', required: true, description: '接口返回的券总张数' },
            fetchedAt: { type: 'string', required: true, description: '快照时间（ISO）' },
            markdownPath: { type: 'string', required: true, description: 'Markdown 报告路径；未写入时为空串' },
            jsonPath: { type: 'string', required: true, description: 'JSON 快照路径；未写入时为空串' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const shouldFetch = args.refresh !== false || live.snapshot === null;
        let snapshot = live.snapshot;
        if (shouldFetch) {
          snapshot = await refresh({
            exec,
            override: args.outputDir,
            onlyAvailable: args.onlyAvailable,
          });
        } else if (!live.files.markdown && snapshot) {
          await writeFiles(snapshot, { exec, override: args.outputDir });
        }
        if (!snapshot) {
          const status = await statusView();
          return {
            status: live.status === 'unconfigured' ? 'unconfigured' : 'error',
            summary: `没有可用快照：${status.lastError?.message ?? '未配置 AccessKey'}`,
            totalBalance: 0,
            countedCount: 0,
            totalCount: 0,
            fetchedAt: '',
            markdownPath: '',
            jsonPath: '',
          };
        }
        return {
          status: live.status === 'ok' ? 'ok' : live.status === 'unconfigured' ? 'unconfigured' : 'error',
          totalBalance: snapshot.totalBalance,
          countedCount: snapshot.countedCount,
          totalCount: snapshot.totalCount,
          fetchedAt: snapshot.fetchedAt,
          markdownPath: live.files.markdown,
          jsonPath: live.files.json,
          summary: renderSummary(snapshot, live.files),
        };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '阿里云代金券余额',
        rawInput: args.outputDir ?? (args.refresh === false ? '用缓存' : '刷新'),
      }),
    })));
    } catch (error) {
      warn(`工具注册失败：${error?.message ?? error}`);
    }

    // —— 定时刷新 ——
    if (config.refreshMinutes > 0) {
      disposers.push(ctx.timer.interval(() => {
        refresh().catch((error) => {
          warn(`aliyun-coupon: 定时刷新失败：${error?.message ?? error}`);
        });
      }, config.refreshMinutes * 60_000));
    }
    if (config.autoFetchOnStart) {
      disposers.push(ctx.timer.timeout(() => {
        refresh().catch((error) => {
          if (error?.kind !== 'unconfigured') {
            warn(`aliyun-coupon: 启动刷新失败：${error?.message ?? error}`);
          }
        });
      }, 3_000));
    }

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          // 清理失败不影响别的注册项。
        }
      }
    });
  });
}
