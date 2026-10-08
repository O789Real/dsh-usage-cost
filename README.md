# dsh-usage-cost

在 **DSH 自带「用量」弹窗**里，把每一行 token 折算成**金额**，显示在 token 数字的右边，并在末尾追加一行合计。

> Show the money next to the tokens in DSH's built-in usage dialogs.
> Prices follow DeepSeek's official CNY price list **and its peak/off-peak schedule**,
> decided by *when that turn actually ran* — not by when you open the dialog.

```
本轮用量                                        888,131 tok
─────────────────────────────────────────────────────────────
提供方 / 模型              deepseek-account/deepseek-flash
缓存命中                                            99.97%
未缓存输入                          296 tok  ¥0.000592
缓存读取                        886,912 tok  ¥0.0355
缓存写入                              0 tok  ¥0.00
输出                                923 tok  ¥0.007384
本轮费用                                    ¥0.0435（高峰价）
```

> 金额按**这一轮发生的那一刻**的峰谷价算，不是按你查看的那一刻 —— 高峰跑的轮次，晚上再点开看仍是高峰价。

- 覆盖**两个**用量弹窗：每条回答下面那颗「用量 xx」胶囊（本轮用量）、以及输入框下方那颗会话级胶囊（Token 用量）。
- **所有会话自动生效**——它是全局界面插件，不需要逐会话开启，也没有任何按钮要按。
- 金额口径与右下角小鲸鱼挂件 **`dsh-whale-widget` 完全同源**（DeepSeek 官方价目表 + 峰谷价），两处数字能对上。
- 在 DSH `0.2.0-rc.2`（桌面端 / Web）上开发与验证；只用 Node 内置模块，无运行时依赖。

---

## 一、安装 / 更新 / 卸载

### 给使用者：一行命令（推荐）

```bash
dsh plugin --profile desktop add dsh-usage-cost
```

`--profile` 换成你自己的 profile 名（桌面端一般是 `desktop`，纯 Web 部署常见 `web`）。
也可以直接在 DSH 的 **设置 → 插件** 里安装。

本地开发时用 `link:` 指向源码目录：

```bash
dsh plugin --profile desktop add link:/绝对路径/dsh-usage-cost
```

### 不装 CLI / 想手工控制：用脚本

```powershell
# 安装或更新（幂等，可反复执行）
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 卸载（去掉 bundle 声明 + 删包目录）
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

默认装到 `E:\deepseekharness\.dsh\profiles\desktop`；换 profile 就加 `-ProfileDir "<路径>"`。

### 装完要让它生效

| 你的界面是 | 怎么做 |
|---|---|
| **桌面端应用窗口** | **完全退出并重开 DeepSeek Harness**。桌面壳的 index.html 是安装包里的静态文件，注入表在宿主启动时一次性收集，没有热刷新路径。 |
| **浏览器打开 `http://127.0.0.1:<port>/`** | 刷新页面（F5）即可。 |

> 只改 `assets/usage-cost.js`（浏览器半）时**不需要重启**：宿主按 mtime 重读该文件，刷新页面就生效。
> 改 `lib/index.js`（宿主半）需要重启。

---

## 二、钱是怎么算出来的

单价单位 **元 / 百万 token**，`[空闲价, 高峰价]`：

| 模型 | 缓存命中（缓存读取） | 缓存未命中（未缓存输入） | 输出 |
|---|---|---|---|
| `deepseek-flash`（含旧名 `deepseek-v4-flash`、`…-vision-exp`） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

- **峰谷**：北京时间**周一至周五（不含法定节假日）9:00–12:00、14:00–18:00** 为高峰；其余时段——**含周末、调休上班的周末、法定节假日全天**——按空闲价。高峰价 = 空闲价 × 2。
- 每行金额 = `该行 token ÷ 1e6 × 该环节单价`；合计 = 四行金额之和。
- **峰谷按「这一轮发生的那一刻」判，不是「你点开弹窗的那一刻」**：「本轮用量」弹窗会顺着打开中的胶囊回溯到 `[data-turn-tail]`，读那一轮自己的时钟（官方动作行末尾的 `HH:mm` / `M月D日 HH:mm` / `Y年M月D日 HH:mm`）来定峰谷。**所以高峰时段跑的一轮，晚上谷时再点开看，显示的仍是高峰价**，金额不会因为「什么时候看」而变；反过来也一样。合计行右侧会标出这一轮按的是哪个价（`（高峰价）` / `（谷价）`），鼠标悬停能看到判定依据。
- 「Token 用量」那颗**会话级**胶囊的合计跨多轮、归不到单一时段，只能按**当前时段**单价估算，括注会写明 `（按当前时段价）`——看到这个括注就说明它不是逐轮回溯的结果。
- 时钟读不到时（异常渲染等）自动退回「现在」，回执里 `refSource` 记为 `now`。
- 一轮若正好横跨切换点（例如 11:55 开始、12:05 结束），整轮按**该轮结束时刻**的价算——与小鲸鱼挂件「每轮消耗」的口径一致。
- 三个 token 桶是**互不重叠**的（DSH 的 `未缓存输入 / 缓存读取 / 缓存写入` 直接相加就是计费输入），所以不会重复计费。
- 「缓存写入」按**未命中价**计。DeepSeek 的 API 不单独上报这一桶（实测恒为 0），所以对 DeepSeek 而言与挂件口径完全一致。

### 改价

价目表在**两处**，官方调价时都要改：

| 位置 | 作用 |
|---|---|
| `assets/usage-cost.js` 顶部 `@pricing-core` 标记之间 | 浏览器半的内置价目表（离线/兜底用） |
| `<DSH_HOME>/usage-cost-pricing.json`（可选，自己新建） | 运行时覆盖，**不用重启也不用刷新**，页面每次打开弹窗都会用到最新值 |

覆盖文件长这样（只写要改的部分即可）：

```json
{
  "currency": "¥",
  "models": {
    "deepseek-flash": { "hit": [0.02, 0.04], "miss": [1, 2], "out": [4, 8] },
    "my-gateway-model": { "hit": [0.1, 0.2], "miss": [2, 4], "out": [8, 16] }
  },
  "peakHours": [[9, 12], [14, 18]],
  "holidays": { "2027-01-01": 1 }
}
```

> 同步提醒：小鲸鱼挂件的同名单价在 `dsh-whale-widget/lib/index.js` 的 `PRICING` / `BASE_PRICE` / `PRO_PRICE`；
> 每年 11 月国务院发布次年放假安排后，记得给 `HOLIDAY_VALLEY` 补下一年的日期（两处都要）。

---

## 三、实现方式（为什么不碰官方代码）

插件是标准的 DSH bundle 包，分两半：

| 文件 | 角色 |
|---|---|
| `lib/index.js` | **宿主半**：注册静态路由 + 往页面注入一行加载脚本。不读会话、不记账、不碰模型请求。 |
| `assets/usage-cost.js` | **浏览器半**：价目表 / 峰谷 / 金额换算 / 弹窗标注 / 回执。**经典脚本**（不是 ES 模块）。 |
| `cordis.patch.yml` | bundle 挂载声明。 |

浏览器半怎么进页面（两条通道并存，自带幂等守卫）：

1. `webserver/index-inject` 结构化行 —— **桌面端唯一通道**。行是内联脚本，自己建 `<script src="/dsh-usage-cost/client.js">` 并吞掉 `onerror`，所以路由不在时也只是静默失败，**绝不会让界面起不来**。
2. `webServer.tapIndex` —— 浏览器访问 `http://127.0.0.1:<port>/` 时的通道。

标注只在**官方已有的 DOM 上追加自己的节点**，不替换、不包装、不改官方渲染代码：

- 每行金额：往官方 `<dd>`（内容是 `1,036 tok`）里追加 `<span data-dsh-usage-cost-role="uncachedInput">¥0.0006</span>`；
- 合计：往官方 `<dl>` 末尾追加一对 `<dt>本轮费用</dt><dd>¥0.0435<span>（高峰价）</span></dd>`；
- 峰谷时刻：从「打开中的胶囊 → 所在 `[data-turn-tail]` → 该轮时钟」读出，不依赖任何宿主数据；
- 定位靠官方锚点 `[data-turn-usage-details]` / `[data-session-stats-usage]`；锚点没了会退化成「按标签文字反查 dl」；
- **MutationObserver 事件驱动 + 1.5s 轮询兜底**：官方组件重渲染把我注入的节点删掉时，下一次扫描就补回来，且重复扫描不会叠加；
- 读不出 token 数的行（例如 `—`）保持原样——宁可不标，也不标错；
- 全程 try/catch：插件自身出问题只留一条回执，不会把界面带崩。

---

## 四、自检与排障

| 入口 | 看什么 |
|---|---|
| `http://127.0.0.1:19387/dsh-usage-cost/health` | 宿主半是否活着、路由是否注册、页面来取过脚本没有（`clientJsServed`） |
| `http://127.0.0.1:19387/dsh-usage-cost/pricing.json` | 当前生效的价目表（含覆盖文件） |
| `http://127.0.0.1:19387/dsh-usage-cost/report` | 页面回执：页面地址、DOM 普查（几个弹窗/几颗胶囊）、每行识别到的 token 与金额 |
| `<DSH_HOME>/usage-cost-host.log` | 宿主半落盘日志（模块加载 / apply / 注入行 / 路由注册） |
| `<DSH_HOME>/usage-cost-report.jsonl` | 页面回执的落盘副本（同 `/report`，便于事后翻） |

**界面里没出现金额时**，按顺序看这三处：

1. `/dsh-usage-cost/health` 是否 200 → 不是：宿主半没加载（bundle 没进 `dsh.profile.bundles`，或者没重启）。
2. `clientJsServed` 是否 > 0 → 是 0：页面还没拿到加载脚本（桌面端要重启应用；浏览器要刷新页面）。
3. `/dsh-usage-cost/report` 里的 `census` → 若 `turnTails: 0` 而界面上明明有对话，说明脚本跑在了别的文档里；
   若 `turnPanels: 0`，说明打开弹窗那一刻没扫到锚点（回执里会带 `via` / `unknown` 标签，直接就能看出是哪种情况）。

离线自检（不需要浏览器、不需要 DSH、零依赖）：

```bash
npm test                        # 三个探针一起跑（CI 也是这条）
node tools/probe-syntax.mjs     # 经典脚本契约（顶层 export/import 会让整页起不来）
node tools/probe-pricing.mjs    # 价目表 / 峰谷 / token 文本解析 / 金额格式
node tools/probe-decorate.mjs   # 假 DOM 里的标注行为（中英 locale、峰谷按哪一刻、重复扫描、重渲染自愈、文字兜底、回执）
```

`tools/mini-dom.mjs` 是这些探针用的极简 DOM 夹具；`tools/probe-session-turn.mjs` 可以从 DSH 会话日志里
按轮次汇总真实 usage，用来跟界面上的数字对账：

```bash
node tools/probe-session-turn.mjs <解压后的 session.jsonl> [目标总 token]
```

---

## 五、已知边界

- 峰谷按「这一轮自己的时间」判（见上）。会话级合计跨多轮，只能按当前时段估算，界面已标明。
- 只认中文与英文两套官方 locale 的行标签；别的语言会退化成“按标签文字反查”的兜底路径，可能标不出来（回执里会记录没认出来的标签）。
- 官方若改掉 `data-turn-usage-details` / `data-session-stats-usage` 这两个属性名，仍能靠文字兜底工作；改掉 `dt/dd` 结构、或把动作行末尾的时钟（`_timeEnd`）去掉，才会失效（时钟没了只是退回按“现在”定价，不影响其它功能）。
- 金额是**本地估算**，不是账单；以官方账单为准。小鲸鱼挂件的「余额观测」才是真实消费的那一路数。

---

## 六、文件一览

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半（路由 + 注入行 + 落盘日志） |
| `assets/usage-cost.js` | 浏览器半（价目表 + 峰谷 + 标注 + 回执） |
| `cordis.patch.yml` | bundle 挂载声明 |
| `install.ps1` / `uninstall.ps1` / `verify.ps1` | 手工安装 / 卸载 / 装完自检（幂等，带备份） |
| `tools/mini-dom.mjs` | 离线探针用的极简 DOM 夹具 |
| `tools/probe-*.mjs` | 离线探针（打包契约 / 价格 / 标注 / 会话对账） |
| `.github/workflows/ci.yml` | 推送即跑 `npm test`（Node 20 / 22） |

## 七、维护要点

- **官方调价** → 改 `assets/usage-cost.js` 顶部 `@pricing-core` 之间的 `PRICING`，
  并同步 `dsh-whale-widget/lib/index.js` 里的同名常量（两处口径要一直对得上）。
- **每年 11 月**国务院发布次年放假安排后 → 给 `HOLIDAY_VALLEY` 补下一年的日期。
- **官方改了弹窗 DOM** → 先看 `/dsh-usage-cost/report` 里的 `census` 与 `unknown` 字段，
  再决定是补锚点、补标签字典，还是修结构识别。
- 改完先 `npm test`；改浏览器半只需刷新页面，改宿主半要重启 DSH。

---

MIT.

