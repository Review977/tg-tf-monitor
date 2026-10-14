# 创建 Bot 全流程（从零到跑起来）

一共 5 步。**不需要装 Node，不需要买服务器，全程免费。**

```
①  BotFather 建 bot，拿 token
②  部署到 Cloudflare（或 Vercel）
③  给 bot 发条消息，拿 chat_id，填回去
④  设 webhook + 注册命令菜单
⑤  验证：在 TG 里发 /status
```

⚠️ **有两个顺序不能反，先记住**：

1. **先拿 chat_id，再设 webhook** —— Telegram 的规则是「设了 webhook 之后 `getUpdates` 就返回空」，
   顺序反了就再也查不到 chat_id（得先撤销 webhook 才行）。
2. **第一次部署至少要填 `TG_TOKEN` 和 `ADMIN_KEY`** ——
   因为拿 chat_id 要访问 `/chat-id` 这个管理端点，而它需要 `ADMIN_KEY`。

---

## ① 在 BotFather 建 bot，拿 token

1. 打开 Telegram，搜索 **`@BotFather`**（认准带蓝色官方认证勾的那个，有很多高仿号）。
2. 点 Start，然后发送：

   ```
   /newbot
   ```

3. 它先问 **name**（显示名，随便起，中文也行，之后能改），例如 `番茄 TF 监控`。
4. 再问 **username**（这是唯一标识，全网唯一，**必须以 `bot` 结尾**，只能字母数字下划线），
   例如 `fq_tf_watch_bot`。被占用它会让你重换一个。
5. 成功后它回一段话，里面有 **token**，长这样：

   ```
   8123456789:AAH3kL9mNpQrStUvWxYz0123456789abcde
   ```

   > 🔑 **这个 token 就是密码。** 别发到群里、别写进代码、别提交到 git。
   > 本项目的 `config.json` / `.dev.vars` / `.env` 都已在 `.gitignore` 里。

**顺手可以做的（可选）**

| 发给 BotFather | 作用 |
|---|---|
| `/setdescription` | 设置 bot 简介 |
| `/setuserpic` | 设置头像 |
| `/setprivacy` | 群组隐私模式。**本项目的命令不依赖它**（见第 ③ 步），不用改 |
| `/mybots` | 管理你的 bot；忘了 token 就从这里找（选 bot → API Token） |
| `/revoke` | token 泄露了就撤销重发 |

---

## ② 部署

### A. Cloudflare（推荐，30 分钟一次）

> 有两条路：**一键按钮**（要授权 Cloudflare 的 GitHub App）和
> **手工粘贴**（不碰 GitHub）。按钮报 `Your GitHub authorization has expired` 时走手工那条，
> 步骤见 README 的「A-2 手工粘贴」。

1. 打开本仓库 README，点 **Deploy to Cloudflare** 按钮。
2. 授权 GitHub —— 它会自动 fork 一份到你账号并建一个 Worker 项目。
3. 它会读 `wrangler.toml`，**自动创建 KV 命名空间并绑定**（变量名 `STATE`），不用你手填 id。
4. 它会读 `.dev.vars.example`，**弹出来问你密钥 —— 只有两项**：

   | 变量 | 填什么 |
   |---|---|
   | `TG_TOKEN` | ✅ 第 ① 步拿到的 token |
   | `ADMIN_KEY` | ✅ **随便敲一串随机字符**（例如 `openssl rand -hex 24` 的输出）。拿 chat_id 要用它 |

   > ⚠️ **只有这两项**，是刻意的：Cloudflare 会把 `.dev.vars.example` 里
   > **每个未注释的项都当必填**。而 `TG_CHAT_ID` 在部署时**根本还不知道**
   > （要先部署完、再调 `/chat-id` 才能拿到），放进必填就是自相矛盾。
   > 所以它被注释掉了，第 ③ 步拿到后**去控制台补**：
   > Worker → `Settings` → `Variables and Secrets` → 加一个 `TG_CHAT_ID`。
   >
   > 同理 `TG_WEBHOOK_SECRET` 也是注释掉的：不设就自动回落到用 `ADMIN_KEY`
   > 做 Webhook 来源校验，够用；想分开再补一个。

5. 部署完成后它会给你一个地址，形如 `https://tg-tf-monitor.<你的子域>.workers.dev`。
   打开它，应该能看到一个自检页，写着「部署顺序」和当前配置状态。

> Cron 已经在 `wrangler.toml` 里配好了（每 30 分钟监控 + 每 6 小时全源发现），不用你动。

### B. Vercel

1. 先建一个免费的 **Upstash Redis**（upstash.com），复制 `REST URL` 和 `REST TOKEN`。
   > Vercel 的函数是无状态的，去重状态必须有地方放。**没配存储程序会明确报错并停下**，
   > 不会静默降级成"每轮重复推送"。
2. 点 README 里的 **Deploy with Vercel** 按钮 → 授权 GitHub → 导入仓库。
3. 填环境变量：`TG_TOKEN`、`ADMIN_KEY`（必填），`TG_WEBHOOK_SECRET`（建议），
   `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`（必填），
   `CRON_SECRET`（建议，见 README 里的说明），`TG_CHAT_ID` 先留空。
4. 部署完地址形如 `https://<项目>.vercel.app`。

> ⚠️ Vercel Hobby 的 cron **每天只能跑 1 次**（写更密会在部署时直接失败）。
> 要 30 分钟一次，用任意免费外部定时器打
> `https://<项目>.vercel.app/api/run?key=<ADMIN_KEY>&mode=all`。

---

## ③ 拿 chat_id，填回去

**先给 bot 发一条消息**（不然 `getUpdates` 里什么都没有）：

- **私聊**：搜索你刚起的 bot 用户名 → 点 Start，随便发一句。
- **群**：把 bot 拉进群，然后在群里发
  ```
  /status@<你的bot用户名>
  ```
  > ⚠️ **为什么群里要带 `@`**：bot 在群里默认处于**隐私模式**，普通群消息不会送给它，
  > 只有明确发给它的命令才会。带上 `@用户名` 就一定送到，不用改任何设置。
  > （`/chat-id` 会把你的隐私模式状态一并报出来，并给对应的操作指引。）

然后打开：

```
https://<你的地址>/chat-id?key=<ADMIN_KEY>
```

（Cloudflare 是 `/chat-id`，Vercel 是 `/api/chat-id`）

它会列出所有会话：

```
chat_id: -1001234567890    supergroup / 我的群
chat_id: 5551234567        private / 我
```

- **群**是负数（`-100…`），**私聊**是正数。
- 复制你要用的那个数字，回到平台控制台填进 **`TG_CHAT_ID`**。

**填完要让它生效**：

| 平台 | 怎么做 |
|---|---|
| Cloudflare | 在 `Settings` → `Variables and Secrets` 里**新增** `TG_CHAT_ID`（部署表单里没有这项），保存即可 |
| Vercel | 在环境变量里加上 `TG_CHAT_ID`，然后**必须重新部署**（环境变量是部署时注入的） |

> 万一你已经在别处填了个占位的 `TG_CHAT_ID`（比如 `0`），程序会把它当成"未配置"
> 并明确告诉你去拿真值 —— 不会把消息发到 chat 0 然后报一个看不懂的错。

---

## ④ 设 webhook + 注册命令菜单

浏览器打开这两条（把 key 换成你的 `ADMIN_KEY`）：

```
https://<你的地址>/set-webhook?key=<ADMIN_KEY>
https://<你的地址>/set-commands?key=<ADMIN_KEY>
```

- `/set-webhook` 把 Telegram 的推送地址指到你的部署。
  **这一步之前 bot 收不到任何命令。**
- `/set-commands` 把命令菜单注册到 Telegram ——
  之后在 TG 输入框打 `/` 就会列出全部命令，不用去 BotFather 手敲。

两条都应该返回 `OK …`。

---

## ⑤ 验证

在 TG 里给 bot 发：

```
/status
```

有回复就通了。再试几个：

| 命令 | 预期 |
|---|---|
| `/status` | 列出当前监控的链接与状态 |
| `/apps` | 列出监控中的 App 各自盯了什么 |
| `/find 微信读书` | 三路并搜，给出 App Store id 与 tfstore 上的 TF 码 |
| `/add <TestFlight链接>` | 加一个 App 进监控，元数据自动补齐 |
| `/test` | 一条测试消息 |

也可以直接开浏览器看体检：

```
https://<你的地址>/health
```

它会报告：配置是否齐、存储是否通、webhook 是否设好、**还差哪些建议项**。

---

## 常见问题

**发命令没反应**
九成是 webhook 没设或设错。打开 `/` 或 `/health` 看 `webhook.url`；
用 `/set-webhook?key=…` 重设。

**`/chat-id` 返回空**
- 还没给 bot 发过消息 → 先发一条。
- **顺序反了**（先设了 webhook）→ 先 `/del-webhook?key=…`，再发消息，再查。
- 群里拿不到 → 群里要发 `/status@<你的bot用户名>`（见第 ③ 步）。

**管理端点返回 403**
没带 `?key=`，或者 `ADMIN_KEY` 和 `TG_WEBHOOK_SECRET` 都没配。
两个都没配时**一律拒绝**，这是刻意的（不留默认放行的后门）。

**每轮都在重复推同一条**
存储没生效。`/health` 看 `storage.kind`：
Cloudflare 应是 `cloudflare-kv`（检查 KV 绑定变量名是否**正好**叫 `STATE`）；
Vercel 应是 `upstash-redis`。

**Vercel 的定时没跑**
Hobby 只能每天一次。看 `/health` 的 `notes`，它会明确告诉你
`CRON_SECRET` 有没有设、以及不设的后果。

**状态卡在「状态未知 ❓」**
Apple 改了站点结构或措辞。`/status` 里存着这一轮的**状态句原文**，
按 README 的「排查」一节把那一页存进 `test/fixtures/` 加断言即可。

---

## 一句话回顾顺序

```
建 bot 拿 token
   → 部署（填 TG_TOKEN + ADMIN_KEY）
      → 给 bot 发消息（群里带 @）
         → /chat-id 拿数字 → 填 TG_CHAT_ID → 重新部署
            → /set-webhook → /set-commands
               → 在 TG 里发 /status ✅
```
