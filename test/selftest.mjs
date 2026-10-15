/**
 * 离线自测：不依赖 DSH 运行时，只检查纯逻辑层。
 * 运行：node test/selftest.mjs
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  ACTION,
  API_VERSION,
  buildSignedRequest,
  canonicalQuery,
  hintForCode,
  normalizeCoupons,
  percentEncode,
  renderJson,
  renderMarkdown,
  renderSummary,
  round2,
  toAmount,
  utcSeconds,
} from '../lib/core.js';

const hmac = (key, text) => crypto.createHmac('sha1', key).update(text, 'utf8').digest('base64');
let checks = 0;
const ok = (label) => {
  checks += 1;
  console.log(`  ✓ ${label}`);
};

// 1) percentEncode：阿里云的签名规则要求空格转 %20、* 转 %2A、~ 不转义。
assert.equal(percentEncode('2026-09-20T10:00:00Z'), '2026-09-20T10%3A00%3A00Z');
assert.equal(percentEncode('a b'), 'a%20b');
assert.equal(percentEncode('a*b'), 'a%2Ab');
assert.equal(percentEncode('a~b'), 'a~b');
assert.equal(percentEncode('/'), '%2F');
ok('percentEncode 规则');

// 2) 规范化查询串按 key 的 ASCII 升序。
assert.equal(canonicalQuery({ B: '2', A: '1', a: '3' }), 'A=1&B=2&a=3');
ok('canonicalQuery 排序');

// 3) Timestamp 不带毫秒。
assert.match(utcSeconds(new Date('2026-09-20T10:00:00.123Z')), /^2026-09-20T10:00:00Z$/);
ok('Timestamp 秒级 UTC');

// 4) 签名串结构：METHOD&%2F&<编码后的规范化串>，与官方 RPC v1 描述一致。
const signed = buildSignedRequest({
  accessKeyId: 'testid',
  accessKeySecret: 'testsecret',
  business: { EffectiveOrNot: 'true' },
  now: () => new Date('2026-09-20T10:00:00.000Z'),
  nonce: () => 'fixed-nonce',
  hmac,
});
assert.ok(signed.stringToSign.startsWith('POST&%2F&'));
assert.ok(signed.params.Action === ACTION);
assert.ok(signed.params.Version === API_VERSION);
assert.ok(signed.params.SignatureMethod === 'HMAC-SHA1');
assert.ok(!signed.stringToSign.includes('testsecret'), 'Secret 不能出现在待签串里');
// 手算一遍 HMAC 作为交叉验证。
const expected = hmac('testsecret&', signed.stringToSign);
assert.ok(signed.body.endsWith(`&Signature=${percentEncode(expected)}`));
ok('RPC v1 签名（HMAC-SHA1 + 密钥尾随 &）');

// 5) 归一化：只合计可用且未过期的券。
const payload = {
  Code: 'Success',
  Success: true,
  RequestId: 'REQ-1',
  Data: {
    CashCoupon: [
      { CashCouponNo: 'Q-A', Balance: '100.00', NominalValue: '100.00', Status: 'Available', ExpiryTime: '2030-01-01T00:00:00Z', ApplicableProducts: '通用' },
      { CashCouponNo: 'Q-B', Balance: '49.90', NominalValue: '50.00', Status: 'Available', ExpiryTime: '2030-06-01T00:00:00Z' },
      { CashCouponNo: 'Q-C', Balance: '9.00', NominalValue: '9.00', Status: 'Expired', ExpiryTime: '2020-01-01T00:00:00Z' },
      { CashCouponNo: 'Q-D', Balance: '7.00', NominalValue: '7.00', Status: 'Available', ExpiryTime: '2000-01-01T00:00:00Z' },
    ],
  },
};
const now = new Date('2026-09-20T10:00:00Z');
const snapshot = normalizeCoupons(payload, { onlyAvailable: true, now });
assert.equal(snapshot.totalBalance, 149.9);
assert.equal(snapshot.countedCount, 2);
assert.equal(snapshot.totalCount, 4);
assert.equal(snapshot.expiredCount, 1);
assert.equal(snapshot.coupons[0].no, 'Q-A', '按余额降序');
ok('只合计可用且未过期（含“状态 Available 但已过期”的排除）');

const all = normalizeCoupons(payload, { onlyAvailable: false, now });
assert.equal(all.totalBalance, 165.9);
assert.equal(all.countedCount, 4);
ok('口径可切换为全部');

// 6) 业务失败必须抛错并带上 RequestId。
assert.throws(
  () => normalizeCoupons({ Code: 'InvalidParameter', Message: 'x', RequestId: 'REQ-2' }, { now }),
  /REQ-2/,
);
ok('失败响应抛错');

// 7) 单张券（上游可能返回对象而不是数组）与脏金额。
const single = normalizeCoupons({ Code: 'Success', Data: { CashCoupon: { CashCouponNo: 'Q-S', Balance: '¥1,000.00', Status: 'Available' } } }, { now });
assert.equal(single.totalBalance, 1000);
assert.equal(toAmount('abc'), 0);
assert.equal(round2(1.005), 1.01);
ok('单对象响应与脏金额容错');

// 8) 30 天内到期提醒。
const soon = normalizeCoupons({
  Code: 'Success',
  Data: { CashCoupon: [{ CashCouponNo: 'Q-N', Balance: '10', Status: 'Available', ExpiryTime: '2026-10-05T00:00:00Z' }] },
}, { now });
assert.equal(soon.expiringSoon.length, 1);
assert.ok(soon.expiringSoon[0].daysLeft > 0 && soon.expiringSoon[0].daysLeft <= 30);
ok('到期提醒');

// 9) 报告渲染：数字要一眼可见，表格要有明细。
const markdown = renderMarkdown(snapshot, { pageUrl: 'https://billing-cost.console.aliyun.com/coupons/coupon' });
assert.ok(markdown.includes('149.90'), '合计出现在标题行');
assert.ok(markdown.includes('Q-A') && markdown.includes('100.00'));
assert.ok(markdown.includes('coupon-balance.json'));
const json = JSON.parse(renderJson(snapshot));
assert.equal(json.totalBalance, 149.9);
assert.equal(json.currency, 'CNY');
assert.equal(json.coupons.length, 4);
assert.ok(renderSummary(snapshot, { markdown: '/tmp/代金券余额.md' }).includes('/tmp/代金券余额.md'));
ok('Markdown / JSON / 摘要渲染');

// 10) 错误码要给出可执行的下一步，不能只丢一句英文。
assert.match(hintForCode('NotAuthorized'), /AliyunBSSReadOnlyAccess/);
assert.match(hintForCode('SignatureDoesNotMatch'), /Secret/);
assert.equal(hintForCode(''), '');
assert.equal(hintForCode('WhateverUnknown'), '');
assert.throws(
  () => normalizeCoupons({ Code: 'NotAuthorized', Message: 'This API is not authorized for caller.', RequestId: 'REQ-9' }, { now }),
  /AliyunBSSReadOnlyAccess/,
);
ok('错误码中文提示（NotAuthorized 等）');

console.log(`\n${checks} 项自测全部通过（${ACTION} @ ${API_VERSION}）`);
