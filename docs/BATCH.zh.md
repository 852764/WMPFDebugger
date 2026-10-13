# 批量采集多个小程序

批处理接收 1–500 条微信小程序分享链接，按顺序逐条打开、识别、采集和汇总。它复用已验证的适配器；遇到新小程序时，优先把运行时观察到的商品列表、价格、销量和分页证据交给 MCP 宿主 AI 生成受限适配方案，再通过真实请求回放验证后才开始完整采集。

## 通过 MCP 启动

调用 `miniapp_batch_start`，传 `links` 数组或 `text` 多行文本，例如：

```json
{
  "links": [
    "#小程序://店铺甲/Abcde",
    "#小程序://店铺乙/Fghij"
  ],
  "desktop": true,
  "perItemTimeoutMs": 180000
}
```

工具立即返回 `batchId`。之后用 `miniapp_batch_status` 查看逐条状态和进度，用 `miniapp_batch_report` 查看目录汇总。需要停止时调用 `miniapp_batch_cancel`；任务会保存当前商品页检查点，尚未开始的链接保留待处理状态。

新增小程序需要 AI 识别时，支持 MCP sampling 的客户端会在批处理中直接调用自己的模型。如果客户端不支持 sampling，待适配项会标记为 `needs_adaptation`：先调用 `miniapp_batch_evidence` 读取脱敏证据，再按工具提示提交 `miniapp_batch_adapt` 的结构化方案，最后调用 `miniapp_batch_resume`。方案不能执行任意代码或自选网络地址；服务会重新检查链接身份、商品 ID、价格单位、销量字段、目录范围和分页，并回放实际接口。验证不通过就不会采集金额。

## 无销量和未知字段

只有在证据覆盖**全商品范围**并核验完服务器报告的全部分页后，确认没有可用销量，批次才会将该链接标为 `skipped_no_sales` 并继续下一条。真实数字 `0` 是有效销量；空值不当作零；库存、评价数、浏览量和购买限制也不当作销量。若候选列表只是某个分类/搜索结果、证据被截断，或只能找到不明含义的字段，系统不会据此宣告“没有销量”，而会要求更多适配证据。

页面或网络接口不可达、需要用户登录、启动器无法准确打开目标等情况会单独标记为失败或 `needs_input`，不阻断后续普通链接；`needs_input` 表示当前桌面状态需要处理，批次暂停以避免误操作。每条链接最长运行时间可通过 `perItemTimeoutMs` 调整。

## CLI 与恢复

纯文本文件每行一个链接，也可用 JSON 字符串数组：

```powershell
npm run batch -- --links-file links.txt
npm run batch -- --links-file links.json --item-timeout 300
npm run batch -- --resume BATCH_ID
npm run batch -- --resume BATCH_ID --retry-failed
```

CLI 可使用已保存的适配器和代码内置的已验证规则；新小程序的 AI 适配需要由支持 MCP sampling 的客户端启动，或在 MCP 中完成上述 `evidence → adapt → resume` 流程。意外退出后重新启动 MCP/CLI，再用 `miniapp_batch_resume` 或 `--resume` 接着处理。完成目录不会重复累计；已中断的商品任务从已写入的页面检查点恢复。`retryFailed` 会重新尝试失败、超时和待适配项。

## 报告口径

每个批次写入被 Git 忽略的 `artifacts/batches/<batchId>/`：

- `summary.json` / `summary.csv`：每个链接的状态、去重关系、金额和原因。
- `products.csv`：已处理目录的商品明细；相同目录只导出一次。
- `state.json`：断点续跑所需状态；`discovery-<序号>.json` 保存脱敏的适配证据。

`completedSubtotalYuan` 是已完整完成且去重目录的当前售价 × 展示销量小计。`totalAmountYuan` 只有在所有输入链接都成功或指向成功目录时才有值；存在无销量、失败或待处理项时为 `null`，不会把被跳过链接当作 0 元加入总计。相同商品目录按已验证的 appId、接口、店铺/筛选参数及字段映射去重。这个数值不代表历史订单收入。

默认使用 Windows-MCP 执行桌面打开，再由本项目 MCP 完成结构化采集；首次搜索或特殊页面布局仍可能需要用户先在微信里打开目标。一次只运行一个采集批次，避免多个链接争用同一微信窗口和 CDP 会话。