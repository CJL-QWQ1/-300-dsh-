/*
 * dsh-aliyun-coupon 挂件（浏览器半区）。
 *
 * 由插件的宿主半区在 /dsh-aliyun-coupon/widget.js 提供，并通过 index 注入到 DSH 页面。
 * 这里刻意只用普通 JS 与浏览器全局：不依赖 React、不依赖模块表，路由不在就静默不出现，
 * 绝不影响宿主页面启动。
 */
(function () {
  'use strict';

  var PREFIX = '/dsh-aliyun-coupon';
  var STATE_URL = PREFIX + '/state';   // 文档相对形式，兼容子路径部署
  var STYLE_ID = 'dsh-aliyun-coupon-style';
  var ROOT_ID = 'dsh-aliyun-coupon-root';
  var POS_KEY = 'dsh-aliyun-coupon:pos';
  var HIDDEN_KEY = 'dsh-aliyun-coupon:hidden';
  var POLL_MS = 60000;

  if (window.__dshAliyunCouponMounted) return;
  window.__dshAliyunCouponMounted = true;

  var state = { data: null, busy: false, error: '', detail: false, collapsed: false };

  // —— 样式：只用 DSH 主题令牌，浅色/深色都跟手 ——
  var CSS = [
    '.dac-card{position:fixed;z-index:2147482000;right:16px;bottom:96px;min-width:196px;max-width:280px;',
    'display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:12px;',
    'background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);',
    'box-shadow:0 6px 22px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary);',
    'font:12px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    'user-select:none;touch-action:none}',
    '.dac-head{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:grab}',
    '.dac-title{font-size:11px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}',
    '.dac-num{font-size:20px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}',
    '.dac-num.dac-warn{color:var(--dsw-alias-state-warn-primary)}',
    '.dac-num.dac-err{color:var(--dsw-alias-state-error-primary);font-size:13px;font-weight:500}',
    '.dac-sub{color:var(--dsw-alias-label-secondary);font-size:11px}',
    '.dac-exp{color:var(--dsw-alias-state-warn-primary);font-size:11px}',
    '.dac-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}',
    '.dac-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l2);background:transparent;',
    'color:var(--dsw-alias-label-secondary);border-radius:7px;padding:3px 8px;font:inherit;cursor:pointer}',
    '.dac-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
    '.dac-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
    '.dac-dot.ok{background:var(--dsw-alias-state-success-primary)}',
    '.dac-dot.fetching{background:var(--dsw-alias-brand-primary)}',
    '.dac-dot.unconfigured{background:var(--dsw-alias-state-warn-primary)}',
    '.dac-dot.error{background:var(--dsw-alias-state-error-primary)}',
    '.dac-list{display:flex;flex-direction:column;gap:3px;margin-top:4px;max-height:180px;overflow:auto}',
    '.dac-item{display:flex;justify-content:space-between;gap:8px;font-size:11px;',
    'color:var(--dsw-alias-label-secondary)}',
    '.dac-item b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}',
    '.dac-form{display:flex;flex-direction:column;gap:6px;margin-top:4px}',
    '.dac-input{font:inherit;padding:4px 6px;border-radius:7px;color:var(--dsw-alias-label-primary);',
    'background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);min-width:0}',
    '.dac-mini{font-size:10px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}',
    '.dac-restore{position:fixed;z-index:2147482000;right:10px;bottom:10px;width:26px;height:26px;',
    'border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;',
    'background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);',
    'color:var(--dsw-alias-label-secondary);font:600 11px system-ui}',
  ].join('');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  function money(value) {
    var num = Number(value);
    return Number.isFinite(num) ? num.toFixed(2) : '--';
  }

  function shortTime(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function request(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}))
      .then(function (response) {
        if (!response.ok) {
          return response.text().then(function (text) {
            var message = text;
            try { message = JSON.parse(text).error || text; } catch (e) {}
            throw new Error('HTTP ' + response.status + (message ? '：' + message : ''));
          });
        }
        return response.json();
      });
  }

  function load() {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    return request(STATE_URL)
      .then(function (data) { state.data = data; state.error = ''; })
      .catch(function (error) { state.error = String(error && error.message || error); })
      .then(function () { state.busy = false; render(); });
  }

  function refresh() {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    render();
    return request(PREFIX + '/refresh', { method: 'POST' })
      .then(function (data) { state.data = data; state.error = ''; })
      .catch(function (error) {
        state.error = String(error && error.message || error);
        return load();
      })
      .then(function () { state.busy = false; render(); });
  }

  function saveKeys(idInput, secretInput, button) {
    var payload = {};
    if (idInput.value.trim()) payload.accessKeyId = idInput.value.trim();
    if (secretInput.value.trim()) payload.accessKeySecret = secretInput.value.trim();
    if (!payload.accessKeyId && !payload.accessKeySecret) return;
    button.disabled = true;
    button.textContent = '保存中…';
    request(PREFIX + '/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (data) {
      state.data = data;
      state.error = '';
      state.forceSetup = false;
      load();
    }).catch(function (error) {
      state.error = String(error && error.message || error);
      button.disabled = false;
      button.textContent = '保存并刷新';
      render();
    });
  }

  // —— 渲染 ——
  function buildCard() {
    var card = el('div', 'dac-card');
    card.id = ROOT_ID;
    attachDrag(card);
    return card;
  }

  function renderInto(card) {
    clear(card);
    var data = state.data;
    var status = data ? data.status : (state.error ? 'error' : 'idle');
    var configured = data && data.configured;

    var head = el('div', 'dac-head');
    var dot = el('span', 'dac-dot ' + status);
    dot.title = status;
    head.appendChild(el('span', 'dac-title', '阿里云代金券'));
    head.appendChild(dot);
    card.appendChild(head);

    if (state.busy) {
      card.appendChild(el('div', 'dac-num dac-err', '读取中…'));
    } else if (state.forceSetup || status === 'unconfigured' || (configured && !(configured.accessKeyId && configured.accessKeySecret))) {
      renderSetup(card, data);
    } else if (data && data.totalBalance !== null && data.totalBalance !== undefined) {
      var expiring = (data.expiringSoon || []).length;
      var num = el('div', 'dac-num' + (expiring > 0 ? ' dac-warn' : ''), '¥ ' + money(data.totalBalance));
      card.appendChild(num);
      card.appendChild(el('div', 'dac-sub', (data.countedCount || 0) + ' 张可用 · 共 ' + (data.totalCount || 0) + ' 张 · ' + shortTime(data.fetchedAt)));
      if (expiring > 0) {
        var first = data.expiringSoon[0];
        card.appendChild(el('div', 'dac-exp', '⚠ ' + expiring + ' 张 30 天内到期（最近 ' + (first.daysLeft || 0) + ' 天）'));
      }
      // 有旧快照但这次刷新失败：数字照旧显示，下面补一行失败原因，避免用户以为还是新数据。
      if (status === 'error' && data.lastError) {
        card.appendChild(el('div', 'dac-exp', '本次刷新失败：' + String(data.lastError.message || '')));
      }
    } else if (state.error) {
      card.appendChild(el('div', 'dac-num dac-err', '读取失败'));
      card.appendChild(el('div', 'dac-sub', state.error));
    } else if (data && data.lastError) {
      card.appendChild(el('div', 'dac-num dac-err', '拉取失败'));
      card.appendChild(el('div', 'dac-sub', String(data.lastError.message || '')));
    } else {
      card.appendChild(el('div', 'dac-num dac-err', '还没有数据'));
      card.appendChild(el('div', 'dac-sub', data && data.status === 'fetching' ? '正在拉取…' : '点刷新试试'));
    }

    // 明细
    if (state.detail && data && data.coupons && data.coupons.length) {
      var list = el('div', 'dac-list');
      data.coupons.forEach(function (coupon) {
        var item = el('div', 'dac-item');
        var label = coupon.no || coupon.id || '（无编号）';
        item.appendChild(el('span', null, label.slice(0, 18) + ' · ' + statusText(coupon.status)));
        item.appendChild(el('b', null, '¥ ' + money(coupon.balance)));
        list.appendChild(item);
      });
      card.appendChild(list);
    }

    // 文件位置
    if (data && data.files && data.files.markdown) {
      card.appendChild(el('div', 'dac-mini', '已写入 ' + data.files.markdown));
    }

    // 按钮
    var row = el('div', 'dac-row');
    var refreshBtn = el('button', 'dac-btn', state.busy ? '…' : '刷新');
    refreshBtn.addEventListener('click', function () { refresh(); });
    row.appendChild(refreshBtn);

    var detailBtn = el('button', 'dac-btn', state.detail ? '收起' : '明细');
    detailBtn.addEventListener('click', function () { state.detail = !state.detail; render(); });
    row.appendChild(detailBtn);

    if (data && data.config && data.config.allowCredentialWrite) {
      var editBtn = el('button', 'dac-btn', '改 Key');
      editBtn.addEventListener('click', function () { state.forceSetup = true; render(); });
      row.appendChild(editBtn);
    }

    var hideBtn = el('button', 'dac-btn', '隐藏');
    hideBtn.addEventListener('click', function () {
      try { localStorage.setItem(HIDDEN_KEY, '1'); } catch (e) {}
      state.hidden = true;
      render();
    });
    row.appendChild(hideBtn);

    card.appendChild(row);
  }

  function statusText(status) {
    return status === 'Available' ? '可用' : status === 'Expired' ? '已过期' : status === 'Cancelled' ? '已作废' : (status || '');
  }

  function renderSetup(card, data) {
    card.appendChild(el('div', 'dac-num dac-err', '未配置 AccessKey'));
    card.appendChild(el('div', 'dac-sub', '填入阿里云 AccessKey（建议只用“费用中心只读”权限的 RAM 子账号）'));
    var form = el('div', 'dac-form');
    var idInput = el('input', 'dac-input');
    idInput.placeholder = 'AccessKey ID';
    idInput.type = 'text';
    idInput.autocomplete = 'off';
    var secretInput = el('input', 'dac-input');
    secretInput.placeholder = 'AccessKey Secret';
    secretInput.type = 'password';
    secretInput.autocomplete = 'off';
    var button = el('button', 'dac-btn', '保存并刷新');
    button.addEventListener('click', function () { saveKeys(idInput, secretInput, button); });
    form.appendChild(idInput);
    form.appendChild(secretInput);
    form.appendChild(button);
    card.appendChild(form);
    var submit = function (event) {
      if (event.key === 'Enter') { event.preventDefault(); saveKeys(idInput, secretInput, button); }
    };
    idInput.addEventListener('keydown', submit);
    secretInput.addEventListener('keydown', submit);
    if (state.forceSetup) {
      var cancelRow = el('div', 'dac-row');
      var cancel = el('button', 'dac-btn', '取消');
      cancel.addEventListener('click', function () { state.forceSetup = false; render(); });
      cancelRow.appendChild(cancel);
      card.appendChild(cancelRow);
    }
    var refs = data && data.credentialRefs;
    card.appendChild(el('div', 'dac-mini', refs
      ? '存入 DSH 凭证：' + refs.accessKeyId + ' / ' + refs.accessKeySecret
      : '存入 DSH 凭证服务'));
  }

  function attachDrag(card) {
    var drag = null;
    card.addEventListener('pointerdown', function (event) {
      if (event.target !== card && !/dac-head/.test(String(event.target.className))) return;
      if (event.button !== 0) return;
      var rect = card.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      card.setPointerCapture(event.pointerId);
    });
    card.addEventListener('pointermove', function (event) {
      if (!drag) return;
      var left = drag.left + (event.clientX - drag.x);
      var top = drag.top + (event.clientY - drag.y);
      left = Math.max(4, Math.min(left, window.innerWidth - card.offsetWidth - 4));
      top = Math.max(4, Math.min(top, window.innerHeight - card.offsetHeight - 4));
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      card.style.right = 'auto';
      card.style.bottom = 'auto';
    });
    card.addEventListener('pointerup', function (event) {
      if (!drag) return;
      drag = null;
      try { card.releasePointerCapture(event.pointerId); } catch (e) {}
      var rect = card.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top })); } catch (e) {}
    });
  }

  function restorePosition(card) {
    var raw;
    try { raw = localStorage.getItem(POS_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var pos = JSON.parse(raw);
      if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        card.style.left = Math.max(4, Math.min(pos.left, window.innerWidth - 220)) + 'px';
        card.style.top = Math.max(4, Math.min(pos.top, window.innerHeight - 80)) + 'px';
        card.style.right = 'auto';
        card.style.bottom = 'auto';
      }
    } catch (e) {}
  }

  function buildRestore() {
    var bubble = el('div', 'dac-restore', '券');
    bubble.title = '显示代金券挂件';
    bubble.addEventListener('click', function () {
      try { localStorage.removeItem(HIDDEN_KEY); } catch (e) {}
      state.hidden = false;
      render();
    });
    return bubble;
  }

  function mount() {
    ensureStyle();
    var host = document.getElementById('dsh-app') || document.body;
    if (!host) return;
    var existing = document.getElementById(ROOT_ID) || document.getElementById('dsh-aliyun-coupon-restore');
    if (!existing) {
      // 首次挂载时建立容器；后续 render 只复用同一个节点，避免拖动被打断。
      if (state.hidden) {
        var bubble = buildRestore();
        bubble.id = 'dsh-aliyun-coupon-restore';
        host.appendChild(bubble);
      } else {
        var card = buildCard();
        restorePosition(card);
        host.appendChild(card);
      }
    }
  }

  function render() {
    if (state.forceSetup && state.data) { /* 保留输入焦点：由 renderInto 的表单分支处理 */ }
    var card = document.getElementById(ROOT_ID);
    var restore = document.getElementById('dsh-aliyun-coupon-restore');
    if (state.hidden) {
      if (card) card.parentNode.removeChild(card);
      if (!restore) mount();
      return;
    }
    if (!card) {
      if (restore) restore.parentNode.removeChild(restore);
      mount();
      card = document.getElementById(ROOT_ID);
    }
    if (card) renderInto(card);
  }

  function start() {
    mount();
    render();
    load();
    setInterval(function () {
      if (!state.hidden && document.getElementById(ROOT_ID)) load();
    }, POLL_MS);
  }

  try {
    try { state.hidden = localStorage.getItem(HIDDEN_KEY) === '1'; } catch (e) {}
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  } catch (error) {
    // 挂件是锦上添花：任何异常都不能影响 DSH 页面本身。
    try { console.warn('[aliyun-coupon] 挂件启动失败：' + String(error && error.message || error)); } catch (e) {}
  }
})();
