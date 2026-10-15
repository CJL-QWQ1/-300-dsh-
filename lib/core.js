/**
 * 纯逻辑层：阿里云 RPC 签名、代金券响应归一化、报告渲染。
 * 只依赖 Node 内置模块，方便脱离 DSH 运行时单独自测（见 test/selftest.mjs）。
 * @module dsh-aliyun-coupon/core
 */

/** BssOpenApi 版本（中国站与国际站共用）。 */
export const API_VERSION = '2017-12-14';
/** 代金券列表接口。返回每张代金券的面额与余额。 */
export const ACTION = 'QueryCashCoupons';
/** 默认接入点：中国站。国际站用 https://business.ap-southeast-1.aliyuncs.com/ 。 */
export const DEFAULT_ENDPOINT = 'https://business.aliyuncs.com/';

/**
 * 阿里云 RPC 风格的百分号编码：在 `encodeURIComponent` 之上补齐 RFC3986 与
 * 阿里云签名的差异（`!` `(` `)` `*` 必须编码，`~` 必须还原，空格用 `%20`）。
 * @param value - 待编码的键或值。
 * @returns 编码结果。
 */
export function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, '%21')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/**
 * 按 key 的 ASCII 升序拼成 `k1=v1&k2=v2`（值已 percentEncode）。
 * @param params - 扁平参数表（值必须是标量）。
 * @returns 规范化查询串。
 */
export function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
}

/**
 * 生成一次 RPC 请求的签名串。
 *
 * 算法是阿里云 OpenAPI 的 RPC v1 签名：
 * `StringToSign = METHOD&percentEncode("/")&percentEncode(canonicalQuery)`，
 * `Signature = base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))`。
 * @param input - 签名输入。
 * @param input.accessKeyId - AccessKey ID。
 * @param input.accessKeySecret - AccessKey Secret（只参与密钥派生，不进请求）。
 * @param input.action - 接口名，默认 {@link ACTION}。
 * @param input.version - API 版本，默认 {@link API_VERSION}。
 * @param input.business - 业务参数（如 `EffectiveOrNot`）。
 * @param input.method - HTTP 方法，默认 `POST`。
 * @param input.now - 时间戳来源，便于测试注入。
 * @param input.nonce - 随机串来源，便于测试注入。
 * @param input.hmac - `(key, text) => base64` 的同步 HMAC-SHA1 实现；core 层刻意不
 * 直接依赖 `node:crypto`，这样同一份逻辑可以被任何宿主注入实现后单独测试。
 * @returns `{ body, params, stringToSign }`；`body` 是可直接发送的表单串。
 */
export function buildSignedRequest({
  accessKeyId,
  accessKeySecret,
  action = ACTION,
  version = API_VERSION,
  business = {},
  method = 'POST',
  now = () => new Date(),
  nonce = () => randomNonce(),
  hmac,
}) {
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('缺少 AccessKey ID 或 AccessKey Secret');
  }
  if (typeof hmac !== 'function') {
    throw new Error('需要 hmac(key, text) => base64 的同步实现');
  }
  const params = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: nonce(),
    Timestamp: utcSeconds(now()),
    Action: action,
    ...business,
  };
  const canonical = canonicalQuery(params);
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = hmac(`${accessKeySecret}&`, stringToSign);
  return {
    body: `${canonical}&Signature=${percentEncode(signature)}`,
    params,
    stringToSign,
  };
}

/**
 * 时间戳：`yyyy-MM-dd'T'HH:mm:ss'Z'`（UTC，秒级；阿里云不接受毫秒）。
 * @param date - 时间点。
 * @returns 时间戳串。
 */
export function utcSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function randomNonce() {
  return globalThis.crypto?.randomUUID?.() ?? fallbackNonce();
}

function fallbackNonce() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 把金额安全地转成数字。`"100.00"`、`"¥1,234.56"`、`100` 都能读。
 * @param value - 原始金额。
 * @returns 数字；无法解析时 0。
 */
export function toAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const cleaned = value.replace(/[^\d.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

/**
 * 保留两位小数（金额显示口径）。
 * @param value - 原始数字。
 * @returns 两位小数的数字。
 */
export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * 常见错误码的下一步动作。上游只给一句英文，容易在这里干等，
 * 所以把官方文档里的语义翻成可执行的一句话。
 * @param code - 阿里云返回的 `Code`。
 * @returns 中文提示；不认识的码返回空串。
 */
export function hintForCode(code) {
  const key = String(code ?? '').trim();
  const hints = {
    NotAuthorized: '这个 AccessKey 所属身份没有调用代金券接口的权限：给该 RAM 用户挂 AliyunBSSReadOnlyAccess（含 bss:DescribeCoupons），等一两分钟再刷新',
    NotApplicable: '这个身份不适用该接口：常见于用成员账号/财务非结算账号的 AccessKey，请改用出账主账号（或其有费用只读权限的 RAM 用户）的 AccessKey',
    InvalidOwner: 'AccessKey 所属账号与代金券所在账号不一致',
    InvalidAccessKeyId: 'AccessKey ID 无效：检查是否粘贴完整、是否已在控制台禁用',
    SignatureDoesNotMatch: '签名不匹配：AccessKey Secret 大概率填错或含多余空格，重新录入一次',
    Forbidden: '被拒绝：多为 RAM 权限或管控策略限制，需要费用中心只读权限',
    Throttling: '触发限流（该接口每账号 10 次/秒）：稍后再刷新',
    IncompleteAccountInfo: '账号信息不完整：需要先在费用中心补齐企业/个人实名与账务信息',
  };
  return hints[key] ?? '';
}

/**
 * 把 `QueryCashCoupons` 的响应归一化成内部快照。
 * @param payload - 阿里云返回的 JSON。
 * @param options - 统计口径。
 * @param options.onlyAvailable - 只在「可用状态」的券上求和。
 * @param options.now - 判定过期的时间点。
 * @returns 快照对象。
 * @throws 当上游返回业务失败时抛出带 RequestId 的错误。
 */
export function normalizeCoupons(payload, { onlyAvailable = true, now = new Date() } = {}) {
  const code = String(payload?.Code ?? '');
  const failed = payload?.Success === false
    || (code.length > 0 && code !== 'Success' && code !== '200');
  if (failed) {
    const hint = hintForCode(code);
    const error = new Error(
      `阿里云返回失败：Code=${code || '(空)'} Message=${payload?.Message ?? '(无)'} RequestId=${payload?.RequestId ?? '(无)'}`
        + (hint ? ` —— ${hint}` : ''),
    );
    error.requestId = payload?.RequestId;
    error.code = code;
    throw error;
  }
  const rawList = payload?.Data?.CashCoupon;
  const list = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
  const coupons = list.map((item) => {
    const status = String(item?.Status ?? '').trim();
    const expiryTime = String(item?.ExpiryTime ?? '').trim();
    const expiryDate = expiryTime ? new Date(expiryTime) : undefined;
    return {
      id: item?.CashCouponId === undefined ? '' : String(item.CashCouponId),
      no: String(item?.CashCouponNo ?? ''),
      nominal: round2(toAmount(item?.NominalValue)),
      balance: round2(toAmount(item?.Balance)),
      status,
      effectiveTime: String(item?.EffectiveTime ?? ''),
      expiryTime,
      expiryMs: expiryDate && Number.isFinite(expiryDate.getTime()) ? expiryDate.getTime() : undefined,
      products: String(item?.ApplicableProducts ?? ''),
      scenarios: String(item?.ApplicableScenarios ?? ''),
      description: String(item?.Description ?? ''),
    };
  });

  const usable = (coupon) => coupon.status === 'Available'
    && (coupon.expiryMs === undefined || coupon.expiryMs > now.getTime());
  const counted = onlyAvailable ? coupons.filter(usable) : coupons;

  const daysUntil = (coupon) => (coupon.expiryMs === undefined
    ? undefined
    : Math.ceil((coupon.expiryMs - now.getTime()) / 86_400_000));

  return {
    fetchedAt: now.toISOString(),
    requestId: payload?.RequestId ? String(payload.RequestId) : '',
    source: `BssOpenApi ${ACTION}`,
    onlyAvailable,
    totalBalance: round2(counted.reduce((sum, coupon) => sum + coupon.balance, 0)),
    totalNominal: round2(counted.reduce((sum, coupon) => sum + coupon.nominal, 0)),
    countedCount: counted.length,
    totalCount: coupons.length,
    availableCount: coupons.filter((coupon) => coupon.status === 'Available').length,
    expiredCount: coupons.filter((coupon) => coupon.status === 'Expired').length,
    cancelledCount: coupons.filter((coupon) => coupon.status === 'Cancelled').length,
    expiringSoon: counted
      .filter((coupon) => {
        const days = daysUntil(coupon);
        return days !== undefined && days <= 30 && coupon.balance > 0;
      })
      .map((coupon) => ({ ...coupon, daysLeft: daysUntil(coupon) })),
    coupons: coupons
      .map((coupon) => ({ ...coupon, daysLeft: daysUntil(coupon) }))
      .sort((left, right) => right.balance - left.balance),
  };
}

const STATUS_TEXT = {
  Available: '可用',
  Expired: '已过期',
  Cancelled: '已作废',
};

/**
 * 渲染给人在 DSH 文件面板里看的 Markdown 报告。
 * @param snapshot - {@link normalizeCoupons} 的结果。
 * @param options - 渲染选项。
 * @param options.pageUrl - 原始控制台页面地址，写进「数据来源」脚注。
 * @returns Markdown 文本（以换行结尾）。
 */
export function renderMarkdown(snapshot, { pageUrl = '' } = {}) {
  const local = formatLocal(snapshot.fetchedAt);
  const lines = [];
  lines.push('# 阿里云代金券余额');
  lines.push('');
  lines.push(`**可用余额合计：¥ ${snapshot.totalBalance.toFixed(2)}**`);
  lines.push('');
  lines.push(`- 更新时间：${local}`);
  lines.push(`- 统计口径：${snapshot.onlyAvailable ? '仅“可用且未过期”的代金券' : '全部代金券'}（计入 ${snapshot.countedCount} / 共 ${snapshot.totalCount} 张）`);
  lines.push(`- 状态分布：可用 ${snapshot.availableCount}、过期 ${snapshot.expiredCount}、作废 ${snapshot.cancelledCount}`);
  lines.push(`- 数据来源：${snapshot.source}${snapshot.requestId ? `（RequestId ${snapshot.requestId}）` : ''}`);
  if (pageUrl) lines.push(`- 对应页面：${pageUrl}`);
  lines.push('');
  if (snapshot.expiringSoon.length > 0) {
    lines.push(`> ⚠️ 30 天内到期且仍有余额：${snapshot.expiringSoon
      .map((coupon) => `${coupon.no || coupon.id}（¥ ${coupon.balance.toFixed(2)}，${coupon.daysLeft} 天）`)
      .join('、')}`);
    lines.push('');
  }
  if (snapshot.coupons.length === 0) {
    lines.push('（这个账号当前没有代金券记录）');
  } else {
    lines.push('| 代金券 | 面额 | 余额 | 状态 | 过期时间 | 剩余 | 适用产品 |');
    lines.push('| --- | --: | --: | :--: | :--: | --: | --- |');
    for (const coupon of snapshot.coupons) {
      lines.push(`| ${md(coupon.no || coupon.id)} | ${coupon.nominal.toFixed(2)} | **${coupon.balance.toFixed(2)}** | ${STATUS_TEXT[coupon.status] ?? md(coupon.status)} | ${md(coupon.expiryTime || '-')} | ${coupon.daysLeft === undefined ? '-' : coupon.daysLeft} | ${md(coupon.products || '-')} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('本文件由 DSH 插件 `dsh-aliyun-coupon` 自动生成，请勿手改（下次刷新会覆盖）。');
  lines.push('机器可读版本见同目录 `coupon-balance.json`。');
  lines.push('');
  return lines.join('\n');
}

/**
 * 渲染机器可读 JSON。
 * @param snapshot - 快照。
 * @param options - 选项。
 * @param options.pageUrl - 原始页面地址。
 * @returns 带缩进的 JSON 文本。
 */
export function renderJson(snapshot, { pageUrl = '' } = {}) {
  return `${JSON.stringify({
    plugin: 'dsh-aliyun-coupon',
    schema: 1,
    pageUrl,
    totalBalance: snapshot.totalBalance,
    totalBalanceText: snapshot.totalBalance.toFixed(2),
    currency: 'CNY',
    onlyAvailable: snapshot.onlyAvailable,
    countedCount: snapshot.countedCount,
    totalCount: snapshot.totalCount,
    availableCount: snapshot.availableCount,
    expiredCount: snapshot.expiredCount,
    cancelledCount: snapshot.cancelledCount,
    requestId: snapshot.requestId,
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    coupons: snapshot.coupons.map((coupon) => ({
      no: coupon.no,
      id: coupon.id,
      nominal: coupon.nominal,
      balance: coupon.balance,
      status: coupon.status,
      effectiveTime: coupon.effectiveTime,
      expiryTime: coupon.expiryTime,
      daysLeft: coupon.daysLeft ?? null,
      applicableProducts: coupon.products,
      applicableScenarios: coupon.scenarios,
      description: coupon.description,
    })),
  }, null, 2)}\n`;
}

/**
 * 给模型/终端用的一行摘要。
 * @param snapshot - 快照。
 * @param files - 已写入的文件路径。
 * @returns 多行纯文本。
 */
export function renderSummary(snapshot, files) {
  const lines = [
    `阿里云代金券可用余额：¥ ${snapshot.totalBalance.toFixed(2)}`,
    `口径：${snapshot.onlyAvailable ? '仅可用且未过期' : '全部'}；计入 ${snapshot.countedCount}/${snapshot.totalCount} 张；更新 ${formatLocal(snapshot.fetchedAt)}`,
  ];
  if (snapshot.expiringSoon.length > 0) {
    // 到期提醒放进摘要，模型不用展开文件就能提醒用户。
    const detail = snapshot.expiringSoon
      .map((coupon) => `${coupon.no} ¥${coupon.balance.toFixed(2)}（剩 ${coupon.daysLeft} 天）`)
      .join('；');
    lines.push(`⚠️ 30 天内到期且仍有余额 ${snapshot.expiringSoon.length} 张：${detail}`);
  }
  for (const [key, value] of Object.entries(files ?? {})) {
    if (value) lines.push(`已写入 ${key}：${value}`);
  }
  return lines.join('\n');
}

function formatLocal(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(date);
  } catch {
    return iso;
  }
}

function md(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
