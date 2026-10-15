# 阿里云300代金券接入dsh后余额的快捷显示栏

> DSH 插件 · 包名 `dsh-aliyun-coupon` · 当前版本 `0.1.9` · MIT

> 📦 **这个仓库里有两个 DSH 插件**：根目录是代金券挂件（本文档），[`dsh-achievement-sound/`](dsh-achievement-sound/README.md) 是成就提示音插件。clone 一次两个都拿到，各自独立安装、互不依赖 —— 详见下面[「仓库里的第二个插件」](#仓库里的第二个插件成就提示音)。

把阿里云「费用与成本 → 代金券」页面里那个**余额数字**搬进 DeepSeek Harness（DSH）：

- **右下角一个常驻小挂件**：大字显示可用余额合计、可用/总张数、30 天内到期提醒，带「刷新 / 明细 / 改 Key / 背景 / 隐藏」按钮，**可拖动、可调整大小、可换背景图**，位置、倍率、背景都会记住；
- **同时写成文件**：`<工作区>/aliyun-coupon/代金券余额.md`（给人看）+ `coupon-balance.json`（给程序读），在 DSH 左侧「文件」面板直接点开；
- **模型也能查**：注册工具 `aliyun_coupon_balance`，对话里问一句「我的代金券还剩多少」就会刷新并把摘要带回上下文；
- **默认每小时自动刷新一次**，挂载 3 秒后先拉一次。

挂件长这样（跟随 DSH 主题的浅色/深色令牌）：

```
◤← 左上角斜纹把手：拖动缩放，双击恢复 100%
┌──────────────────────────────────────┐
│ 阿里云代金券                      ●  │  ← 圆点=状态（绿 ok / 黄 未配置 / 红 出错）
│ ¥ 287.58                             │  ← 可用余额合计
│ 1 张可用 · 共 1 张 · 10-15 16:45     │
│ ⚠ 1 张 30 天内到期（剩 15 天）       │  ← 只在真的有券快到期时出现
│ [刷新] [明细] [改 Key] [背景] [隐藏] │
└──────────────────────────────────────┘
```

卡片上只留数字本身，不再显示「已写入 …」那行长路径（文件照旧写，路径在对话摘要和文件面板里看）。

缩放范围 `0.7×`–`2×`，拖动时卡片上方实时显示百分比，双击把手恢复 100%。以**右下角为支点**（放大向左上生长），位置也一律按 `right`/`bottom` 记，所以**无论放大还是缩小，卡片最多只能贴到窗口边缘，拖不出去**；窗口被拉小时也会自动把它拉回可视区。倍率与位置都存在浏览器 localStorage，刷新页面后保持。

---

## 仓库里的第二个插件：成就提示音

[`dsh-achievement-sound/`](dsh-achievement-sound/README.md) —— 在「任务完成」和「助手停下来等你回答/选择」这两个时刻，由**宿主**直接放一声「成就解锁」风格的提示音（DSH 页面关着也响，也不需要先点一下页面解锁浏览器音频）。

它**自带两个用代码合成的默认音**（`tools/gen-chime.mjs` 生成，钟声泛音列 + 指数衰减），clone 下来就能用，**不含任何第三方音效素材**。

```sh
git clone https://github.com/CJL-QWQ1/-300-dsh-.git
cd -300-dsh-/dsh-achievement-sound
npm pack --pack-destination ../        # → dsh-achievement-sound-0.1.1.tgz
```

然后让助手执行插件管理器的 `install_bundle`，target 写 `file:<上面那个 tgz 的绝对路径>`；**装完重启一次 DSH**（宿主半区在启动时加载）。

想换成自己的音效：把任意 **PCM 格式的 wav** 复制成下面两个名字即可 —— 不用改配置、不用重装、也不用重启（每次触发都现读磁盘）：

```
%USERPROFILE%\.dsh\achievement-sound\task-end.wav       ← 任务完成音
%USERPROFILE%\.dsh\achievement-sound\await-input.wav    ← 等待输入音
```

> ⚠️ 文件名必须一模一样。丢一个 `我的音效.wav` 进去是不会被用的，症状是「换了音却还是原来的声音」。
> 放进去之前先体检：`node tools/wavinfo.mjs <你的文件>`（mp3 不行，SoundPlayer 只解 PCM wav）。

配置项、诊断日志、排错表见 [子目录的 README](dsh-achievement-sound/README.md)。

---

## 为什么需要 AccessKey（不能直接抓那个网页）

`https://billing-cost.console.aliyun.com/coupons/coupon` 是登录态 SPA，余额由前端接口渲染，**HTML 里没有这个数字**；靠 Cookie 抓也会随登录态过期而失效。所以本插件走官方 OpenAPI，与控制台同源：

| 项 | 值 |
| --- | --- |
| 产品 / 版本 | `BssOpenApi` / `2017-12-14` |
| 接口 | `QueryCashCoupons`（查询用户代金券信息） |
| 需要的授权 | RAM 动作 `bss:DescribeCoupons` |
| 接入点 | `https://business.aliyuncs.com/`（国际站：`https://business.ap-southeast-1.aliyuncs.com/`） |
| 签名 | RPC v1：待签串 `POST&%2F&<percentEncode(规范化查询串)>`，签名 `base64(HMAC-SHA1(secret + "&", 待签串))` |
| 限流 | 每账号 10 次/秒 |

控制台地址只作为「数据出处」写进报告，不参与取数。

---

## 安装

### 方式一：打成 tarball 让 DSH 装（推荐）

```sh
git clone https://github.com/CJL-QWQ1/-300-dsh-.git dsh-aliyun-coupon
cd dsh-aliyun-coupon
npm pack --pack-destination ../        # 或 pnpm pack → dsh-aliyun-coupon-0.1.4.tgz
```

然后在 DSH 里让助手执行插件管理器的 `install_bundle`：

```
target: file:<dsh-aliyun-coupon-0.1.4.tgz 的绝对路径>
```

命令行等价写法（profile 按你的实际情况填 `desktop` 或 `web`）：

```sh
dsh plugin --profile desktop add file:C:\path\to\dsh-aliyun-coupon-0.1.4.tgz
```

### 方式二：手动放进 profile

```sh
# 1) 复制整个目录到 profile 的 node_modules
cp -r dsh-aliyun-coupon ~/.dsh/profiles/desktop/node_modules/

# 2) 在 profile 的 package.json → dsh.profile.bundles 里加 "dsh-aliyun-coupon"，
#    或在 profile 的 cordis.patch.yml 里加：
```

```yaml
- insert:
    - id: aliyun-coupon
      name: dsh-aliyun-coupon
```

> ⚠️ **不要用 `link:` 方式安装本插件**。`link:` 建的是符号链接，Node 按真实路径解析裸导入，
> 插件里的 `@deepseek-ai/dsh-credentials`、`dsh-tools`、`schemastery` 会顺着链接找回你的工作区而解析失败。
> 用 `file:<tarball>`（真拷贝）或手动复制目录都可以。

**装完重启一次 DSH**：宿主半区（路由、工具、定时器）在启动时加载，插件管理器对这类改动会报 `restart-required`。挂件脚本按 mtime 从磁盘读，单独改它不用重启。

---

## 配置 AccessKey（三种任选）

### 1. 挂件里直接填（最省事）

挂件未配置时会自己变成输入框；已配置就点 **改 Key**。填 AccessKey ID + Secret → **保存并刷新** → 数字当场出来。

值经 `POST /dsh-aliyun-coupon/credentials` 写进 **DSH 官方凭证服务**（引用名 `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET`，落在 `$DSH_HOME/.credentials.yaml`），**不进仓库、不进工作区文件、不进日志**，界面只回显掩码 `LTAI****abcd`。

### 2. 环境变量

给启动 DSH 的进程设 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`。凭证服务的优先级是「进程环境 > 托管存储 > `.env`」，所以环境变量会盖过挂件里存的值。

### 3. 改引用名

DSH 设置 → 插件 → 阿里云代金券余额 → 配置里改 `accessKeyIdRef` / `accessKeySecretRef`。

### AccessKey 从哪来（阿里云侧，约 3 分钟）

1. [RAM 控制台 → 用户](https://ram.console.aliyun.com/users) → **创建用户**，登录名随便（如 `coupon-reader`）；
2. **访问方式**只勾 **使用永久 AccessKey 访问**，再勾「我确认必须创建 AccessKey」→ 确定；
3. 成功页**当场显示** AccessKey ID 与 Secret（Secret 只显示这一次；每个用户最多 2 对）；
4. **必须授权**：用户列表点该用户名 → **权限 → 新增授权** → 搜 `AliyunBSSReadOnlyAccess` → 确认。
   该系统策略内容是 `bss:Describe*` + `bssapi:Describe*` + `bssapi:Query*`，正好覆盖 `bss:DescribeCoupons`。
   **漏了这步会拿到 `400 NotAuthorized`。**

别用主账号 AccessKey —— 那等于整个账号的管理权限，只为看个代金券余额不值得。

---

## 使用

### 挂件按钮

| 按钮 | 作用 |
| --- | --- |
| **刷新** | `POST /dsh-aliyun-coupon/refresh`，立刻重拉并重写文件 |
| **明细** | 展开每张券：编号、状态（可用/已过期/已作废）、余额 |
| **改 Key** | 重新录入 AccessKey |
| **背景** | 展开背景面板：选本地图片 / 粘贴图片网址 / 调遮罩浓度 / 清除背景 |
| **隐藏** | 收成角落一个小圆点，点它恢复（记在 localStorage） |
| **左上角斜纹把手** | 拖动整体缩放（`0.7×`–`2×`，实时显示百分比），双击恢复 100% |

拖动标题栏可移动，位置记在 localStorage。挂件每 60 秒读一次宿主缓存（不主动打阿里云接口）。

#### 位置与缩放的实现要点

缩放用 `transform: scale()` + `transform-origin: bottom right`：不参与布局，因此不会挤动 DSH 页面本身，也不会破坏默认的 `bottom:96px` 留白。

位置**一律按 `right`/`bottom` 记录与钳制**（不是 `left`/`top`）—— 支点就是右下角，这个角在任何倍率下都不动，「视觉位置 == 布局位置」恒成立。早期版本把视觉 `left`/`top` 直接写回布局值，缩小后两者差一截，钳制随之失准，卡片就能被拖到窗口外；现在每一帧拖动都重新钳制，**最多贴到窗口边缘（留 4px）**，窗口被拉小时也会自动拉回可视区。旧格式的位置记录会自动换算，不用手动清。

#### 自定义背景

点「背景」展开面板：

| 操作 | 说明 |
| --- | --- |
| **选择图片…** | 选本地图片：先解码、压到最长边 640px 再存；带透明通道的 PNG/GIF/WebP 保持 PNG 编码并压到 480px（免得透明区被填成黑底），存储放不下时自动再压小一档。**只存在这台机器的 localStorage 里**，不上传、不写进工作区文件 |
| **粘贴图片网址 + 应用** | 用外链图片。会先真的加载一次：加载不出来（网址失效，或页面安全策略不允许外链图）会直接说明原因，不静默失败 |
| **遮罩滑块** | 图片上盖一层主题色半透明遮罩（0%–90%，默认 55%），保证浅色/深色主题下数字都看得清；拖动实时预览，松手才落盘 |
| **清除背景** | 回到纯主题色背景 |

只接受 `data:image/*` 与 `http(s)://`，其它协议一律拒绝。遮罩用 `color-mix()` 跟随 DSH 主题令牌，老浏览器自动退回固定黑色半透明。

### 对话里问

```
我的阿里云代金券还剩多少？
```

模型会调 `aliyun_coupon_balance`：

| 参数 | 说明 |
| --- | --- |
| `refresh` | 默认 `true` 重新调接口；`false` 用已有快照（没快照时仍会拉一次） |
| `outputDir` | 覆盖输出目录：绝对路径直接用，相对路径基于当前会话工作区 |
| `onlyAvailable` | 覆盖统计口径 |

返回示例：

```
阿里云代金券可用余额：¥ 149.90
口径：仅可用且未过期；计入 2/4 张；更新 2026年10月15日 15:48:56
⚠️ 30 天内到期且仍有余额 1 张：Q-b1485def8f04a ¥49.90（剩 15 天）
已写入 markdown：G:\…\aliyun-coupon\代金券余额.md
已写入 json：G:\…\aliyun-coupon\coupon-balance.json
```

### 输出文件

- `aliyun-coupon/代金券余额.md`：余额合计、统计口径、张数（计入/总数/可用/过期/作废）、到期提醒、逐张券明细表（编号、面额、余额、状态、到期时间、适用产品）、数据来源与控制台出处、快照时间与 RequestId。
- `aliyun-coupon/coupon-balance.json`：同信息的机读版（`totalBalance`、`countedCount`、`coupons[]`、`fetchedAt`、`requestId`、`currency: "CNY"`…），方便你自己写脚本或接别的看板。

---

## 统计口径

默认 `onlyAvailable: true`：**只合计 `Status === "Available"` 且尚未过期**的券的 `Balance`。

注意「状态是 Available 但 `ExpiryTime` 已过」的券**不计入**（阿里云状态字段有延迟），这类券仍会出现在明细表里并标为已过期。想看全部券的余额合计，把 `onlyAvailable` 关掉。

---

## 配置项全表

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `accessKeyIdRef` | `ALIYUN_ACCESS_KEY_ID` | AccessKey ID 的凭证引用名 |
| `accessKeySecretRef` | `ALIYUN_ACCESS_KEY_SECRET` | AccessKey Secret 的凭证引用名 |
| `endpoint` | `https://business.aliyuncs.com/` | OpenAPI 接入点 |
| `onlyAvailable` | `true` | 只合计可用且未过期的券 |
| `refreshMinutes` | `60` | 定时自动刷新间隔；`0` 关闭 |
| `autoFetchOnStart` | `true` | 挂载 3 秒后先拉一次 |
| `widget` | `true` | 是否注入右下角挂件 |
| `allowCredentialWrite` | `true` | 是否允许从挂件保存 AccessKey（关掉则 `/credentials` 返回 403） |
| `outputDir` | `""` | 输出目录；留空 = 当前会话工作区 |
| `outputSubdir` | `aliyun-coupon` | 工作区下的子目录名 |
| `markdownName` | `代金券余额.md` | Markdown 报告文件名 |
| `jsonName` | `coupon-balance.json` | JSON 快照文件名 |

---

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| `尚未配置阿里云 AccessKey` | 凭证没存上：用挂件「改 Key」重填，或核对引用名与配置是否一致 |
| `400 Code=NotAuthorized` | 该 AccessKey 所属身份没有 `bss:DescribeCoupons`：挂 `AliyunBSSReadOnlyAccess` 后等 1–2 分钟。若已挂仍报：检查是否挂到了别的用户、有无显式 Deny/权限边界，或该 AK 属于**成员账号**而代金券在**结算主账号**上 |
| `400 Code=NotApplicable` | 该身份不适用此接口，常见于成员账号/非结算账号，换出账主账号侧的 AccessKey |
| `SignatureDoesNotMatch` | Secret 填错或带了多余空格/换行，重新录入 |
| `InvalidAccessKeyId` | ID 不完整或已在控制台禁用 |
| `Throttling` | 触发限流（10 次/秒），稍后再刷新 |
| 挂件没出现 | 先刷新页面；桌面端的 index 注入表在宿主启动时收集一次，**重启 DSH** 再看。仍没有就检查 `widget` 是否为 true、`/dsh-aliyun-coupon` 前缀是否被别的插件占了 |
| 对话里看不到 `aliyun_coupon_balance` | 新装/新启用的插件工具在**新一轮对话**才生效；宿主半区改动需要**重启 DSH** |
| 余额是 0 但确定有券 | 看口径：券可能是 `Expired`/`Cancelled`，或「Available 但已过期」。关掉 `onlyAvailable` 再刷新，或点「明细」逐张核对 |

插件会把上游错误码翻成可执行的中文提示（例如 `NotAuthorized` → 该挂哪条策略），并保留 `RequestId` 方便提工单。

---

## 安全边界

- **密钥**：只存在 DSH 凭证服务里。HTTP 响应、日志、写出的两个文件都**不含 Secret**；`/state` 只回 `configured` 布尔与掩码 ID。
- **路由鉴权**：`/state`、`/refresh`、`/credentials` 都过三层校验 —— ① `Sec-Fetch-Site: cross-site` 直接 403；② 带 `Origin` 时必须与 `Host` 同源；③ 委托宿主 `connection.requestRejection`（含浏览器鉴权，未登录 401）；宿主栅栏抛异常按拒绝处理（fail-closed）。`/widget.js` 只是静态脚本、不含数据，故不鉴权。
- **挂件不能拖垮宿主**：index 注入用内联行（自建 `<script>` 且 `onerror` 吞掉），路由不在时静默不出现；插件内部所有注册都包了 try/catch。
- **最小权限**：建议单独建一个只有费用中心只读权限的 RAM 子账号发 AccessKey。

---

## 目录结构与开发

```
lib/core.js                        纯逻辑：percentEncode / canonicalQuery / 签名串构造 /
                                   normalizeCoupons（口径与到期判定）/ 三份渲染 / 错误码提示
lib/index.js                       宿主半区：凭证解析、上游调用、写盘、4 条路由、
                                   index 注入、defineTool 工具、定时刷新、清理
widget/aliyun-coupon-widget.js     浏览器挂件（零依赖、零框架，纯 DOM）
test/selftest.mjs                  11 项纯逻辑自测（签名规则、口径、渲染、错误码提示）
test/host-probe.mjs                假 Cordis 作用域端到端探针：Config 解析、工具注册、路由、
                                   注入幂等、签名请求、落盘、缓存、未配置降级、跨站 403、
                                   NotAuthorized 提示
test/braces.mjs                    括号配对小探针（编辑大文件时防手滑）
cordis.patch.yml                   bundle 补丁：把 aliyun-coupon 这个条目插进插件树
```

跑测试（`host-probe.mjs` 需要能解析 `@deepseek-ai/*`，把它放到 DSH profile 目录下的临时副本里跑）：

```sh
node test/selftest.mjs
node test/braces.mjs lib/index.js
```

`host-probe.mjs` 用桩替换 `globalThis.fetch`，不联网、不碰真实凭证。

---

## 卸载

```sh
dsh plugin --profile desktop remove dsh-aliyun-coupon
```

或用插件管理器的 `remove_bundle`。想连密钥一起清掉：在 DSH 设置里删除 `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET`，或在挂件「改 Key」里把字段清空后保存（空值 = unset）。工作区里的 `aliyun-coupon/` 目录不会自动删。

## 许可

MIT，见 [LICENSE](LICENSE)。
