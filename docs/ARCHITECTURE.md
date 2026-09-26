# Messenger 内部架构

## 消息投递

D1 保存 messages、attempts 与审计，Queue 只携带 ID。状态为 `queued → processing → accepted / retrying / failed / uncertain`；先持久化再入队，消费者用 D1 条件认领抵御至少一次交付。Cron 每分钟恢复未入队、到期重试与过期 lease。永久失败直接结束；其余最多 6 次、30 秒起指数退避。Telegram 429 尊重 `retry_after`，网络结果不确定时进入 `uncertain`，只经人工确认重发。Resend 使用稳定渠道幂等键，自动重试限安全窗口；人工重试生成新一轮键并记录操作者。日志不包含密钥、完整正文或 Push 凭据。

消息批次按 email、Telegram、Web Push 和逻辑通知分组；组间并行，组内保持顺序，逐条确认或重试。Workflow 事件 Queue 与消息 Queue 的批大小、等待和消费者并发以 [Wrangler 配置](../wrangler.jsonc) 为准，调整时须核对事件到达至渠道启动的延迟和同渠道顺序。

`accepted` 只表示 Resend、Telegram 或 Push 服务接受，不是最终送达。历史业务投递记录保留，新的渠道结果以 Messenger 为准。管理入口从 Dashboard 已验证身份取得 actor；重试不接受浏览器指定的操作者。

## Workflow 终态订阅

平台 Event Subscriptions 将 Workflow 事件送到 `messenger-workflow-events` Queue；Messenger 以实例 ID 读取状态和错误，先存 `workflow_events` inbox 并冻结通知快照，再展开到消息 outbox。全部 Workflow 订阅失败与终止；omo、market-briefing 还订阅完成，economic-indicator-sync 的完成事件只用于识别业务 partial/failed。Workflow 内不重复发送终态通知。事件写入前失败由 Queue 重试，耗尽进入死信队列；写入后的查询或入队失败由 Cron 恢复。新增 Workflow 时同步 binding、事件映射和平台订阅，按[开发运维](DEVELOPMENT.md#workflow-订阅)执行。

## 用户通知与 Web Push

`POST /notifications` 写入逻辑通知，Queue 只携带 `{id,kind:"notification"}`；Messenger D1 独占订阅、联系方式和 Push 设备。提交方只决定业务类别、内容及目标账号，不直接读取联系人或选择渠道。发送前重新检查退订和设备归属；推送 endpoint/auth/p256dh 不进入日志或管理详情。Web Push 使用 VAPID 与 aes128gcm，限制浏览器厂商推送域且禁止重定向；404/410 移除失效设备，429/5xx 退避。

Messenger 每分钟携带 D1 中交易订阅用户名单调用 Dashboard 私有 NotificationSource `/scan`；交易和融资候选业务查询仍归 Dashboard，投递资格只依 Messenger D1，不查询 Auth0。扫描槽位与 lease 由 Messenger 维护。管理员测试消息按选定用户及渠道使用已保存联系方式，冻结批次和目标，重试不能换收件人；入队与渠道接受都不等于终端送达。
