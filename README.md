# DSH 成就提示音（dsh-achievement-sound）

> DSH 插件 · 包名 `dsh-achievement-sound` · 当前版本 `0.1.1` · MIT

在两个时刻放一声「成就解锁」风格的提示音：

| 时刻 | DSH 事件 | 默认音 |
| --- | --- | --- |
| **任务完成**（助手一个回合结束） | `session/event` 的 `turn/end` | `assets/task-end.wav`（上行三音 + 微光，2.0 秒） |
| **助手在等你回答/选择** | `session/event` 的 `tool/call`，工具名 `ask_user_question` | `assets/await-input.wav`（短促两音，1.0 秒） |

声音由**宿主**直接播放，不经过浏览器。

---

## 为什么在宿主发声

三条实际原因，都是查过之后定下来的：

1. **浏览器半区拿不到这些事件。** 客户端的事件目录里只有 `theme/change`、`locale/change`、`slots/changed`、`connection/reset` —— 没有任何 agent/session 事件。要判断「任务完成」只能在宿主做。
2. **页面关着也响。** 宿主 spawn 系统播放器，跟浏览器开不开、在不在前台无关。
3. **不需要用户先点一下页面。** 浏览器的自动播放策略要求 AudioContext 先被用户手势解锁，否则第一声经常是哑的；宿主播放没有这个问题。

Windows 上用系统自带的 `Media.SoundPlayer`（走 `powershell.exe` 5.1，实测冷启动约 **300ms**），不依赖 ffmpeg、mpv、sox 之类的东西 —— 本机这些都没装。

---

## 安装

```bash
# 打包（在本目录）
pnpm pack --pack-destination <某个目录>

# 装进 profile：必须用 file:，不要用 link:
#   link: 会让插件目录变成符号链接，裸包 @deepseek-ai/* 的解析会跟着 realpath 跑偏
dsh plugin --profile desktop add file:<绝对路径>/dsh-achievement-sound-0.1.1.tgz
```

也可以在 DSH 里让助手用 `plugin_manager` 装（`install_bundle`，target 写 `file:<绝对路径>`）。

> ⚠️ **装完需要重启 DSH。** 宿主半区的插件是启动时加载的，改配置或换版本都要重启才生效（这一点和「只改浏览器挂件、刷新页面就行」不一样）。

先听一下效果再装也行：

```bash
node tools/preview.mjs              # 任务完成音
node tools/preview.mjs await-input  # 等待输入音
```

`preview.mjs` 走的是插件真正会走的那条代码路径（`buildPlayCommand` + spawn + `-EncodedCommand`），所以「试听能听到」就等价于「通路是通的」。

---

## 换成你自己的音效

### 方式一：丢文件（推荐，不用改配置、不用重装）

```
C:\Users\<你>\.dsh\achievement-sound\task-end.wav       ← 任务完成音
C:\Users\<你>\.dsh\achievement-sound\await-input.wav    ← 等待输入音
```

（即 `$DSH_HOME/achievement-sound/`；只放一个也行，另一个继续用随包默认。）

> ⚠️ **文件名必须一模一样**：`task-end.wav` / `await-input.wav`（连字符，不是下划线）。
> 把 `我的音效.wav`、`desktop_toast_default.wav` 之类**原名**丢进去是不会被用的 ——
> 插件只按这两个固定名字找，找不到就落回随包默认音，症状正是「换了音却还是原来的声音」。
> 先复制/改名成上面的名字，再放进去；改完立刻生效，不用重启。

放进去之前先验一下格式，省一轮盲猜：

```bash
node tools/wavinfo.mjs C:\path\to\你的音效.wav
```

它会打印容器、编码、声道、采样率、位深、时长，并直接给结论（✅ 可以用 / ❌ 为什么不能用）；不带参数则检查随包的两个默认音。

### 方式二：配置里指定绝对路径

Settings → 插件 → 成就提示音 → 配置，填 `taskEndFile` / `awaitInputFile`。

### 格式要求（重要）

| 项 | 要求 |
| --- | --- |
| 容器 | **必须是 WAV**。`Media.SoundPlayer` 只解 PCM wav，**mp3 放不出来**；本机没有 ffmpeg/sox，插件也不负责转码 |
| 编码 | PCM（`wFormatTag = 1`） |
| 位深/声道 | 16-bit、立体声最稳 |
| 采样率 | 48000 Hz（随包默认就是这个） |
| 时长 | 建议 1–2 秒；太长会盖住下一次提示 |
| 路径 | **绝对路径**、以 `.wav` 结尾、不含换行等控制字符（插件会校验，不合格直接说明原因） |

优先级：**配置指定 > `$DSH_HOME/achievement-sound/<kind>.wav` > 随包默认**。

一个刻意的取舍：配置里显式指定了文件、但那个文件不存在时，插件**不会**偷偷退回默认音，而是在宿主日志里写清楚「配置里指定的文件不存在：…」。否则路径写错时「还有声音」，问题会被藏起来。

---

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时连事件都不订阅 |
| `taskEnd` | `true` | 任务完成（`turn/end`）时响 |
| `awaitInput` | `true` | 助手等你回答（`ask_user_question`）时响 |
| `taskEndFile` | `""` | 任务完成音的 wav 绝对路径；留空 = 覆盖目录 > 随包默认 |
| `awaitInputFile` | `""` | 等待输入音的 wav 绝对路径；同上 |
| `cooldownMs` | `1200` | 全局冷却窗口，`0` = 不冷却。见下 |
| `windowsShell` | `""` | Windows 上用哪个 shell 宿主 SoundPlayer；留空 = 系统自带的 **powershell.exe 5.1 绝对路径**（`%SystemRoot%\System32\WindowsPowerShell\v1.0\`）。用绝对路径是因为宿主进程的 PATH 可能被裁剪过，裸名字会 ENOENT，而这种失败在盲调时最容易被误判成「事件没到」。5.1 一定有 `System.Media`，pwsh 7 不保证 |
| `playOnStart` | `false` | 启动 1.5 秒后自检响一声。默认关：免得每次开 DSH 都吓一跳 |
| `debug` | `true` | 诊断日志，见下一节。0.1.x 默认开，稳定后可以关 |

### 为什么需要冷却窗口

`turn/end` 对**每个会话**都会发。助手并发跑子代理时，几个子代理会在几十毫秒内接连收尾，没有冷却就会响成一片。窗口内只认第一条，默认 1200ms。

如果你就想要「每个子代理都响一声」，把 `cooldownMs` 设成 `0`。

---

## 诊断日志（`debug`，默认开）

写到：

```
C:\Users\<你>\.dsh\achievement-sound\diagnostic.log
```

**为什么插件要自带一个日志文件**：插件的 `console.warn` 落在宿主进程里，而宿主进程的输出在有些部署（比如 Electron 打包版）根本读不到 —— 出问题时就是纯盲调。0.1.0 那次「装了、也加载了、就是不响」，正是因为看不到任何输出，才花了额外一轮去猜。所以关键节点都会追加到这个文件：

| 日志行 | 含义 |
| --- | --- |
| `loaded pid=… platform=… node=…` | 插件的 `apply()` 跑过了 |
| `paths override=… asset=…` | 它去哪儿找 wav |
| `config enabled=… cooldownMs=… shell=…` | 实际生效的配置 |
| `subscribed session/event` | 订阅成功 |
| `raw #N type=… name=…` | **前 60 条**原始事件采样：万一 DSH 换了事件词表，这里能直接看出来 |
| `fire kind=task-end` | 放行了一次，准备发声 |
| `skip kind=… reason=cooldown(312ms < 1200ms)` | 被冷却窗口挡下 |
| `skip kind=… reason=taskEnd:off` | 被单项开关挡下 |
| `warn file:task-end: 配置里指定的文件不存在：…` | 找不到 wav |
| `spawn kind=… exe=… file=…` | 播放进程起来了 |
| `exit kind=… code=0 ms=1294` | **播放进程退出码与存活时长** |
| `spawn-error …` | 起不来（ENOENT 等） |

最后一行是硬证据：`PlaySync()` 会阻塞到播放结束，所以 `ms` 应该 ≈ 300ms 冷启动 + 音频时长。**明显偏短就是声音没放完**（`detached` 那个坑就是这么定量的，见「变更记录」）。

文件超过 64KB 会自动砍掉前半段，不会无限增长。不想让它写就把 `debug` 关掉。

---

## 播放进程为什么不能 `detached`

`tools/diagnose.mjs` 会把几种 spawn 组合各放一次，用「子进程存活时长」定量对比（音频时长已知，`PlaySync` 阻塞到播完）：

| spawn 组合 | 音频 | 存活 | 结果 |
| --- | --- | --- | --- |
| `detached: true` + `stdio:'ignore'` | 1000ms | 813ms | ❌ 出不来 |
| `detached: true` + `stdio:'inherit'` | 2000ms | 671ms | ❌ 出不来 |
| 非 detached + `stdio:'ignore'` | 1000ms | 1294ms | ✅ |
| 非 detached + `stdio:'inherit'` | 2000ms | 2298ms | ✅ |

所以插件用的是 `{stdio:'ignore', windowsHide:true}` + `child.unref()` —— `unref()` 已经足够让宿主不被播放进程吊住，不需要 `detached`。这条在 `test/selftest.mjs` 里有专门的回归钉子，改回去会直接测试失败。

自己跑一遍：

```bash
npm run diagnose            # 诊断已安装到 profile 的那一份
node tools/diagnose.mjs .   # 诊断工作区源码（装之前先验）
```

---

## 刻意没做的事

- **不监听授权（`approval/asked`）。** 本会话审批是关闭的，响了也只是噪音。需要的话在 `lib/sound.js` 的 `classifyEvent` 里加一行即可。
- **不区分成功/失败的回合。** `turn/end` 一律响。想区分需要读事件里的状态字段，等有明确需求再加。
- **不做音量控制。** `Media.SoundPlayer` 没有音量 API，音量走系统音量。想要独立音量得换播放方式（例如 WinRT MediaPlayer 或 mciSendString），代价是更慢、更脆。
- **不打包任何现成音效。** 随包那两个 wav 是 `tools/gen-chime.mjs` 用代码合成的（钟声非谐波泛音列 + 指数衰减 + 高频微光），不是采样 —— 真正的 Steam 成就音是 Valve 的素材，不能分发。想改音色就改那个脚本里的 `NOTE` / `addBell` 参数，重跑 `npm run gen`。

---

## 排错

| 现象 | 查什么 |
| --- | --- |
| 换了音但还是原来的声音 | **九成是文件名不对**：必须是 `task-end.wav` / `await-input.wav`，放在 `$DSH_HOME/achievement-sound/`。先 `node tools/wavinfo.mjs <文件>` 验格式，再看诊断日志里 `spawn … file=` 那行实际用了哪个路径 —— 它写的就是真相 |
| 完全没声音 | **先看诊断日志** `$DSH_HOME/achievement-sound/diagnostic.log`：没有 `loaded` = 插件没加载（重启 DSH）；有 `loaded` 没有 `raw` = 事件没送到；有 `fire` 没有 `exit` = 播放进程没起来；`exit … ms=` 明显小于音频时长 = 声音被截断。日志读不到再退回：`node tools/preview.mjs` 试通路、查系统音量/输出设备 |
| 日志里没有 `loaded` | 宿主半区必须**重启 DSH** 才加载；也确认 Settings 里插件是启用状态 |
| 日志里 `raw` 的 type 和 `turn/end` 对不上 | DSH 换了事件词表；把日志里的真实 type 填进 `lib/sound.js` 的 `classifyEvent` |
| `exit … code=0 ms=700` 左右（音频 1000ms） | 声音被截断：检查是不是有人把 `detached: true` 加回去了（见上一节） |
| 日志说「配置里指定的不是合法的绝对 .wav 路径」 | 必须绝对路径 + `.wav` 结尾；相对路径和 mp3 都不行 |
| 日志说「配置里指定的文件不存在」 | 路径打错了，或文件真不在那儿。**不会**退回默认音，这是故意的 |
| 日志说「找不到 task-end.wav（找过：…）」 | 覆盖目录和随包 assets 都没有；随包默认应该在 `<插件目录>/assets/` |
| 日志说「平台 xxx 上没有可用的 wav 播放方式」 | 只支持 Windows / macOS / Linux；Linux 需要 `paplay` 或 `aplay` |
| 日志说「提示音播放失败（…powershell.exe）」 | 系统里没有它（被裁剪过）；把 `windowsShell` 改成可用路径 |
| 响成一片 | 调大 `cooldownMs`（并发子代理各自收尾） |
| 想临时静音 | `enabled: false`，然后重启 DSH |
| 第一声偶尔丢失 | 正常：`powershell.exe` 冷启动约 300ms，声音会比事件晚这么一点 |

---

## 目录结构

```
dsh-achievement-sound/
├── cordis.patch.yml        # bundle patch：往 profile 配置树插一行
├── package.json
├── lib/
│   ├── index.js            # 宿主半区：订阅 session/event、开关、冷却、spawn 播放器
│   └── sound.js            # 纯逻辑：事件归类 / 冷却 / 路径白名单 / 文件优先级 / 播放命令
├── assets/
│   ├── task-end.wav        # 随包默认：任务完成音（48kHz/16bit/立体声，2.0s）
│   └── await-input.wav     # 随包默认：等待输入音（1.0s）
├── tools/
│   ├── gen-chime.mjs       # 用代码合成上面两个 wav（可重复生成）
│   ├── preview.mjs         # 试听：走插件真正的播放通路
│   ├── wavinfo.mjs         # 体检：你的 wav 能不能被 SoundPlayer 放（格式/时长/结论）
│   └── diagnose.mjs        # 诊断：对比几种 spawn 组合，用存活时长判断有没有真放完
└── test/
    ├── selftest.mjs        # 26 项纯逻辑自测（不出声）
    ├── host-probe.mjs      # 宿主接线探针：假 root + 缺失文件，验证整条链路且不出声
    └── braces.mjs          # 括号配对探针
```

跑测试：

```bash
npm test          # 26 项纯逻辑自测
npm run check     # 括号配对
npm run diagnose  # 出声！对比 spawn 组合，确认声音真能放完
node test/host-probe.mjs   # 需在 profile 目录树的副本里跑（裸包 @deepseek-ai/* 才解析得到）
```

`host-probe.mjs` 的设计值得一提：它把 `$DSH_HOME` 指向空临时目录、让配置指向一个**不存在**的 wav，于是「订阅 → 归类 → 开关 → 冷却 → 解析 → 警告 → 诊断日志」整条链路都能验证，却不会真的 spawn 播放器 —— 跑测试不会吵到人。冷却窗口那一节是靠「第二种音的警告有没有出现」来观测的，诊断日志那一节则直接断言日志里有 `loaded` / `subscribed` / `fire` / `reason=cooldown`。

---

## 已知边界

- **需要重启 DSH** 才生效（宿主半区）。
- 目前只在 **Windows 11 + powershell.exe 5.1** 上实测过；macOS/Linux 的代码路径写了但没实机验证。
- 声音走系统默认输出设备，插件不控制音量。
- `turn/end` 是会话级事件：多个会话同时跑时，冷却窗口内只响一次。
- `debug` 在 0.1.x 默认是开的，会往 `$DSH_HOME/achievement-sound/diagnostic.log` 追加（64KB 自动砍前半段）。稳定后建议关掉。

---

## 变更记录

### 0.1.1

- **修掉「装了、也加载了（`fiberPhase: active`）、就是不响」**：`spawn` 的 `detached: true` 会让 PowerShell 提前退出、声音出不来 —— 实测 1000ms 的音频只活了 813ms。改成 `{stdio:'ignore', windowsHide:true}` + `child.unref()` 后同样音频活 1294ms。`test/selftest.mjs` 里加了回归钉子，改回去会直接测试失败。
- **新增诊断日志**（`debug`，默认开）：写到 `$DSH_HOME/achievement-sound/diagnostic.log`，记录加载 / 配置 / 前 60 条原始事件采样 / 放行与跳过原因 / spawn / 子进程退出码与耗时。起因就是这次盲调：宿主 `console.warn` 落不到能读的文件上。
- Windows shell 改用**绝对路径**，避免宿主 PATH 被裁剪时 ENOENT（那种失败最容易被误判成「事件没到」）。
- 新增 `tools/diagnose.mjs`（`npm run diagnose`）：对比几种 spawn 组合，用子进程存活时长客观判断声音有没有放完 —— 不依赖耳朵。

### 0.1.0

首个版本：`turn/end` 与 `tool/call(ask_user_question)` 两个时刻由宿主发声；随包两个用代码合成的默认音；支持「丢文件进覆盖目录就换音」。

---

## 卸载

```bash
dsh plugin --profile desktop remove dsh-achievement-sound
```

或让助手用 `plugin_manager` 的 `remove_bundle`。卸载不会删你放在 `$DSH_HOME/achievement-sound/` 里的 wav（那是你的文件）。
