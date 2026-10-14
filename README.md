# tg-tf-monitor

监控 / 发现**番茄小说 TestFlight 公测链接**的 Telegram 机器人 —— **无服务器版**。
部署到 Cloudflare Workers 或 Vercel，不用自己开机器、不用一直挂着。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Review977/tg-tf-monitor)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FReview977%2Ftg-tf-monitor&env=TG_TOKEN,TG_CHAT_ID,TG_WEBHOOK_SECRET,ADMIN_KEY,UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN&envDescription=TG_TOKEN%20%E4%BB%8E%20%40BotFather%20%E6%8B%BF%EF%BC%9BTG_CHAT_ID%20%E7%94%A8%20%2Fchat-id%20%E7%AB%AF%E7%82%B9%E6%9F%A5%EF%BC%9B%E4%B8%A4%E4%B8%AA%E9%9A%8F%E6%9C%BA%E4%B8%B2%E7%94%A8%20openssl%20rand%20-hex%2024%20%E7%94%9F%E6%88%90%EF%BC%9BUpstash%20%E4%B8%A4%E9%A1%B9%E4%BB%85%20Vercel%20%E9%9C%80%E8%A6%81&project-name=tg-tf-monitor&repository-name=tg-tf-monitor)

它干什么：盯着番茄小说的 TestFlight 公测链接，**链接失效 / 名额满了 / 开发者换了新链接**
就推 TG；顺便从 departures.to、tfstore、搜索引擎、TG 频道里找**新的 join 码**。
还能**从 TG 里加新的 App**（`/find` `/add` `/apps`）。

> 🚀 **第一次用请看 [SETUP.md](SETUP.md)** —— 从在 BotFather 建 bot 到跑起来，一共 5 步，
> 含两个**不能反的操作顺序**（先拿 chat_id 再设 webhook；首次部署要填 ADMIN_KEY）。
> 下面的一键部署只是其中第 ② 步。

---

## 一键部署

**Cloudflare（推荐，30 分钟一次）** —— 点上面的按钮，然后：

1. 授权 GitHub，它会**自动 fork 一份到你账号**并创建一个 Worker 项目
2. 它会读 `wrangler.toml`，**自动建好 KV 命名空间并绑定**（变量名 `STATE`），不用你手填 id
3. 它会读 `.dev.vars.example`，**逐条问你密钥**（`TG_TOKEN` 等，注释里写了怎么拿）
4. 部署完成 → 打开 `https://<你的worker>.workers.dev/chat-id?key=<ADMIN_KEY>` 拿 chat_id
5. 填回环境变量，再打开 `https://<你的worker>.workers.dev/set-webhook?key=<ADMIN_KEY>`
6. 回 TG 给 bot 发 `/status`，有回就通了

**Vercel** —— 点上面的按钮，它会让你填那几个环境变量然后部署。
⚠️ Vercel 函数无状态，**必须先建一个 Upstash Redis**（免费）填进去；
另外 **Hobby 的 cron 每天只能跑 1 次**，要 30 分钟一次得用外部定时器打
`https://<项目>.vercel.app/api/run?key=<ADMIN_KEY>&mode=all`。

> 完整步骤、每一步在控制台点哪里、以及踩过的坑，见下面的「部署 A / 部署 B」。

---

## 先说结论：选哪个

| | **Cloudflare Workers**（推荐） | Vercel |
|---|---|---|
| 定时频率 | ✅ 原生 Cron，**每分钟都行** | ⚠️ Hobby **每天只能 1 次**（`*/30 * * * *` 会**部署失败**）；要高频得 Pro，或用外部定时器 |
| 状态存储 | ✅ **平台自带 KV**，不用注册别的服务 | ⚠️ 必须外接（Upstash Redis，免费） |
| 免费额度 | Cron 5 个/账户、**每次调用 10ms CPU**、KV 10 万读/天 + 1000 写/天 | 函数调用额度 |
| 需要装 Node 吗 | ❌ 控制台粘贴即可 | ❌ GitHub 导入即可 |

**10ms CPU 够不够？** 实测（`node bench.mjs`，拿真实页面量的）：

| 操作 | 页面大小 | 纯解析 CPU |
|---|---|---|
| `parseJoinPage`（Apple join 页） | 28KB | **0.117 ms** |
| 同上，**最坏情况**（320KB 脏页） | 320KB | **0.366 ms** |
| departures.to wire:snapshot 解析 | 75KB | 0.041 ms |
| TG 频道消息切分 | 91KB | 0.070 ms |
| tfstore JSON-LD 解析 | 25KB | 0.029 ms |

一轮"监控 + 全源发现"的解析加起来 **不到 1ms**，离 10ms 还有 10 倍余量。
（网络等待不计入 CPU —— 这是 Cloudflare 的计费口径。）

→ **想要 30 分钟一次就选 Cloudflare**；只想每天跑一次、或愿意配外部定时器，Vercel 也行。

---

## 部署 A：Cloudflare Workers（不需要装任何东西）

> 控制台的中文/英文文案会随版本略有出入，下面按"在哪一类目里"写，照着找即可。

> 这一节是 [SETUP.md](SETUP.md) 的第 ② 步。**建 bot、拿 token、拿 chat_id、设 webhook**
> 都在那份文档里；这里只讲控制台里点哪里。

Cloudflare 有两条路，**任选一条**：

| | 一键按钮（A-1） | 手工粘贴（A-2） |
|---|---|---|
| 要 GitHub 吗 | ✅ 要授权 Cloudflare GitHub App | ❌ **完全不用** |
| 要装东西吗 | ❌ | ❌ |
| 建 KV / 填密钥 | 自动弹出来问你 | 自己点几下 |
| 什么时候选它 | 正常情况 | **按钮报 GitHub 授权错误时**（见下面排查） |

---

### A-1 一键按钮

点 README 顶部的 **Deploy to Cloudflare** 按钮，它会：

1. 让你授权 GitHub，然后 **fork 一份到你账号**并建 Worker 项目
2. 读 `wrangler.toml` → **自动建 KV 并绑定**（变量名 `STATE`）
3. 读 `.dev.vars.example` → **逐条弹出来问密钥**
   （`TG_TOKEN`、`TG_CHAT_ID`、`TG_WEBHOOK_SECRET`、`ADMIN_KEY`）

> ⚠️ 第一次部署时 `TG_CHAT_ID` 还不知道 —— **留空就行**，第 ③ 步拿到再补。
> 但 `TG_TOKEN` 和 `ADMIN_KEY` **必须填**（拿 chat_id 要用 `ADMIN_KEY`）。

⚠️ **如果它报红字 `Your GitHub authorization has expired`** —— 那是 Cloudflare 侧的 GitHub 授权过期，
跟本项目无关。两个选择：

- **修它**：打开 <https://github.com/settings/installations>，
  找到 **Cloudflare Workers and Pages** 这个 App → `Configure` → 重新授权/重装，然后回到部署页重试。
- **绕开它**：直接走下面的 **A-2 手工粘贴**，那条路完全不碰 GitHub。

---

### A-2 手工粘贴（不依赖 GitHub）

**1. 建 KV 命名空间**
控制台 → `Storage & Databases`（存储与数据库）→ `KV` → `Create namespace`，
名字随便（如 `tfmon-state`）。

**2. 建 Worker**
`Workers & Pages` → `Create` → `Worker` → 起个名字（如 `tg-tf-monitor`）→ `Deploy`。

**3. 粘贴代码**
进 Worker → `Edit code`（编辑代码）→ 把本仓库 **`dist/worker.js` 全文**粘贴进去
（覆盖编辑器里原有的示例代码）→ `Deploy`。
> `dist/worker.js` 是自包含单文件（约 70KB，零 import），由 `build.mjs` 从 `src/` 拼出来。
> 我已经把它的入口测试跑过一遍 —— 不是"应该能跑"，是"跑过"。

**4. 绑定 KV（变量名必须是 `STATE`）**
Worker → `Settings` → `Bindings`（绑定）→ `Add` → `KV Namespace`：
- Variable name：**`STATE`**（写错就找不到存储）
- KV namespace：选第 1 步建的那个

**5. 加环境变量 / 密钥**
Worker → `Settings` → `Variables and Secrets`，加这几个（建议都选加密/Secret）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `TG_TOKEN` | ✅ | @BotFather 发的 token |
| `TG_CHAT_ID` | ✅ | 目标会话 id（拿法见下） |
| `TG_WEBHOOK_SECRET` | 强烈建议 | 随机长串，防别人伪造推送 |
| `ADMIN_KEY` | 强烈建议 | 随机长串，保护 `/run` `/set-webhook` 等运维端点 |

随机串生成：随便敲一长串，或本地跑 `openssl rand -hex 24`。

**6. 加定时任务**
Worker → `Settings` → `Triggers` → `Cron Triggers` → 加两条：

```
*/30 * * * *      ← 每 30 分钟：只监控（省事）
0 */6 * * *       ← 每 6 小时：监控 + 全源发现
```

> 第二条的表达式要和代码里 `cron.discovery` 一致（默认就是 `0 */6 * * *`）——
> Worker 靠比对 `event.cron` 决定跑哪个。

**7. 拿 chat_id，然后设推送地址（顺序别反！）**
先打开（把 `<ADMIN_KEY>` 换成你填的值）：

```
https://<你的worker>.workers.dev/chat-id?key=<ADMIN_KEY>
```

没查到就先在 TG 里给 bot 发一条消息（或拉进群发一条），再刷新。
拿到数字后填进 `TG_CHAT_ID`，**然后再**设推送地址：

```
https://<你的worker>.workers.dev/set-webhook?key=<ADMIN_KEY>
```

> ⚠️ **为什么顺序不能反**：Telegram 的规则是**设了 webhook 之后 `getUpdates` 就返回空**。
> 先设 webhook 就再也查不到 chat_id 了（得先撤销 webhook 才行）。

**8. 体检 + 试跑**

```
https://<你的worker>.workers.dev/          ← 自检页，浏览器直接看
https://<你的worker>.workers.dev/health    ← 同上的 JSON 版
https://<你的worker>.workers.dev/run?key=<ADMIN_KEY>&mode=all   ← 立刻跑一轮
```

然后回 TG 给 bot 发 `/status`，有回就通了。

---

## 部署 B：Vercel

> 这一节是 [SETUP.md](SETUP.md) 的第 ② 步（Vercel 分支）。

**1. 推到 GitHub**，Vercel → `Add New Project` → 导入这个仓库。
（根目录选 `tg-tf-monitor-cloud`，或在项目设置里把 Root Directory 指过去。）

**2. 建 Upstash Redis（免费）**
upstash.com → 建一个 Redis 数据库 → 复制 `REST URL` 和 `REST TOKEN`。
> Vercel 的函数是无状态的，去重状态必须有地方放。没配存储时程序会**明确报错并停下**，
> 不会静默降级成"每轮重复推送"。

**3. 配环境变量**（Vercel → Settings → Environment Variables）
`TG_TOKEN`、`TG_CHAT_ID`、`ADMIN_KEY`、`TG_WEBHOOK_SECRET`、
`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`，
**再加 `CRON_SECRET`**（随机 16+ 位）。

> ⚠️ `CRON_SECRET` 为什么建议一定要设：设了它，Vercel 每次跑 cron 会自动带
> `Authorization: Bearer <CRON_SECRET>`，鉴权才严。
> **不设也能跑** —— 代码会退一步认 `x-vercel-cron-schedule` 头（Vercel Cron 每次必带，官方文档明说），
> 否则每日定时会被 403 挡住、**静默什么都不做**。代价是任何伪造该头的请求也能触发一轮检查
> （去重机制在，最多多跑一次、不会重复推送）。`/api/health` 会把这条作为提醒列出来。

**4. 部署**，然后按同样的顺序：
```
https://<项目>.vercel.app/api/chat-id?key=<ADMIN_KEY>
https://<项目>.vercel.app/api/set-webhook?key=<ADMIN_KEY>
https://<项目>.vercel.app/api/health
https://<项目>.vercel.app/api/run?key=<ADMIN_KEY>&mode=all
```

**5. 定时**
`vercel.json` 里默认配的是**每天 03:00 跑一次**（Hobby 只能这样，写更密会在**部署时直接失败**）。
想要 30 分钟一次，两条路：
- 升级 Pro（cron 可到每分钟），或
- 用任意免费外部定时器（cron-job.org 之类）每 30 分钟打一次
  `https://<项目>.vercel.app/api/run?key=<ADMIN_KEY>&mode=all`

---

## 命令（在 TG 里发给 bot）

**加 App**

| 命令 | 作用 |
|---|---|
| `/find <名字>` | 按名字搜：App Store id / bundle id、departures.to 的 app id、tfstore 上的 TF 码（带可直接复制的 `/add`） |
| `/add <TestFlight链接> [名称] [appstore=<id>] [departures=<id>]` | 加一个 App 进监控，**元数据自动补齐** |
| `/apps` | 看监控中的 App 各自都盯了什么 |
| `/del <码>` | 移出监控 |

**看状态 / 运维**

| 命令 | 作用 |
|---|---|
| `/status` | 当前监控状态、上次检查/扫描时间 |
| `/links` | 列出已知 join 码（监控中的 + 历史发现） |
| `/check` | 立刻跑一轮监控 |
| `/scan` | 立刻跑一轮发现扫描 |
| `/sources` | 查看发现源与关键词配置 |
| `/test` | 发一条测试消息 |
| `/help` | 帮助 |

只响应 `TG_CHAT_ID` 那个会话发来的命令，别人的命令直接忽略。

### 怎么加一个新 App

```
/find 微信读书
```

会给出三个来源的结果。看到 tfstore 上有码，直接复制它给的命令：

```
/add 5MWjLpYl 微信读书
```

bot 会自己去补齐并回你（下面是**真实跑出来的输出**）：

```
✅ 已加入监控：微信读书
join 码：5MWjLpYl　状态：已满员 ⛔
App Store：952059546（com.tencent.weread） 自动匹配
departures.to：21038 自动匹配
发现关键词：微信读书 / com.tencent.weread
```

加完之后这个 App 会被盯四件事：

1. **链接状态** —— 每轮轮询 join 页
2. **App Store 正式版号** —— 自动关联了 id 才有
3. **departures.to 链接轮换** —— 自动关联了 id 才有（开发者换码时这里会先变）
4. **`/scan` 时按它自己的关键词找新码** —— 关键词从应用名自动派生，并进发现过滤集

**自动补齐的三个来源**（都实测可用）：

| 来源 | 拿到什么 |
|---|---|
| join 页本身 | 真实应用名、当前状态、文案指纹 |
| `itunes.apple.com/search` | App Store id、bundle id |
| `departures.to/search?searchTerm=` | departures.to 的 app id |

> ⚠️ 第三个的来源参数名是 `searchTerm`，**不是 `q`** —— `?q=` 会被静默忽略、返回默认列表，
> 看着像"这站搜不了"。这是实测出来的（文档里没写）。

⚠️ **认不准就不填，不硬猜** —— 猜错 App Store id 会让"正式版更新"告警张冠李戴，比不填更糟。
匹配不到时它会留空并说明原因，可以用 `appstore=` / `departures=` 手动指定：

```
/add 5MWjLpYl 微信读书 appstore=952059546 departures=21038
```

⚠️ **「确实没有」和「这次查失败」是分开报的** —— 前者可以安心不填；
后者会提示"查询失败，可稍后重发 /add 补上"，免得你以为这 App 不在 App Store。

---

## 它监控什么

**每轮**直接轮询 `https://testflight.apple.com/join/<code>`。

判据分两层，**先措辞、后结构**：

| 状态 | HTTP | 第一层：措辞（中英实测校准） | 第二层：结构（**语言无关**） |
|---|---|---|---|
| 可加入 ✅ | 200 | — | 存在 `step1` **非空**的 `app-steps` 块 |
| 已满员 ⛔ | 200 | `beta-status` 状态句含 `测试员已满` / `is full` | 标题里**带 app 名** |
| 已关闭 🚫 | 200 | `beta-status` 状态句含 `不接受` / `not accepting` | 标题就是通用的 `TestFlight - Apple` |
| 链接失效 ❌ | 404 | — | — |

**为什么必须有第二层**：Apple 按**出口 IP** 决定页面语言。Cloudflare Workers 的出口
可能落在东京等地，那时 Apple 会返回**日语页** —— 只认中英措辞就会判成"状态未知"。
结构判据在 6 个真实样本上完全干净：

| | 非空 `step1` | 空 `step1` | 标题 |
|---|---|---|---|
| 可加入（中/英） | **2** | 0 | 带 app 名 |
| 已满（中/英） | 0 | 2 | **带 app 名** |
| 已关闭（中/英） | 0 | 2 | **通用 `TestFlight - Apple`** |

测试里直接把样本措辞换成日语验证过（`语言无关：措辞换成日语…` 三条）。
判定结果会带一个 `stateBasis` 字段标明靠哪一层（`wording` / `structure` / `title`）——
如果是 `title`，告警里会明说"这是按结构推断的，页面语言可能不是中/英"。

**状态句的唯一权威来源 = `<div class="beta-status">` 里的 `<span>`**（6 个样本全一致）。

⚠️ 两个实测踩出来的坑：
1. **不能靠 `beta-status` 存在 或「加入测试」按钮判定** —— 已满/已关闭页面上这两个**照样存在**。
   （按钮文案还跟着语言走：en `View in TestFlight` / zh `在 TestFlight 中查看`。）
2. **Apple 按 IP 定语言，改 `Accept-Language` 无效** —— 同一链接中英随机出现。
   所以判定必须双语兼容 + 有语言无关的结构兜底，也因此必须有固定样本的离线测试。

**发现源**：departures.to（app 16645，换码时这里先变）、tfstore.top、
Bing、360 搜索、可配置的 TG 频道（`t.me/s/<频道>` 公开预览）。
实测产出：departures.to ✅ 最有用；tfstore.top 可用但**不收录番茄小说**；
TG 频道可用（`@testflight` / `@TestFlightApps` 每次各约 15 个 join 码，但都是英文通用频道）；
360 时好时坏；**Bing 对本主题召回 0**（我逐条核对过页面里那 31 处 `testflight.apple.com` 全是查询词回显，不是解析漏抓）。

---

## 诚实的能力边界

- ❌ **看不到 TF 构建号** —— Apple 不公开 beta 构建信息，公测页上也没有版本号。
  近似信号只有"公测页文案指纹变化"（弱）和"App Store 正式版号变化"（≠ TF 构建）。
- ❌ 不知道你的 SVIP 还剩几天（账号权益，只能在 App 里看）。
- ⚠️ 发现源都有滞后，所以**第一手判定永远是直接轮询 Apple**，发现源只用来找新码。

---

## 验证（都能自己复现）

```bash
node build.mjs        # 拼出 dist/worker.js（会检查撞名 + 语法 + export default 唯一）
node --test           # 116 项测试
node bench.mjs        # CPU 基准（回答"10ms 够不够"）
node cli.mjs selftest # 联网：拿 4 个已知状态的 join 码验证判定
node cli.mjs find 微信读书   # 联网：试 /find
node cli.mjs add <链接>     # 联网：试 /add 的元数据自动补齐
node cli.mjs check    # 联网：真实跑一轮（默认只打印不发）
```

测试覆盖（**116 项全过**）：

| 组 | 内容 |
|---|---|
| 核心判定 | 6 个真实页面样本 × 中英，状态必须判对 |
| **语言无关性** | 把样本措辞换成**日语**，仍须靠结构判出 open/full/closed（防 CF 出口落在东京） |
| **回归护栏** | 显式断言"已满/已关闭页面仍带 beta-status 与加入按钮"，并把那条**错规则**跑一遍证明它真会判错 —— 以后谁想"简化"判据，测试立刻变红 |
| 反例 | 描述里写"名额已满"、App 名带状态词、200 但页面截断 → 都不许误判（尤其**不许误报成可加入**） |
| 消息安全 | 告警被 Telegram 拒收 = **静默漏报**。发前校验 HTML（白名单标签 + 配对 + 禁裸 `<` 与未转义 `&`），超长按行截断，不合法退回纯文本 |
| 入口层 | 用桩 fetch + 桩 KV 把整个 Worker 跑一遍：Cron 分派、`/run` 鉴权、Webhook secret 校验、非授权会话忽略、`/scan` 真跑发现源、`/set-webhook` 带 secret_token |
| **产物一致性** | 同一套入口断言对 `src/worker.js` **和 `dist/worker.js` 各跑一遍** —— 保证"你要粘贴的那个包"是实际执行过的 |
| **加 App 链路** | 三个自动查询源的解析、元数据补齐、**认不准不硬猜**、查失败与没搜到的区分、`/add` `/apps` `/find` 全流程、加完后关键词进发现过滤 |
| Vercel | 五个入口的鉴权/报错/成功路径；`CRON_SECRET` 放行、**不设时靠 `x-vercel-cron-schedule` 兜底且配了就收紧**；Upstash 读写与坏数据兜底 |

---

## 本地开发

```bash
git clone https://github.com/Review977/tg-tf-monitor && cd tg-tf-monitor
node --test          # 零依赖，用 Node 内置 test runner（需要 Node 20+）
node bench.mjs       # CPU 基准
node cli.mjs selftest  # 联网验证判定逻辑
```

- **不需要 `npm install`** —— 运行时代码零依赖，唯一的 devDependency 是 `wrangler`（只有真的 deploy 时才要）。
- GitHub Actions 会在每次 push 时跑构建 + 测试，并检查
  **`dist/worker.js` 与 `src/` 是否同步**（改了源码忘了重跑 `node build.mjs` 就会红）。
- 改了 `src/` 里的判定逻辑后，**两处样本目录都要能对上**：
  项目内的 `test/fixtures/` 是自包含形态；开发时如果同时存在工作区那套共用样本，
  `test/fixtures-sync.test.mjs` 会检查两边**逐字节一致**，防"拿旧样本验证新逻辑"。

---

## 文件结构

```
SETUP.md           创建 Bot 的完整流程（5 步）
src/core.js        唯一实现：判定 / 解析 / 探针 / 消息 / 命令（平台无关，纯函数可单测）
src/config.js      配置装载（内置默认 = 番茄小说那套，开箱即用）
src/storage.js     存储适配器：CF KV / Upstash Redis / 内存
src/runner.js      编排：跑一轮 / 处理 update / 设 webhook / 体检 / 拿 chat_id
src/worker.js      Cloudflare 入口（fetch + scheduled）
api/*.js           Vercel 入口（telegram / run / health / set-webhook / chat-id）
dist/worker.js     单文件构建产物 —— 粘进 Cloudflare 控制台的就是它
build.mjs          构建（撞名检查 + 语法检查 + export default 唯一性检查）
bench.mjs          CPU 基准
cli.mjs            本地调试 CLI（可选，部署不需要）
test/              116 项测试
```

**逻辑只有一份**：平台差异全部收敛在 `src/worker.js` / `api/*.js` 和 storage 适配器里，
刻意不做两份实现（这个仓库有过"复制式并存必然分叉"的教训）。

---

## 配置（想改监控对象/发现源）

不用改代码，设 `CONFIG_JSON` 环境变量（整段 JSON），会覆盖内置默认值：

```json
{
  "watch": [
    { "code": "dTUO1uyt", "label": "番茄小说 TF 公测", "appStoreId": 1468454200, "departuresId": 16645 }
  ],
  "discovery": { "telegramChannels": ["你的中文内测频道"] },
  "keywords": ["番茄小说"],
  "autoWatchKeywords": ["番茄小说"]
}
```

`keywords` 决定**哪些发现值得推送**；`autoWatchKeywords` 决定**哪些发现自动纳入监控**
（更严 —— 免得"番茄助眠"这种同名 App 被自动盯上）。

---

## 排查

**部署页报红字 `Your GitHub authorization has expired`**
Cloudflare 的 GitHub 授权过期了，与本项目无关。要么去
<https://github.com/settings/installations> 找到 **Cloudflare Workers and Pages** 重新授权，
要么直接走 [A-2 手工粘贴](#a-2-手工粘贴不依赖-github)（不碰 GitHub）。

**TG 里发命令没反应** → 九成是没设 webhook，或设错了地址。
打开 `/` 或 `/health` 看 `webhook.url`；用 `/set-webhook?key=…` 重设。

**Webhook 设了但 `getUpdates` 拿不到 chat_id** → 这是 Telegram 的规则，不是 bug。
先 `/del-webhook?key=…`，发条消息，再 `/chat-id?key=…`。

**每轮都在重复推同一条** → 存储没生效。`/health` 看 `storage.kind`：
Cloudflare 应是 `cloudflare-kv`（检查绑定变量名是否**正好**叫 `STATE`），
Vercel 应是 `upstash-redis`。程序不会静默降级，会直接报错。

**`/run` 返回 403** → 没带 `?key=`，或 `ADMIN_KEY`/`TG_WEBHOOK_SECRET` 都没配
（两个都没配时**一律拒绝**，这是刻意的：不留默认放行的后门）。

**状态卡在「状态未知 ❓」** → Apple 改了站点结构或措辞。
`/status` 或 KV 里 `links.<码>.statusText` 存着这一轮的**状态句原文**，
拿它对照 `parseJoinPage()` 的判据补一条，再把那一页存进 `tg-tf-monitor/tests/fixtures/` 加断言。
