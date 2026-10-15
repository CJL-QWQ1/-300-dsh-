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
  var SCALE_KEY = 'dsh-aliyun-coupon:scale';
  var BG_KEY = 'dsh-aliyun-coupon:bg';
  var MIN_SCALE = 0.7;
  var MAX_SCALE = 2;
  var EDGE = 4;             // 卡片与窗口边缘之间至少留这么多像素
  var DEFAULT_DIM = 0.55;   // 背景图上的遮罩浓度，保证数字始终看得清
  var POLL_MS = 60000;

  // 当前缩放倍率（1 = 原始大小）与自定义背景。都只在浏览器侧存，不打扰宿主。
  var scale = 1;
  var bg = null;            // { src, dim }

  if (window.__dshAliyunCouponMounted) return;
  window.__dshAliyunCouponMounted = true;

  var state = { data: null, busy: false, error: '', detail: false, collapsed: false, bgPanel: false, bgNote: '', bgDraft: '' };

  // —— 样式：只用 DSH 主题令牌，浅色/深色都跟手 ——
  var CSS = [
    '.dac-card{position:fixed;z-index:2147482000;right:16px;bottom:96px;min-width:98px;max-width:140px;',
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
    // 缩放：右下角钉住，放大向左上生长。用 transform 而不是改宽高，
    // 这样不参与布局、不会挤动 DSH 页面本身，也不会破坏 bottom:96px 的留白。
    '.dac-card,.dac-restore{transform:scale(var(--dac-scale,1));transform-origin:bottom right}',
    '.dac-grip{position:absolute;left:-5px;top:-5px;width:20px;height:20px;cursor:nwse-resize;',
    'border-radius:6px 0 8px 0;opacity:.3;touch-action:none;',
    'background:repeating-linear-gradient(135deg,var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary)) 0 1.5px,transparent 1.5px 5px)}',
    '.dac-grip:hover,.dac-grip.dac-active{opacity:.9}',
    '.dac-scale-tag{position:absolute;left:50%;top:-22px;transform:translateX(-50%);',
    'padding:1px 7px;border-radius:7px;font-size:10px;line-height:1.6;white-space:nowrap;',
    'background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);',
    'color:var(--dsw-alias-label-secondary);pointer-events:none}',
    // 自定义背景面板
    '.dac-bg{display:flex;flex-direction:column;gap:6px;margin-top:4px;',
    'border-top:.5px solid var(--dsw-alias-border-l2);padding-top:6px}',
    '.dac-bg-row{display:flex;gap:6px;align-items:center}',
    '.dac-range{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary)}',
    // 真正的 <input type=file> 藏起来，用按钮代它触发
    '.dac-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}',
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
    attachResize(card);
    return card;
  }

  function renderInto(card) {
    clear(card);
    // 缩放手把手放在左上角 —— 右下角是被钉住的那一角，往左上拉就是放大。
    var grip = el('div', 'dac-grip');
    grip.title = '拖动调整大小 · 双击恢复 100%';
    card.appendChild(grip);
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

    var bgBtn = el('button', 'dac-btn', state.bgPanel ? '收起背景' : '背景');
    bgBtn.title = '给挂件换一张背景图';
    bgBtn.addEventListener('click', function () { state.bgPanel = !state.bgPanel; render(); });
    row.appendChild(bgBtn);

    var hideBtn = el('button', 'dac-btn', '隐藏');
    hideBtn.addEventListener('click', function () {
      try { localStorage.setItem(HIDDEN_KEY, '1'); } catch (e) {}
      state.hidden = true;
      render();
    });
    row.appendChild(hideBtn);

    card.appendChild(row);

    if (state.bgPanel) renderBgPanel(card);
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

  // —— 自定义背景 ——
  var colorMixOk = null;

  function supportsColorMix() {
    if (colorMixOk !== null) return colorMixOk;
    try {
      colorMixOk = !!(window.CSS && CSS.supports
        && CSS.supports('color', 'color-mix(in srgb, red 50%, transparent)'));
    } catch (e) { colorMixOk = false; }
    return colorMixOk;
  }

  function clampDim(value) {
    var num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_DIM;
    return Math.min(0.9, Math.max(0, Math.round(num * 100) / 100));
  }

  function currentDim() {
    return bg ? clampDim(bg.dim) : DEFAULT_DIM;
  }

  // 只接受 data:image/* 与 http(s) 网址。CSS url() 里塞别的协议没好处，一律拒绝。
  function safeBgSrc(raw) {
    var src = String(raw == null ? '' : raw).trim();
    if (!src) return '';
    if (/^data:image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml);base64,/i.test(src)) return src;
    // 用 \x22 / \x27 而不是字面引号：语义一样，但不会把简单的括号探针骗成"字符串没闭合"
    if (/^https?:\/\/[^\s\x22\x27()]+$/i.test(src)) return src;
    return '';
  }

  function applyBackground(card) {
    if (!card) return;
    try {
      if (!bg || !bg.src) {
        card.style.backgroundImage = '';
        card.style.backgroundSize = '';
        card.style.backgroundPosition = '';
        return;
      }
      var dim = clampDim(bg.dim);
      // 图片上盖一层主题色遮罩，浅色/深色主题下文字都还看得清；
      // 老浏览器没有 color-mix 就退回固定的黑色半透明。
      var veilColor = supportsColorMix()
        ? 'color-mix(in srgb, var(--dsw-alias-bg-overlay) ' + Math.round(dim * 100) + '%, transparent)'
        : 'rgba(0,0,0,' + (dim * 0.8).toFixed(2) + ')';
      var veil = dim > 0 ? 'linear-gradient(' + veilColor + ' 0 0)' : '';
      card.style.backgroundImage = (veil ? veil + ',' : '')
        + 'url("' + String(bg.src).replace(/"/g, '%22') + '")';
      card.style.backgroundSize = 'cover';
      card.style.backgroundPosition = 'center';
    } catch (e) {}
  }

  function persistBg(next) {
    var previous = bg;
    bg = next;
    try {
      if (next) localStorage.setItem(BG_KEY, JSON.stringify(next));
      else localStorage.removeItem(BG_KEY);
      return true;
    } catch (e) {
      bg = previous;      // 写不进去就别让内存里留着一个"看起来生效了"的状态
      return false;
    }
  }

  function readBg() {
    try {
      var raw = localStorage.getItem(BG_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var src = safeBgSrc(parsed && parsed.src);
      return src ? { src: src, dim: clampDim(parsed && parsed.dim) } : null;
    } catch (e) { return null; }
  }

  // 先真的加载一次：网址失效或被页面安全策略挡住时要能说清楚，而不是静默没反应。
  function probeImage(src) {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (ok) { if (!settled) { settled = true; resolve(ok); } };
      var img = new Image();
      img.onload = function () { finish(true); };
      img.onerror = function () { finish(false); };
      try { img.src = src; } catch (e) { finish(false); }
      setTimeout(function () { finish(false); }, 8000);
    });
  }

  // 本地图片压到最长边 maxSize 再存，避免撑爆 localStorage（一般只有几 MB）。
  function fileToDataUrl(file, maxSize, type, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('这个文件解不出图片')); };
        img.onload = function () {
          try {
            var width = img.width || 1;
            var height = img.height || 1;
            var ratio = Math.min(1, maxSize / Math.max(width, height));
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * ratio));
            canvas.height = Math.max(1, Math.round(height * ratio));
            var context = canvas.getContext('2d');
            if (!context) { resolve(String(reader.result)); return; }
            context.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL(type, quality));
          } catch (error) { reject(error); }
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  function renderBgPanel(card) {
    function note(text) {
      state.bgNote = text;
      render();
    }

    function useFile(file, button) {
      button.disabled = true;
      button.textContent = '处理中…';
      var restore = function () {
        button.disabled = false;
        button.textContent = '选择图片…';
      };
      // PNG/GIF/WebP/SVG 往往带透明通道：一律转 JPEG 会把透明区填成黑底，
      // 所以这类源图保持 PNG，尺寸压得更狠一点来抵消体积。
      var lossless = /png|gif|webp|svg/i.test(String(file.type || ''));
      var type = lossless ? 'image/png' : 'image/jpeg';
      fileToDataUrl(file, lossless ? 480 : 640, type, lossless ? undefined : 0.82)
        .then(function (src) {
          // 能解码不等于能显示：页面 CSP 可能不允许 data: 图片。
          // 先真加载一次，失败就把原因说出来，别让用户对着"没反应"猜。
          return probeImage(src).then(function (ok) {
            if (!ok) {
              note('图片能解码，但页面安全策略不允许把 data: 当图片加载 —— 说一声，我改成走插件自己的本地路由');
              return undefined;
            }
            if (persistBg({ src: src, dim: currentDim() })) {
              applyBackground(card);
              note('');
              return undefined;
            }
            // 存储放不下：压得更小再试一次
            return fileToDataUrl(file, lossless ? 320 : 360, type, lossless ? undefined : 0.7).then(function (small) {
              if (persistBg({ src: small, dim: currentDim() })) {
                applyBackground(card);
                note('图片偏大，已自动压到更小尺寸才放进浏览器存储');
                return;
              }
              note('浏览器存储放不下这张图，换张小图或改用网址');
            });
          });
        })
        .catch(function (error) {
          note('这张图用不了：' + String(error && error.message || error));
        })
        .then(restore);
    }

    var panel = el('div', 'dac-bg');

    var row1 = el('div', 'dac-bg-row');
    var fileInput = el('input', 'dac-file');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    var pickBtn = el('button', 'dac-btn', '选择图片…');
    pickBtn.addEventListener('click', function () {
      try { fileInput.click(); } catch (e) { note('这个浏览器不允许脚本打开文件选择框'); }
    });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';          // 清空，才能连续选同一个文件
      if (file) useFile(file, pickBtn);
    });
    var clearBtn = el('button', 'dac-btn', '清除背景');
    clearBtn.addEventListener('click', function () {
      persistBg(null);
      applyBackground(card);
      note('');
    });
    row1.appendChild(pickBtn);
    row1.appendChild(clearBtn);
    row1.appendChild(fileInput);
    panel.appendChild(row1);

    var row2 = el('div', 'dac-bg-row');
    var urlInput = el('input', 'dac-input');
    urlInput.type = 'text';
    urlInput.placeholder = '或粘贴图片网址 https://…';
    urlInput.autocomplete = 'off';
    urlInput.value = state.bgDraft || '';
    urlInput.addEventListener('input', function () { state.bgDraft = urlInput.value; });
    var useBtn = el('button', 'dac-btn', '应用');
    var useUrl = function () {
      var src = safeBgSrc(urlInput.value);
      if (!src) { note('只接受 http(s) 网址，或者直接选本地图片'); return; }
      useBtn.disabled = true;
      probeImage(src).then(function (ok) {
        useBtn.disabled = false;
        if (!ok) { note('这张图加载不出来：网址失效，或页面安全策略不允许外链图片'); return; }
        if (!persistBg({ src: src, dim: currentDim() })) { note('浏览器存储写不进去'); return; }
        applyBackground(card);
        note('');
      });
    };
    useBtn.addEventListener('click', useUrl);
    urlInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); useUrl(); }
    });
    row2.appendChild(urlInput);
    row2.appendChild(useBtn);
    panel.appendChild(row2);

    var row3 = el('div', 'dac-bg-row');
    var dimLabel = el('span', 'dac-mini', '遮罩 ' + Math.round(currentDim() * 100) + '%');
    var range = el('input', 'dac-range');
    range.type = 'range';
    range.min = '0';
    range.max = '90';
    range.step = '5';
    range.value = String(Math.round(currentDim() * 100));
    range.addEventListener('input', function () {
      var dim = clampDim(Number(range.value) / 100);
      dimLabel.textContent = '遮罩 ' + Math.round(dim * 100) + '%';
      if (!bg || !bg.src) return;
      bg = { src: bg.src, dim: dim };     // 先只改内存做实时预览
      applyBackground(card);
    });
    range.addEventListener('change', function () {
      if (!bg || !bg.src) return;
      persistBg(bg);                       // 松手才落盘
    });
    row3.appendChild(dimLabel);
    row3.appendChild(range);
    panel.appendChild(row3);

    panel.appendChild(el('div', 'dac-mini', '本地图片会压到最长边 640px，只存在这台机器的浏览器里（localStorage），不上传、也不写进工作区文件'));
    if (state.bgNote) panel.appendChild(el('div', 'dac-exp', state.bgNote));
    card.appendChild(panel);
  }

  // —— 缩放 ——
  function clampScale(value) {
    var num = Number(value);
    if (!Number.isFinite(num)) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(num * 100) / 100));
  }

  function readScale() {
    try {
      var raw = localStorage.getItem(SCALE_KEY);
      return raw ? clampScale(raw) : 1;
    } catch (e) { return 1; }
  }

  function writeScale(value) {
    scale = clampScale(value);
    try { localStorage.setItem(SCALE_KEY, String(scale)); } catch (e) {}
    return scale;
  }

  function applyScale(node) {
    if (!node) return;
    try { node.style.setProperty('--dac-scale', String(scale)); } catch (e) {}
  }

  // 位置一律用 right/bottom 表示：transform-origin 就是右下角，这个角在任何倍率下都不动，
  // 所以「视觉位置 == 布局位置」恒成立，钳制不会因为缩放而算错。
  // （缩小后能被拖出窗口的 bug 就是这么来的：旧代码把视觉 left/top 直接写回布局 left/top。）
  function offsetsOf(card) {
    var rect = card.getBoundingClientRect();
    return {
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  // 夹进「整张卡片都还在窗口里」的范围：最多贴到边缘，留 EDGE 像素。
  function clampOffsets(right, bottom, width, height) {
    var maxRight = Math.max(EDGE, window.innerWidth - width - EDGE);
    var maxBottom = Math.max(EDGE, window.innerHeight - height - EDGE);
    return {
      right: Math.min(Math.max(right, EDGE), maxRight),
      bottom: Math.min(Math.max(bottom, EDGE), maxBottom),
    };
  }

  function setOffsets(card, right, bottom) {
    card.style.right = right + 'px';
    card.style.bottom = bottom + 'px';
    card.style.left = 'auto';
    card.style.top = 'auto';
  }

  // 只在真的溢出时平移回来，其余情况一动不动
  // （默认的 right:16px / bottom:96px 留白因此不会被"顺手修正"掉）。
  function keepInView(card) {
    try {
      var now = offsetsOf(card);
      if (!now.width || !now.height) return;       // 还没进 DOM，量不到
      var next = clampOffsets(now.right, now.bottom, now.width, now.height);
      if (next.right === now.right && next.bottom === now.bottom) return;
      setOffsets(card, next.right, next.bottom);
    } catch (e) {}
  }

  function savePos(card) {
    try {
      var now = offsetsOf(card);
      if (!now.width || !now.height) return;
      localStorage.setItem(POS_KEY, JSON.stringify({ right: now.right, bottom: now.bottom }));
    } catch (e) {}
  }

  function gripOf(target) {
    try {
      return target && target.closest ? target.closest('.dac-grip') : null;
    } catch (e) { return null; }
  }

  // 监听一律挂在 card 上（把手节点会随每次 render 重建，挂它身上会在轮询重绘时断掉），
  // 指针捕获也抓在 card 上，所以拖动过程中即使卡片重绘，缩放也不会中断。
  function attachResize(card) {
    var session = null;
    var tag = null;

    function ensureTag() {
      if (tag && tag.parentNode) return;
      tag = el('div', 'dac-scale-tag', Math.round(scale * 100) + '%');
      card.appendChild(tag);
    }

    card.addEventListener('pointerdown', function (event) {
      var grip = gripOf(event.target);
      if (!grip || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();          // 不要同时触发标题栏拖动
      var rect = card.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      session = { scale: scale, pinX: rect.right, pinY: rect.bottom, width: rect.width, height: rect.height };
      try { card.setPointerCapture(event.pointerId); } catch (e) {}
      try { grip.classList.add('dac-active'); } catch (e) {}
      ensureTag();
    });

    card.addEventListener('pointermove', function (event) {
      if (!session) return;
      // 以钉住的右下角为原点：指针离它越远，卡片越大。
      var ratio = Math.max(
        (session.pinX - event.clientX) / session.width,
        (session.pinY - event.clientY) / session.height
      );
      if (!Number.isFinite(ratio) || ratio <= 0) return;
      var next = clampScale(session.scale * ratio);
      if (next === scale) return;
      scale = next;
      applyScale(card);
      ensureTag();
      if (tag) tag.textContent = Math.round(scale * 100) + '%';
      keepInView(card);
    });

    function finish(event) {
      if (!session) return;
      session = null;
      try { card.releasePointerCapture(event.pointerId); } catch (e) {}
      var grip = gripOf(event.target);
      try { if (grip) grip.classList.remove('dac-active'); } catch (e) {}
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
      tag = null;
      writeScale(scale);
      applyScale(card);
      keepInView(card);
    }
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);

    card.addEventListener('dblclick', function (event) {
      if (!gripOf(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      writeScale(1);
      applyScale(card);
      keepInView(card);
    });
  }

  function attachDrag(card) {
    var drag = null;
    card.addEventListener('pointerdown', function (event) {
      if (event.target !== card && !/dac-head/.test(String(event.target.className))) return;
      if (event.button !== 0) return;
      var now = offsetsOf(card);
      if (!now.width || !now.height) return;
      drag = { x: event.clientX, y: event.clientY, right: now.right, bottom: now.bottom, w: now.width, h: now.height };
      card.setPointerCapture(event.pointerId);
    });
    card.addEventListener('pointermove', function (event) {
      if (!drag) return;
      // 往右拖 = right 偏移变小；每一帧都重新钳制，所以最多只能贴到窗口边缘，出不去。
      var next = clampOffsets(
        drag.right - (event.clientX - drag.x),
        drag.bottom - (event.clientY - drag.y),
        drag.w,
        drag.h
      );
      setOffsets(card, next.right, next.bottom);
    });
    card.addEventListener('pointerup', function (event) {
      if (!drag) return;
      drag = null;
      try { card.releasePointerCapture(event.pointerId); } catch (e) {}
      savePos(card);
    });
  }

  // 必须在卡片入 DOM 且已应用缩放之后调用：要靠 getBoundingClientRect 量到真实视觉尺寸。
  function restorePosition(card) {
    var raw;
    try { raw = localStorage.getItem(POS_KEY); } catch (e) { return; }
    if (!raw) return;
    var pos;
    try { pos = JSON.parse(raw); } catch (e) { return; }
    try {
      var now = offsetsOf(card);
      if (!now.width || !now.height) return;
      var right;
      var bottom;
      if (typeof pos.right === 'number' && typeof pos.bottom === 'number') {
        right = pos.right;
        bottom = pos.bottom;
      } else if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        // 旧版本存的是视觉 left/top，换算成 right/bottom 后照常用
        right = window.innerWidth - (pos.left + now.width);
        bottom = window.innerHeight - (pos.top + now.height);
      } else {
        return;
      }
      var next = clampOffsets(right, bottom, now.width, now.height);
      setOffsets(card, next.right, next.bottom);
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
        applyScale(bubble);
        host.appendChild(bubble);
      } else {
        var card = buildCard();
        host.appendChild(card);      // 先入 DOM：缩放与位置都要量到真实视觉尺寸才准
        applyScale(card);
        applyBackground(card);
        restorePosition(card);
        keepInView(card);
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
    // 窗口被拉小后卡片可能留在外面：尺寸一变就把它拉回可视区。
    window.addEventListener('resize', function () {
      var card = document.getElementById(ROOT_ID);
      if (card) keepInView(card);
    });
  }

  try {
    try { state.hidden = localStorage.getItem(HIDDEN_KEY) === '1'; } catch (e) {}
    scale = readScale();
    bg = readBg();
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
