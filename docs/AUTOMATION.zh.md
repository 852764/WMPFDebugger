# 从小程序链接自动采集金额

`miniapp_collect_start` 接收已适配的微信分享链接，自动连接或启动调试器、打开小程序、核对 appId、刷新商品列表、分页请求、按商品 ID 去重，再导出 JSON / CSV。任务在 MCP 进程内异步运行，开始调用立即返回 runId。采集过程中不需要 AI 逐页点击或查看截图。

目前内置并实机验证的是：

- 名称：川黔纯粮酒-龙氏酒业
- 链接：`#小程序://川黔纯粮酒-龙氏酒业/DMlLBrOIODZkN9G`
- appId：`wx5c3807c8b75c37ac`
- 统计范围：商城“全部”分类当前可见商品，去重键为商品 `form_data.id`。
- 计算口径：商品列表 `price`（元）× `sales`（接口展示销量）。不是历史订单收入；成交折扣、退款、规格价差和店铺设置的展示销量均可能影响解释。

**并非任意小程序链接都已支持。** 分享码不是可直接解码的 appId。当前按已核验的名称 + 分享码选择适配器，再用运行时 appId 校验身份；不保证进入分享链接所指的特定活动页。首次接入其他小程序，需要 AI 用现有调试工具确认接口、字段、分页和统计范围，添加经过核验的 `profiles/*.json`。未知链接返回 `PROFILE_REQUIRED`，不会猜销量或返回零金额。

## 一条命令

先登录桌面微信，安装项目依赖：

```powershell
npm ci
Copy-Item examples/windows-mcp.json artifacts/windows-mcp.local.json
npm run collect -- --link "#小程序://川黔纯粮酒-龙氏酒业/DMlLBrOIODZkN9G"
```

第一次复制前请创建 `artifacts` 目录，并按本机环境修改配置里的 `command` / `args`。示例使用 `uvx windows-mcp serve`；Windows-MCP 的安装要求见[上游项目](https://github.com/CursorTouch/Windows-MCP)。可通过环境变量 `WMPF_WINDOWS_MCP_CONFIG` 指定另一个本地配置文件，不要把登录凭据写入商品适配器。

启动器要求已登录的微信 4.x、可见且可操作的桌面，以及 Windows 本地 OCR 语言包。它用 Windows-MCP 打开微信、识别小程序入口/搜索结果；通过[Windows OCR](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine)在本机识别文字，不调用视觉模型 API。验证搜索框后才输入名称。用户操作打断、窗口不唯一、布局变化或识别不确定时会停止并保留任务。

如果目标已经在已注入的微信中打开，直接复用调试连接，不操作桌面。也可以显式禁用桌面启动：

```powershell
npm run collect -- --link "#小程序://川黔纯粮酒-龙氏酒业/DMlLBrOIODZkN9G" --no-desktop
```

调试器仍受上游 WMPF 版本配置限制。实测环境为 Windows 微信 4.1.15.13 / WMPF 25715。任务只关闭自身启动的调试器进程，不关闭已有调试器或微信。

## AI / MCP

使用原有 `wmpf-miniapp` MCP 配置，新增以下工具：

| 工具 | 用途 |
| --- | --- |
| `miniapp_profiles` | 列出已核验链接、统计范围和字段证据 |
| `miniapp_collect_start` | 开始或恢复任务，参数 `link`、`desktop`、可选 `resumeId` / `profileId` / `port` |
| `miniapp_collect_status` | 读取阶段、页数、商品数、错误和导出路径 |
| `miniapp_collect_report` | 返回汇总与分页商品明细，`limit: 0` 只看汇总 |
| `miniapp_collect_cancel` | 请求取消当前 MCP 进程拥有的任务并保留检查点 |

调用示例：

```json
{
  "name": "miniapp_collect_start",
  "arguments": {
    "link": "#小程序://川黔纯粮酒-龙氏酒业/DMlLBrOIODZkN9G",
    "desktop": true
  }
}
```

后续按返回的 runId 查询状态，间隔约 1–3 秒即可；`completed` 后读取报告。若已有手动 `miniapp_connect` 会话，先断开该会话，避免抢占独占 CDP 连接。

任务的 `completed` 表示分页证据完整且每个唯一商品都有可计算的价格/销量。接口销量的真实性、历史价格与订单收入仍未验证。其他状态包括 `incomplete`、`needs_input`、`failed` 和 `cancelled`，应读取 `error` 和 `catalogComplete` / `amountComplete`。

## 报告与恢复

每次运行写入被 Git 忽略的 `artifacts/runs/<runId>/`：

- `state.json`：任务进度、状态及错误。
- `page-000001.json` 等：商品 ID、标题、价格、销量与分页证据，采用原子替换保存。
- `report.json`：汇总与所有唯一商品。
- `products.csv`：可用 Excel 打开的 UTF-8 BOM 表格，处理公式注入。

`totalAmountYuan` 只有覆盖完整且商品字段可计算时才有值；否则是 `null`，已采集的有效部分单独列为 `capturedSubtotalYuan`。缺失销量不会当成 0；真实 0 销量参与计算。重复商品只计算一次，价格或销量冲突会排除并标记。金额使用整数分及 BigInt 运算。

恢复示例：

```powershell
npm run collect -- --link "#小程序://川黔纯粮酒-龙氏酒业/DMlLBrOIODZkN9G" --resume "<runId>"
```

恢复会核对分享链接和适配器摘要，并从已落盘的页恢复；已经完成的任务不可续跑，应另开新任务。进程退出后任务不继续运行，需保持 MCP 客户端连接，或在 CLI 终端运行。采集是时间区间内的观察，后台数据变化可能需要重新开始；不是服务端事务快照。

每页核对页码、总数、总页数和终止标记。重复页、停止条件矛盾、总数变化、达到页数/商品数上限都会停止，避免把局部结果当成完整结果。429 和临时服务端错误有有限重试；取消可能需要等待正在进行的请求超时（最多约 18 秒），之后保存报告和释放连接。同一项目目录只允许一个自动采集任务。

登录态只在微信运行时内存中的原始请求模板中复用，不写进适配器、检查点或金额报告。截图只用于启动阶段，并在启动器关闭时删除。原有低层调试工具可读取完整网络响应，导出或分享调试抓包前应检查其中的个人信息。

## 已完成的实机验证

2026-10-12，通过正式 stdio MCP 的 `miniapp_collect_start` 输入该链接，任务自动刷新、采集 7 页并核对接口总数 51：

| 项目 | 结果 |
| --- | --- |
| 唯一商品 | 51 |
| 重复观察 | 0 |
| 缺失销量 / 非法价格 / 冲突 | 0 / 0 / 0 |
| 当前价格 × 展示销量 | 267,315.00 元 |
| 分页覆盖 / 金额计算完成 | true / true |

另验证了 Windows-MCP 从微信已有的小程序搜索结果打开目标并核对 appId。首次搜索及不同微信布局仍可能需要用户打开一次后恢复；启动器在不确定时返回明确错误，不宣称所有桌面布局均已验证。5 个商品存在规格价格区间，但本次它们的销量均为 0，未影响该合计。

运行 `npm run typecheck` 与 `npm test` 验证实现。金额结果和抓包只保存本地，Git 中只提交通用代码、适配规则、测试和文档。
