# 页面样本（fixtures）来源说明

> ⚠️ **这批样本是"本地版 + 云版"共用的**，改判定逻辑时两边都要跑：
> - 本地版（Python）：`tg-tf-monitor/tests/test_classify.py`
> - 云版（JS）：`tg-tf-monitor-cloud/test/core.test.mjs`
>
> 两个测试套件都直接读本目录。共用是刻意的 —— 只存一份样本，
> 两份实现的判定才不会各自漂移。

这 6 个文件是 **2026-10-14 从 testflight.apple.com 真实抓下来的页面**，
用于确定性断言（不发网络请求）。

| 文件 | 来源 join 码 | 抓取时的实际状态 | 语言 |
|---|---|---|---|
| `open_zh.html` | `dTUO1uyt`（番茄小说 TF 公测） | 可加入 | 中文 |
| `open_en.html` | `dTUO1uyt` | 可加入 | 英文 |
| `full_zh.html` | `XgaxaRtd`（T3 Code） | 已满员 | 中文 |
| `full_en.html` | `XgaxaRtd` | 已满员 | 英文 |
| `closed_zh.html` | `yb2xm7Ej` | 已关闭 | 中文 |
| `closed_en.html` | `yb2xm7Ej` | 已关闭 | 英文 |

## 为什么要存两份语言

**Apple 按 IP 定位决定页面语言，改 `Accept-Language` 无效**，
而且同一个链接**中英随机**出现（实测同一码这次中文、下次英文）。
只测线上页面等于测不准 —— 所以必须固定样本。

按钮文案也跟着语言走（en `View in TestFlight` / zh `在 TestFlight 中查看`），
这也是"靠按钮文案判定"不可靠的原因之一。

## 这些样本不能删

- `full_*` / `closed_*` 被用来**证明**"已满/已关闭页面上依然带着 `beta-status`
  和加入按钮"——即证明那条"看标记判定"的错规则真的会判错。删了护栏就失效了。
- 中文样本是唯一能覆盖"开放页是中文（`第 2 步`）"这条实测事实的资产。

## 页面结构变了怎么办

Apple 改了站点结构或措辞时，`bot.py` 会报 `状态未知 ❓`（**宁可 unknown 也不猜**）。
此时：

1. 看 `state.json` 里 `links.<码>.status_text`（状态句原文）和 `head`（页面头部原文）；
2. 重新抓一页存成新 fixture，在 `test_classify.py` 里补一条断言；
3. 跑 `python3 bot.py --unittest`，全绿再收工。
