# tg-tf-monitor

盯 **TestFlight 公测链接**的 Telegram 机器人 —— **任何 App 都能加**，**无服务器版**。
部署到 Cloudflare Workers 或 Vercel，不用自己开机器、不用一直挂着。
内置默认盯的是**番茄小说**（开箱即用）；换成别的 App **不用改代码**，在 TG 里发 `/add <名字>` 就行。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Review977/tg-tf-monitor)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FReview977%2Ftg-tf-monitor&env=TG_TOKEN,TG_CHAT_ID,TG_WEBHOOK_SECRET,ADMIN_KEY,UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN&envDescription=TG_TOKEN%20%E4%BB%8E%20%40BotFather%20%E6%8B%BF%EF%BC%9BTG_CHAT_ID%20%E7%94%A8%20%2Fchat-id%20%E7%AB%AF%E7%82%B9%E6%9F%A5%EF%BC%9B%E4%B8%A4%E4%B8%AA%E9%9A%8F%E6%9C%BA%E4%B8%B2%E7%94%A8%20openssl%20rand%20-hex%2024%20%E7%94%9F%E6%88%90%EF%BC%9BUpstash%20%E4%B8%A4%E9%A1%B9%E4%BB%85%20Vercel%20%E9%9C%80%E8%A6%81&project-name=tg-tf-monitor&repository-name=tg-tf-monitor)

它干什么：

- **盯链接状态** —— 名额满了 / 又能进了 / 链接失效 / 开发者换了新 join 码，都推 TG
- **找新链接** —— 从 departures.to、tfstore、搜索引擎、TG 频道里搜新的 join 码，一出现就告诉你
- **盯正式版** —— 绑了 App Store id 的 App，正式版发新版也提醒（TF 构建号 Apple 不公开，看不到）
- **在 TG 里管 App** —— `/find` 查、`/add` 加（按名字加也行：当时没有链接也能先把这个 App 记下）、
  `/apps` 看每个 App 都盯了什么、`/del` 移出
- **静音** —— `/joined` 标记「我已上车」：不再提醒那条链接的状态来回，但这个 App **有新链接照样告诉你**

> 它盯的是「**join 码 + App**」，不是「番茄小说」：默认配置、关键词、发现源都在 `src/config.js`
> （或用 `CONFIG_JSON` 环境变量整体覆盖），见下面的「配置」一节。

> 🚀 **第一次用请看 [SETUP.md](SETUP.md)** —— 从在 BotFather 建 bot 到跑起来，一共 5 步，
> 含两个**不能反的操作顺序**（先拿 chat_id 再设 webhook；首次部署要填 ADMIN_KEY）。
> 下面的一键部署只是其中第 ② 步。

---

## 一键部署

**Cloudflare（推荐，30 分钟一次）** —— 点上面的按钮，然后：

1. 授权 GitHub，它会**自动 fork 一份到你账号**并创建一个 Worker 项目
2. 它会读 `wrangler.jsonc`，**自动建好 KV 命名空间并绑定**（变量名 `STATE`），不用你手填 id
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

| | A-1 一键按钮 | A-2 导入仓库 | A-3 手工粘贴 |
|---|---|---|---|
| 怎么工作 | CF 把仓库**克隆一份**到你账号 | 直接连你**已有的**仓库 | 你把代码粘进编辑器 |
| 要 GitHub 吗 | ✅ 要 App 授权 | ✅ 用你账号**已有的** Git 集成 | ❌ **完全不用** |
| 自动部署 | ✅ 推送即部署 | ✅ 推送即部署 | ❌ 改了要重新粘 |
| 建 KV / 填密钥 | 自动弹出来问你 | 要先把真实 KV id 写进 `wrangler.jsonc` | 自己点几下 |
| 什么时候选它 | 一切顺利时 | **A-1 报「无法获取存储库内容」时**（它不用克隆，所以不卡那一步） | A-1/A-2 都不顺时 |

---

### A-1 一键按钮

点 README 顶部的 **Deploy to Cloudflare** 按钮，它会：

1. 让你授权 GitHub，然后 **fork 一份到你账号**并建 Worker 项目
2. 读 `wrangler.jsonc` → **自动建 KV 并绑定**（变量名 `STATE`）
3. 读 `.dev.vars.example` → **弹出来问密钥，只有两项**：`TG_TOKEN` 和 `ADMIN_KEY`

> ⚠️ **为什么只有两项**：Cloudflare 会把 `.dev.vars.example` 里**每个未注释的项都当必填**，
> 而 `TG_CHAT_ID` 在部署时**还不知道**（要先部署完、调 `/chat-id` 才能拿到）——
> 放进必填就自相矛盾、直接卡住部署。所以它和 `TG_WEBHOOK_SECRET` 都被注释掉了：
> - `TG_CHAT_ID`：第 ③ 步拿到后去 `Settings` → `Variables and Secrets` 补
> - `TG_WEBHOOK_SECRET`：不设就回落到用 `ADMIN_KEY` 做 Webhook 来源校验，够用

⚠️ **如果它报红字** —— 下面两种都是 Cloudflare 侧的 GitHub 连接问题，跟本项目无关
（仓库侧已核实：公开、匿名 `git clone` 成功、根目录有 `wrangler.jsonc`，满足官方文档全部前置要求）：

| 报错 | 含义 |
|---|---|
| `Your GitHub authorization has expired` | Cloudflare 的 GitHub 授权过期 |
| `无法获取存储库内容。` | Cloudflare 读不到仓库 —— 通常是那个 App **没被授权访问这个仓库** |

**先试这个（30 秒）**：

1. 打开 <https://github.com/settings/installations>
2. 找到 **Cloudflare Workers and Pages** 这个 App（官方文档里的名字，
   App 页在 <https://github.com/apps/cloudflare-workers-and-pages>）
3. 点 `Configure` → 看 **Repository access**
   —— 如果选的是 `Only select repositories`，确认 **`tg-tf-monitor` 在里面**；
   这个仓库是新建的，很可能没被勾上
4. `Save` → 回部署页重试

> 实在不想折腾：**直接走下面的 A-2 手工粘贴**，那条路完全不碰 GitHub，
> 而且不需要 Cloudflare 读你的仓库。

---

### A-2 导入仓库（用你账号已有的 Git 集成，推荐）

> **为什么这条能绕过 A-1 的报错**：A-1 的流程是「把源仓库**克隆一份**到你账号」，
> `无法获取存储库内容。` 就出在这一步。而这条是**直接连你已有的仓库**，不需要克隆。
> 如果你账号里已经有别的 Worker 连着 Git（比如某个反代 Worker），说明这条集成是通的。

1. 先去 **Storage & Databases → KV → Create namespace**，建好后**复制它的 ID**
2. 把这个 ID 填进仓库根目录的 `wrangler.jsonc`，替换掉 `kv_namespaces` 里那串
   `00000000000000000000000000000000`
   —— 可以在 GitHub 网页上直接改（打开文件 → 铅笔图标 → 粘贴 → Commit）
3. 控制台 → `Workers & Pages` → `Create application`
4. 找到 **`Import a repository`**（导入仓库）→ 点旁边的 `Get started`
5. 在 **`Git account`** 里选你的 GitHub 账号 → 从列表里选 `tg-tf-monitor`
   > ⚠️ **不要**走下面那个「通过 Git URL 克隆公共存储库」—— 那是 A-1 按钮那条路
   > （要克隆仓库），也正是会报 `无法获取存储库内容。` 的那条。
6. 配置项目 → `Save and Deploy`
   > ⚠️ **Worker 名字必须填 `tg-tf-monitor`**，与 `wrangler.jsonc` 里的 `name` 一致。
   > 不一致会在构建时报
   > `The name in your Wrangler configuration file (<name>) must match the name of your Worker`
   > （CF 官方排错文档里列的第一条已知问题）。
   > 构建/部署命令接受 CF 自动预填的即可。
7. 之后每次 push 都会自动重新部署

> ⚠️ 这条路的 KV 绑定来自 `wrangler.jsonc`，所以**必须**先把真实 id 写进去；
> 留占位符会在构建时报找不到命名空间。

---

### A-3 手工粘贴（不依赖 GitHub，也不依赖任何 Git 集成）

**1. 建 KV 命名空间**
控制台 → `Storage & Databases`（存储与数据库）→ `KV` → `Create namespace`，
名字随便（如 `tfmon-state`）。
> 建好后**复制它的 ID** —— A-2 那条路要用（A-1 按钮那条会自动建，不用管）。

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
| `TG_TOKEN` | ✅ 部署时必须 | @BotFather 发的 token |
| `ADMIN_KEY` | ✅ 部署时必须 | 随机长串。保护 `/run` `/set-webhook` `/chat-id` `/set-commands`，并兼作 Webhook 来源校验。⚠️ **只用 `A-Z a-z 0-9 _ -`**（Telegram 对 `secret_token` 的字符集有硬要求），建议 `openssl rand -hex 24`：含 `! # + / =` 会被 Telegram 400 拒掉，webhook 设不上、bot 收不到任何命令 |
| `TG_CHAT_ID` | ⬜ **部署后再加** | 目标会话 id（拿法见下）。部署时还不知道，所以不在部署表单里。⚠️ **类型必须选「密钥 / Secret」**，理由见下 |
| `TG_WEBHOOK_SECRET` | ⬜ 可选 | 想给 Webhook 单独一把密钥再设；不设则用 `ADMIN_KEY` |
| `TIMEZONE` | ⬜ 可选 | 消息里时间的时区，默认 `Asia/Shanghai`。见下 |

> ⚠️ **`TG_CHAT_ID` 一定要选「密钥（Secret）」类型，不要选「变量」。**
> 普通「变量」在重新部署时可能被 `wrangler deploy` 覆盖掉（因为绑定以仓库里的
> `wrangler.jsonc` 为准，而它没有 `vars`），结果就是**重新部署后 bot 突然不回复了**。
> 「密钥」是单独存的，不受部署影响。
> 真遇到了也不至于抓瞎：没配 `TG_CHAT_ID` 时 bot 会**直接回你一条诊断**，
> 并把它看到的 chat_id 告诉你（见下「重新部署后 bot 不回复」）。

> ⏰ **时间显示**：serverless 没有"本地时间" —— Worker 跑在 Cloudflare 边缘节点上，
> `Date` 默认就是 **UTC**，不配就会显示成差 8 小时的时间。
> 所以默认配了 `Asia/Shanghai`；要改就设 `TIMEZONE`（IANA 名，能处理夏令时），
> 或者 `UTC_OFFSET_MINUTES`（固定偏移，如 `480`）。
> `Intl` 时区数据不可用时会**自动退回固定偏移**，宁可少一点夏令时支持，也不会把时间显示错。
> `/status` 抬头会标明当前用的时区。
> 存储里一律是 **UTC 时间点**（ISO），显示时才转成配置的时区 ——
> 所以改时区、或读到旧版本写下的数据，显示都不会错乱。

随机串生成：本地跑 `openssl rand -hex 24`（**别用 `-base64`** —— 它带 `+ / =`，而 Telegram 的 `secret_token` 只收 `A-Z a-z 0-9 _ -`）。

> 这里**只加 `TG_TOKEN` 和 `ADMIN_KEY`**。`TG_CHAT_ID` 现在还不知道，
> 等第 6 步拿到再加。

**6. 加两条定时任务**
Worker → `Settings` → `Triggers` → `Cron Triggers` → 加：

```
*/30 * * * *      每 30 分钟：只监控
5 */6 * * *       每 6 小时：监控 + 全源发现
```

**7. 打开自检页确认**
浏览器开 `https://<你的worker>.workers.dev/` —— 应看到一个文本页，
列出配置 / 存储 / Webhook 状态和下一步该做什么。
若显示存储不可用，就是第 4 步的绑定变量名没写对（必须是 `STATE`）。

**8. 之后回到 [SETUP.md](SETUP.md) 第 ③ 步**：
给 bot 发消息 → `/chat-id?key=<ADMIN_KEY>` 拿 chat_id →
加到 `Variables and Secrets` → `/set-webhook?key=` → `/set-commands?key=` → TG 里发 `/status`。

**6. 加定时任务**
Worker → `Settings` → `Triggers` → `Cron Triggers` → 加两条：

```
*/30 * * * *      ← 每 30 分钟：只监控（省事）
5 */6 * * *       ← 每 6 小时：监控 + 全源发现
```

> 第二条的表达式要和代码里 `cron.discovery` 一致（默认就是 `5 */6 * * *`）——
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
| `/find <名字>` | 按名字**查** TF 链接（**只查，不改监控列表**）：三路并搜，列出码 + 状态 + departures id |
| `/add <名字>` | 按名字**加进监控**：自己找链接、自己挑「能进」的那个码；**现在没有链接也能加**（记下这个 App，等出现了主动提醒） |
| `/joined <名字或码>` | 标记「我已上车」→ **之后不再提醒**它（状态照样更新） |
| `/unjoined <名字或码>` | 恢复提醒 |
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
✅ 已加入监控：微信读书 — 已满员 ⛔
https://testflight.apple.com/join/5MWjLpYl
App Store：952059546（com.tencent.weread） 自动匹配
departures.to：21038 自动匹配
发现关键词：微信读书 / com.tencent.weread

会被盯：链接状态、App Store 正式版号、departures.to 链接轮换；/scan 时按它的关键词找新链接。
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

## `/add` 与 `/find` 的分工

| | 做什么 | 改监控列表吗 |
|---|---|---|
| `/find <名字>` | **查**：三路并搜，列出码 + 状态 + departures id | ❌ 只查 |
| `/add <名字>` | **加**：查完就加，自己挑「能进」的那个码 | ✅ |
| `/add <链接/码>` | 手上有链接时直接用 | ✅ |
| `/add dep=<id>` | 只有 departures 的 app id 时（会反解出 TF 码） | ✅ |

`/add <名字>` 的两个防呆：

- **名字有歧义时不替你猜** —— `/add 微信` 会匹配到「微信读书」和「微信输入法」，
  这时它会**列出候选**让你选，而不是擅自加一个（猜错会让你盯上一个完全不相干的 App）
- **同一个 App 有多个码时挑「能进」的那个**（可加入 > 已满员 > 已关闭 > 失效），
  并在回复里告诉你还有哪些码可以一起盯

两个命令**共用同一套搜索逻辑**（`lookupByName()`），所以不会出现
「`/find` 搜得到、`/add` 搜不到」这种不一致。

### 两类监控：链接级 vs App 级

| | 怎么加 | 盯什么 |
|---|---|---|
| **链接级** | `/add <链接或码>` | 这一条链接的状态（可加入/满员/关闭/失效） |
| **App 级** | `/add <名字>` | 这个 App —— **现在没有可用链接也能加**，等发现源里出现可加入的链接就主动告诉你 |

App 级监控是"我关心这个 App，有链接就告诉我"；链接级是"我手上有这条链接，帮我盯着"。
`/add <名字>` 如果当场就找到了链接，会**顺手挂上**（等于两级一起建）。

### 🔕 已上车的 App 不用再听提醒

机器人**不知道你有没有上车** —— 所以默认只要状态变了就会提醒。
上完车之后发一次：

```
/joined 番茄小说
```

之后这个 App 的**链接状态变化、App Store 版本更新都不再提醒**（状态照样更新，`/apps` 里能看到）。
想恢复就 `/unjoined 番茄小说`。

> 这条很实用：一个 App 你只会上车一次，之后它"满员 → 又能进 → 又满员"的来回对你毫无意义。

**`/joined` 到底静音了什么**（边界要清楚，不然会漏信息）：

| 事件 | 标记「已加入」后 |
|---|---|
| 那条链接的状态来回（满员 ↔ 又能进） | 🔕 不提醒（状态照样更新，`/apps` 里能看到） |
| 那个 App 的 App Store 正式版更新 | 🔕 不提醒 |
| **发现了这个 App 的新链接** | 🔔 **仍然提醒** |
| 新链接被自动加入后，它自己的状态来回 | 🔕 一并静音（继承同 App 的标记） |

**为什么新链接仍然提醒**：`joined` 压的是**噪音**（同一条链接来回变），
不是**信息**（出现了新链接）。把后者也压掉，用户就会因为静音而漏掉真东西。

> 新链接靠 `/scan` 发现（默认每 6 小时一次）。想立刻查一次就手动发 `/scan`。

### 怎么确认「改的东西部署上了没有」

打开 `/health`（**不需要 key**），里面有一个 `features` 列表：

```json
{ "ok": true, "features": ["app-level-watch", "joined-mute", "dep-add",
  "name-decision-offline", "tz-local", "human-time"], "checks": { ... } }
```

有对应标签就说明那个版本已经部署上了。

**为什么要这个东西**：我们反复遇到"改了但不确定生效没有"——
用户看到的旧行为可能是 ①部署没成功 ②部署了但依赖的外部接口挂了。
有一个可查的标记就不用猜。（加新功能时顺手往 `FEATURES` 里补一条。）

## 输出长什么样

版式原则：**每条信息只出现一次，静态内容不进消息**（静态说明放 `/help`，
命令菜单靠 Telegram 的 `/` 列表，不靠页脚提示）。

```
/apps                                /status
监控中的 App（1 个）                  tg-tf-monitor 当前状态 · Asia/Shanghai（UTC+8）
                                     上次监控 3 分钟前 ｜ 上次发现扫描 2 小时前
1. 番茄小说 TF 公测 — 可加入 ✅
   https://testflight.apple.com/…    · 番茄小说 TF 公测 可加入 ✅
   正式版 7.3.9（09-30 上架，14 天前）  https://testflight.apple.com/…
   ｜ App Store 1468454200            正式版 7.3.9（09-30 上架，14 天前）
   ｜ departures 16645                状态已保持 3 分钟
   加入 2026-10-14 16:17
```

具体几条规则：

- **链接和 join 码只留一个** —— 码就是链接的一部分
- **时间用相对说法**（"3 分钟前"）—— 状态页要回答的是"它还活着吗"
- **`departures.to` 只在和我们的判断不一致时显示** —— 一致时它不提供信息
- **静态的"公测页测试说明"不进消息** —— 每次都一样；**变了才意味着有信息**（那已经有告警）
- **TF 构建号拿不到这件事写在 `/help`**，不每次刷屏

## 诚实的能力边界

### ❌ 看不到 TF 构建号（TestFlight 里的版本/build）

这不是偷懒，是**公开渠道真的没有**。2026-10-14 从五个方向逐一验过：

| 查的地方 | 结果 |
|---|---|
| 公测页正文 | 只有 Apple 的通用帮助文案，**无版本号** |
| 公测页响应头 | **无 `ETag` / `Last-Modified`**（只有 `Cache-Control: max-age=600`）——连"变了没"都推不出来 |
| Apple 公开接口（探了 `/v1/app/`、`/v1/apps/`、`/v1/join/`、`/join/<code>.json`、`/api/v1/apps/`） | **全部 404** |
| departures.to / tfstore.top | 只给"开放 / 已满"状态，**不给版本号** |
| `itunes.apple.com/lookup` | 只给 **App Store 正式版号**（≠ TF 构建号） |

**而且这件事 Apple 已经替你覆盖了**：装了 TF 版之后，开发者每推一个新构建，
**TestFlight 自己会推通知**，版本号也在 App 里看得到。机器人抢不过它，也不用抢。

**所以机器人在消息里给你的是能拿到的全部**：

- **App Store 正式版号 + 上架日期 + 距今几天** —— 正式版一升，TF 上通常就在测这个新版本（或更高的 beta）
- **公测页的"测试说明"原文** —— 有些开发者会把版本号/更新内容写在这里，那就等于间接拿到了
- **公测页文案指纹变化**告警
- **链接状态**（可加入 / 已满 / 已关闭 / 失效）—— 这才是 Apple 不通知你的那部分

`/status` 里也会直接写一行说明，免得每次重新疑惑一遍。
- ❌ 不知道你的 SVIP 还剩几天（账号权益，只能在 App 里看）。
- ⚠️ 发现源都有滞后，所以**第一手判定永远是直接轮询 Apple**，发现源只用来找新码。

---

## 验证（都能自己复现）

```bash
node build.mjs        # 拼出 dist/worker.js（会检查撞名 + 语法 + export default 唯一）
node --test           # 134 项测试
node bench.mjs        # CPU 基准（回答"10ms 够不够"）
node cli.mjs selftest # 联网：拿 4 个已知状态的 join 码验证判定
node cli.mjs find 微信读书   # 联网：试 /find
node cli.mjs add <链接>     # 联网：试 /add 的元数据自动补齐
node cli.mjs check    # 联网：真实跑一轮（默认只打印不发）
```

测试覆盖（**134 项全过**）：

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
src/config.js      配置装载（内置默认 = 盯番茄小说；换 App 不用改代码，见「配置」一节）
src/storage.js     存储适配器：CF KV / Upstash Redis / 内存
src/runner.js      编排：跑一轮 / 处理 update / 设 webhook / 体检 / 拿 chat_id
src/worker.js      Cloudflare 入口（fetch + scheduled）
api/*.js           Vercel 入口（telegram / run / health / set-webhook / chat-id）
dist/worker.js     单文件构建产物 —— 粘进 Cloudflare 控制台的就是它
build.mjs          构建（撞名检查 + 语法检查 + export default 唯一性检查）
bench.mjs          CPU 基准
cli.mjs            本地调试 CLI（可选，部署不需要）
test/              134 项测试
```

**逻辑只有一份**：平台差异全部收敛在 `src/worker.js` / `api/*.js` 和 storage 适配器里，
刻意不做两份实现（这个仓库有过"复制式并存必然分叉"的教训）。

---

## 配置（想改监控对象/发现源）

**先说最省事的两条路**（都不用改代码）：

1. **在 TG 里加**：`/add <App名字>` —— 它自己去搜这个 App 的 TF 链接并加进监控；
   当时还没有公开链接也能先记下，之后一出现就告诉你。新加的 App 的关键词会自动进发现过滤集，
   所以 `/scan` 不会还只按番茄那套词找。`/del <码或名字>` 移出。
2. **改环境变量**：设 `CONFIG_JSON`（整段 JSON），会覆盖内置默认值 ——
   适合"换掉内置的番茄小说默认配置、改成自己那一套"：

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

> 内置默认值（`src/config.js` 的 `DEFAULT_CONFIG`）就是上面这套 —— 盯番茄小说。
> 它只是**默认值**：`watch` 换成别的码、`keywords` 换成别的词，机器人就完全不管番茄了。

`keywords` 决定**哪些发现值得推送**；`autoWatchKeywords` 决定**哪些发现自动纳入监控**
（更严 —— 免得"番茄助眠"这种同名 App 被自动盯上）。

---

## 排查

**部署页报红字 `无法获取存储库内容。` / `Your GitHub authorization has expired`**

### 先理解为什么会「时好时坏」

**GitHub App 的 user access token 默认 8 小时就过期**（GitHub 官方文档原文：
*By default, the user access token expires after 8 hours*；`expires_in` 恒为 `28800` 秒）。

这解释了一个很反直觉的现象：**同一个按钮，第一次点能读到仓库、过一会儿再点就读不到了。**
因为：

| 什么时候 | 用的是哪种令牌 | 会不会过期 |
|---|---|---|
| **已有的构建连接**（比如你那个反代 Worker 的自动部署） | GitHub App 的 installation token，CF 服务端自动续 | ❌ 不受影响 |
| **用户发起的流程**（部署按钮、新连一个仓库） | GitHub App 的 **user** token（`ghu_…`） | ✅ **8 小时过期** |

所以：

- 你账号上的 Git 集成「是好的」（反代 Worker 照常部署）**和**「部署按钮读不到仓库」**并不矛盾** —— 两者用的不是同一种令牌。
- **「Repository access 设成 All repositories」不会有帮助** —— 仓库权限从来不是变量，令牌才是。
- 这条路**本身就会时不时失灵**，不是你的配置问题。

### ⚠️ 先分清你是哪种情况（打开两个标签页看一眼）

打开 <https://github.com/settings/applications>，**两个标签页分别是什么状态**决定怎么办：

| `Installed GitHub Apps` | `Authorized GitHub Apps` | 含义 | 怎么办 |
|---|---|---|---|
| 有 Cloudflare | 有 Cloudflare | 安装与授权都在，授权多半只是过期 | 按下面「只撤销授权」做 |
| 有 Cloudflare | **没有 Cloudflare** | **只有安装、缺用户授权** —— 用户发起的流程全用不了 | 去 CF 用 **`+ Add account`** 补授权（见下） |
| 没有 | — | 连安装都没了 | 已有项目的自动部署其实早已断；需重装 App（先确认没有别的项目在用） |

> **为什么会「只有安装、没有授权」**：CF 一开始给你装 App 时，如果没走完
> "Install **& Authorize**" 的后半段，或者那把用户令牌长期没用被回收，
> 就会是这个状态。反代这类 Worker 的自动部署走**安装**侧的服务端令牌，
> 所以它一直正常；而部署按钮、新连仓库这类**用户发起**的流程走**授权**侧，就点不动。

#### 情况「有安装、没授权」的修法

这是最容易被误判的一种：**`Installed` 里有 Cloudflare，`Authorized` 里没有。**
含义是 CF 能读你的仓库（靠安装），但**不能代你行事**（缺授权）——
所以已有 Worker 的构建正常，而**部署按钮、新连仓库这类用户流程全用不了**。

**按顺序试：**

1. **让 CF 重新发起一次授权**（不卸载，最优先）：
   Cloudflare 控制台 → `Workers & Pages` → `Create application` →
   找到 **`Import a repository`** → `Get started` →
   `Git account` 那里点 **`+ Add account`** → 选你的 GitHub 账号 → **`Install & Authorize`**
   > 这一步就是产生"授权"那半边的动作（CF 官方文档里的原文就是
   > *Select the `+ Add account` button… then select `Install & Authorize`*）。
   > 补上授权、复用已有安装，**不会卸载任何东西**。

2. **如果它不让你重新授权**（账号已在列表里、没有 `+ Add account` 或点了没反应）——
   说明 CF 认为自己已经有连接，只是那条记录坏了。这时**别硬试**，直接走
   [A-3 手工粘贴](#a-3-手工粘贴不依赖-github也不依赖任何-git-集成)：
   它完全不碰 GitHub 授权，**不受这类问题影响**。

3. **只有在你能接受"已有 Worker 暂时失去自动部署"时**，才考虑 CF 官方那套
   完整卸载重装（重装后把仓库重新授权给那些项目即可恢复）。

> 💡 **判断依据**：如果你已经为这个按钮折腾了好几轮，**A-3 手工粘贴是更划算的选择** ——
> 8 次点击、不依赖任何 GitHub 授权、一次配好永久有效。这个机器人你只需要部署一次。

### 情况「有安装、也有授权」的修法：只撤销「授权」，别动「安装」

GitHub 把这两件事**分开**，官方文档写得很清楚：

| | 是什么 | 怎么处理 |
|---|---|---|
| **授权**（Authorization） | 让 App **代你行事** —— 就是那把 8 小时过期的 user token | **只撤销它**，可随时重新授权 |
| **安装**（Installation） | App 能访问哪些仓库 —— 已有 Worker 的构建靠它 | **不要动** |

> 文档原文：*The **authorization** can only be revoked by the person who authorized the
> GitHub App… However… owners can **uninstall** the GitHub App from the account* ——
> 两者独立，撤销授权**不会**卸载 App。

**所以按这个顺序做：**

1. 打开 <https://github.com/settings/applications> →
   **`Authorized GitHub Apps`** 标签页
2. 找到 **Cloudflare Workers and Pages** → 点 **`Revoke`**
   （这一步只是把 CF 手里那把过期令牌作废，**安装不受影响**，
   你已有的 Worker 构建照常）
3. 回部署页**再点一次按钮** —— 这次 CF 手里没有授权了，
   它必须让你重新走一遍 GitHub 授权页 → 你就拿到一把**新的 8 小时令牌** → 按钮恢复正常
4. 如果按钮仍然不弹授权页（CF 可能缓存了账号）：
   去 `Create application` → `Import a repository` → 点 **`+ Add account`**
   重新走一次授权（这是 CF 官方文档里的重装步骤里那一步，它本身不卸载）

**或者干脆绕开这条路：**

- [A-2 导入仓库](#a-2-导入仓库用你账号已有的-git-集成推荐) —— 用你账号已有的集成
- [A-3 手工粘贴](#a-3-手工粘贴不依赖-github也不依赖任何-git-集成) ——
  **完全不碰 GitHub，不受令牌过期影响，配一次永久有效。**
  只部署一次的机器人，这条最省心（代价是以后改了要重新粘一次）

> 🛑 **别急着卸载 App。**
> 官方文档写明：*removing access to GitHub will **disable new builds** for Workers and Pages
> projects that were connected to those repositories, though your previous deployments
> will continue to be hosted*。
> 也就是说 —— **如果你账号里已经有别的 Worker / Pages 项目连着 Git
> （比如某个反代、图床之类的 Worker），卸载会让它以后推代码不再自动部署。**
> 先把这条排除掉，再考虑卸载。

按**成功率**试：

1. **走 [A-2 导入仓库](#a-2-导入仓库用你账号已有的-git-集成推荐)** ——
   它不用克隆仓库，所以不卡在报错那一步；而且用的就是你账号里已经能用的 Git 集成。
2. **走 [A-3 手工粘贴](#a-3-手工粘贴不依赖-github也不依赖任何-git-集成)** ——
   完全不碰 Git，**确定能成**。
3. **确认仓库访问权限**：<https://github.com/settings/installations> →
   **Cloudflare Workers and Pages** → `Configure` → **Repository access** 含 `tg-tf-monitor`。
4. **检查是不是有多个 Cloudflare 账号**：CF 文档明确写过
   *A GitHub account should only point to one Cloudflare account*。
5. **最后才考虑卸载重装**（官方对 Git integration issues 的标准处置）——
   **优先用上面那个「只撤销授权」的办法，它不会影响已有 Worker**。
   确实要卸载时，**务必先确认没有别的项目在用这个 App**：
   同一个 `Configure` 页 → `Uninstall "Cloudflare Workers and Pages"` → 回 dash →
   `Create application` → `Pages` → `Connect to Git` → `+ Add account` → `Install & Authorize`。

**怎么确认不是仓库的问题**（一条命令）：
```bash
git ls-remote https://github.com/Review977/tg-tf-monitor
```
能列出 `refs/heads/main` 就说明任何人（包括 Cloudflare）都能匿名克隆它。

Cloudflare 的 GitHub 授权过期了，与本项目无关。要么去
<https://github.com/settings/installations> 找到 **Cloudflare Workers and Pages** 重新授权，
要么直接走 [A-3 手工粘贴](#a-3-手工粘贴不依赖-github也不依赖任何-git-集成)（不碰 GitHub）。

**重新部署后 bot 突然不回复了**（之前能用）
九成是 **`TG_CHAT_ID` 被这次部署清掉了** —— 它多半是以「变量」而不是「密钥」加的，
而绑定以仓库里的 `wrangler.jsonc` 为准（里面没有 `vars`），于是普通变量被覆盖。

先看体检页（**不需要 key**）：`https://<你的worker>.workers.dev/health` ——
它会明确列出"缺 telegram.chatId"。

修法：控制台 → 你的 Worker → `Settings` → `Variables and Secrets` → 加
`TG_CHAT_ID`，**类型选「密钥 / Secret」**。

> 💡 没配 `TG_CHAT_ID` 时，bot 会**主动回你一条诊断**并附上它看到的 chat_id，
> 不会像以前那样静默什么都不发。

**`/status` 里的「上次监控」一直不动**（自动监控没跑）
Cron 没生效。去 Worker → `Settings` → `Triggers` → **`Cron Triggers`** 看那两条在不在：
`*/30 * * * *` 和 `5 */6 * * *`。不在就手动加上。
（走 A-3 手工粘贴那条路的话**必须手动加**；走 A-2 导入仓库的话由 `wrangler.jsonc`
里的 `triggers.crons` 带上去，正常会自动有。）

想立刻确认整条链路通不通，可以先手动跑一轮：
`https://<你的worker>.workers.dev/run?key=<ADMIN_KEY>` —— 跑完 `/status` 的「上次监控」应该变成刚刚。

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
