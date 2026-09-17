# messenger

消息投递中台。Hono / Zod、Cloudflare D1 / Queues、Resend、grammY。GitHub、Worker、D1 和 Queue 均命名为 `messenger`。

## 接入

业务 Worker 通过 `MESSENGER → messenger#Messaging` 提交 `POST /messages`。

```json
{"source":"financing","idempotencyKey":"reminder/rule/task/period","channel":"email","to":["recipient@example.com"],"subject":"提醒","text":"内容"}
```

Telegram 使用 `channel: "telegram"`、`text`，可选 `chatId`；省略时读取 Secrets Store `TELEGRAM_USER_ID`。邮件统一 `RESEND_API_KEY` 和配置中的 `FROM_EMAIL`；profile 仅标识业务配置，使用同一 Key。

成功返回 202 与 `{id,status,...}`，表示 D1 已持久化。相同 source/key/payload 返回原记录；相同 key 不同内容返回 409。不要用随机 key 包装同一业务事件。`GET /messages/:id` 查询状态。

管理端经 `MESSENGER_ADMIN → messenger#MessengerAdmin` 查询 `/messages`、`/messages/:id` 或调用 `/messages/:id/retry`。列表支持 status/channel/source、limit、before 游标。重试需要可信 `actor`，结果不确定时额外 `confirmUncertain=true`。调用方 Dashboard 从已验证用户派生 actor，Gateway 分别要求 `messenger.delivery:read` 与 `messenger.delivery:retry`。

两个入口只通过 Service Binding 可达；默认 fetch 404，不接受公网身份 Header。业务方仅持有提交绑定，Ingest 没有管理绑定。

## 投递与恢复

`queued → processing → accepted / retrying / failed / uncertain`。

- D1 先持久化、后发 Queue；每分钟 Cron 恢复未成功入队、到期重试和过期 lease。Queue 至少一次交付通过 D1 原子认领去重。
- 每轮最多 6 次尝试，30 秒起指数退避；Telegram 429 尊重 retry_after。明确永久失败直接结束。
- `accepted` 是 Resend / Telegram 接收，未接收邮件回执，不能当作最终送达。
- Telegram 网络错误或 Worker 中断进入 uncertain，人工确认后才可重发。Resend 使用稳定渠道幂等键，自动重试限 23 小时安全窗口。
- 人工重试生成新一轮渠道幂等键，并记录操作者。accepted 和进行中的消息不能重试。
- 正文只在 D1 持久化与授权详情展示；日志仅安全错误码。管理页 HTML 邮件以转义源文本展示，不执行消息 HTML。
- 历史 Dashboard reminder / Ingest telegram_delivery 原地保留；新增队列记录始于切换。业务表保存 messenger ID，投递结果以 messenger 为准。

## 开发与交付

```sh
pnpm install --frozen-lockfile
pnpm typegen
pnpm check
pnpm test
pnpm deploy:dry
pnpm db:migrate:remote
pnpm run deploy
```

Secrets：Worker `RESEND_API_KEY`；Secrets Store `TELEGRAM_BOT_TOKEN` / `TELEGRAM_USER_ID`。不提交 `.dev.vars` 或 `.env`。

切换顺序：创建 D1/Queue → migration → 部署 messenger 和配置 Secret → 追加调用方 migration → Gateway 权限目录/Auth0 scope → Dashboard / Ingest 绑定与调用方发布。先核验新服务，最后停用调用方渠道凭据。真实外发测试需明确指定收件人；常规验收仅 mock 渠道和只读线上探针。

## Workflow 终态订阅

Cloudflare Event Subscriptions → Queue `messenger-workflow-events` → D1 `workflow_events` inbox → 现有 messages/outbox → email＋Telegram。Workflow 内不发送完成/失败通知。业务通知（如央行资讯、融资提醒）继续使用 Messaging。

- 全部 Workflow 订阅 instance.errored / instance.terminated；omo、market-briefing 额外订阅 instance.completed。economic-indicator-sync 的 completed 只用于检查业务 partial/failed，正常成功不通知。
- Queue 事件只带实例 ID，Messenger 通过跨脚本 Workflow binding 的 get/status 读取 error.name/message 或成功 output；不增加 Cloudflare API 运行时凭据。
- 旧 email/Telegram 收件配置通过 LEGACY_WORKFLOW_USER_ID 一次性迁入该账号的 workflow 订阅，读取 WORKFLOW_NOTIFICATION_EMAILS 与 Secrets Store TELEGRAM_USER_ID；已有个人设置不会被覆盖。随后完全由用户订阅解析渠道。失败包含 Workflow、实例、时间、原始错误类型/详情和实例链接；敏感凭据脱敏，长 Telegram 分片保留正文。
- 事件按账户/Workflow/实例/版本/事件类型/时间去重，先写 inbox，再冻结通知快照；部分渠道入队失败可恢复且不重复发送已入队渠道。同一实例重启后的新事件可再次通知。
- 查询和入队失败由每分钟 Cron 恢复；消息渠道仍使用原有退避、Email 幂等窗口和 Telegram uncertain 规则。inbox last_error 只存安全码。
- 事件持久化前失败由 Queue 重试，耗尽后保留在 messenger-workflow-events-dlq；运维需检查死信并原样重投事件队列。禁止将未知 schema 或未配置 binding 的事件当成功丢弃。

初始化：先部署 Ingest 的 omo（保留 open-market 历史命名空间），创建两条队列，执行 0002 migration，再部署 Messenger，最后启用订阅。Dashboard 删除通知 step 后由 Git 自动部署。

```sh
pnpm exec wrangler queues create messenger-workflow-events
pnpm exec wrangler queues create messenger-workflow-events-dlq
pnpm db:migrate:remote
pnpm deploy
# 环境注入具有 Queues Write / Workers Scripts Read 的 CLOUDFLARE_API_TOKEN
node scripts/sync-workflow-subscriptions.mjs
node scripts/sync-workflow-subscriptions.mjs --apply
```

同步脚本默认只读规划，对已存在配置保持不动；账户新增 Workflow 未配置 binding 时明确失败。新增 Workflow 必须同步 wrangler.workflows、src/workflow-events.ts 的映射，然后重新同步订阅。所有方部署顺序不可反转。旧 open-market 保留失败订阅，不自动删除实例历史。

## 用户通知与 Web Push

逻辑事件 `POST /notifications`（source、idempotencyKey、category、title、text、站内 url、可选 userIds）先进入 notifications inbox，Queue 只携带 `{id,kind:"notification"}`。消费者读取用户订阅与当前 Gateway 资格，冻结渠道消息，再进入原 messages 投递队列。生成端不读取联系方式、不决定渠道；最后发送前再次检查退订、联系方式变更和访问资格。旧 `/messages` 保留兼容既有明确收件人的业务。

通知类型：workflow（管理员）、trading（交易研究读取权限）、financing（项目读取权限，并由业务指定责任人）。联系方式与订阅由 Messenger D1 独占，使用 Auth0 subject 关联；联系邮箱独立于账号邮箱。用户设置仅从 Dashboard 的 MessengerAdmin 绑定 `/users/:subject/settings` 读写；Dashboard 从可信会话派生 subject。推送设备每人最多 10 个，不返回 endpoint/auth/p256dh。队列只含 ID，管理详情也不暴露推送能力凭据。

Web Push 使用 VAPID 与 aes128gcm；Secret 为 VAPID_PRIVATE_KEY，VAPID_PUBLIC_KEY 为公开配置，VAPID_SUBJECT 为 mailto 联系方式。通过 web-push 生成加密请求后使用 Workers fetch，禁止重定向，接收方限浏览器厂商推送域。404/410 移除失效设备，429/5xx 统一退避；浏览器以事件 tag 合并重复提示。

Messenger 每分钟调用 Dashboard 私有 NotificationSource `/scan`，统一触发交易流程和融资待办的通知生成。业务查询和记录仍归 Dashboard；不直接绑定融资数据库。`/eligible` 从 Gateway 取得有效账号与通知资格，故障时不放宽权限。扫描使用 D1 槽位和 lease，失败保留重试；正常业务采集/报告 Workflow 的 Cron 保持在各自所有方。

发布：先部署 Gateway 资格接口和 admin 角色；应用 Dashboard 1019 D1 migration，部署含 NotificationSource 的 Dashboard；应用 Messenger 0003，配置 VAPID，部署 Messenger。0003 重建渠道 CHECK 时保留全部历史消息、尝试、人工重试及外键。升级前核对历史行计数和待处理事件，升级后回读版本、配置与表计数。不以模拟推送声称真实设备收到通知。
