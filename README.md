# messenger

消息投递中台。Hono / Zod、Cloudflare D1 / Queues、Resend、grammY。GitHub、Worker、D1 和 Queue 均命名为 `messenger`。

## 接入

业务 Worker 通过 `MESSENGER → messenger#Messaging` 提交 `POST /messages`。

```json
{"source":"financing","idempotencyKey":"reminder/rule/task/period","channel":"email","to":["recipient@example.com"],"subject":"提醒","text":"内容"}
```

Telegram 使用 `channel: "telegram"`、`text`，可选 `chatId`；省略时读取 Secrets Store `TELEGRAM_USER_ID`。邮件统一 `RESEND_API_KEY` 和配置中的 `FROM_EMAIL`；profile 仅标识业务配置，使用同一 Key。

成功返回 202 与 `{id,status,...}`，表示 D1 已持久化。相同 source/key/payload 返回原记录；相同 key 不同内容返回 409。不要用随机 key 包装同一业务事件。`GET /messages/:id` 查询状态。

管理端经 `MESSENGER_ADMIN → messenger#MessengerAdmin` 查询 `/messages`、`/messages/:id` 或调用 `/messages/:id/retry`。列表支持 status/channel/source、limit、before 游标。重试需要可信 `actor`，结果不确定时额外 `confirmUncertain=true`。调用方 Dashboard 从已验证用户派生 actor，Gateway 对管理页面和重试要求全站 `admin`。

两个入口只通过 Service Binding 可达；默认 fetch 404，不接受公网身份 Header。业务方仅持有提交绑定，Ingest 没有管理绑定。

## 投递与恢复

`queued → processing → accepted / retrying / failed / uncertain`。

- D1 先持久化、后发 Queue；每分钟 Cron 恢复未成功入队、到期重试和过期 lease。Queue 至少一次交付通过 D1 原子认领去重。
- 两条 Queue 的批次等待上限为 1 秒。投递批次按 email、Telegram、Web Push 与 notification 分组并行，各组内顺序执行；保留单消费者，避免放大单渠道压力及打乱同批 Telegram 分片。逐条 ack/retry，等待全部分组完成。
- 耗时日志区分 Queue 等待、notification 展开和渠道调用；仅记录 ID、渠道和毫秒耗时。
- 通知展开与发送只读取 Messenger D1 的订阅、联系方式和 Push 设备，不调用 Auth0 或 Gateway 查询权限。
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
- 旧 email/Telegram 收件配置通过 LEGACY_WORKFLOW_USER_ID 一次性迁入该账号的 workflow 订阅，读取 WORKFLOW_NOTIFICATION_EMAILS 与 Secrets Store TELEGRAM_USER_ID；已有个人设置不会被覆盖。随后完全由用户订阅解析渠道。失败包含 Workflow、实例、时间、原始错误类型/详情和实例链接；标题与正文分开，渠道只拼接一次标题。嵌套 JSON 错误解码为分行纯文本后脱敏，保留来源、接口和错误码；普通文本中的反斜杠保持原样。详情限制长度和层级，截断时明确标记，长 Telegram 分片保留格式化正文。
- 事件按账户/Workflow/实例/版本/事件类型/时间去重，先写 inbox，再冻结通知快照；部分渠道入队失败可恢复且不重复发送已入队渠道。同一实例重启后的新事件可再次通知。
- OMO completed 在通知 inbox 持久化后立即展开订阅，省去中间 notification Queue 等待；快照只有一条 Telegram 时优先持久化该消息并立即调用原投递流程。消息仍入 Queue 作为补偿，原子认领防止竞争重复发送，D1 退订与联系人检查、失败退避及 uncertain 规则不变。多收件人或多分片 Telegram 继续走既有顺序队列，避免直接发送与队列竞争打乱分片。其他 Workflow 沿用异步通知。
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

逻辑事件 `POST /notifications`（source、idempotencyKey、category、title、text、站内 url、可选 userIds）先进入 notifications inbox，Queue 只携带 `{id,kind:"notification"}`。消费者依据 D1 订阅和业务目标 userIds 冻结渠道消息，再进入原 messages 投递队列。生成端不读取联系方式、不决定渠道；最后发送前检查 D1 退订、联系方式变更和设备是否存在。旧 `/messages` 保留兼容既有明确收件人的业务。

通知类型：workflow、trading、financing（由业务指定责任人）。联系方式与订阅由 Messenger D1 独占，使用账号 subject 关联；联系邮箱独立于登录邮箱。用户设置仍从 Dashboard 的 MessengerAdmin 绑定 `/users/:subject/settings` 读写；Dashboard 从可信会话派生 subject 并管理设置入口权限。推送设备每人最多 10 个，不返回 endpoint/auth/p256dh。队列只含 ID，管理详情也不暴露推送能力凭据。

Web Push 使用 VAPID 与 aes128gcm；Secret 为 VAPID_PRIVATE_KEY，VAPID_PUBLIC_KEY 为公开配置，VAPID_SUBJECT 为 mailto 联系方式。通过 web-push 生成加密请求后使用 Workers fetch，禁止重定向，接收方限浏览器厂商推送域。404/410 移除失效设备，429/5xx 统一退避；浏览器以事件 tag 合并重复提示。

Messenger 每分钟调用 Dashboard 私有 NotificationSource `/scan`，请求携带 scheduledTime 和 D1 中订阅 trading 的 userIds，统一触发交易流程和融资待办的通知生成。业务查询和记录仍归 Dashboard；不直接绑定融资数据库。交易扫描直接使用传入名单，不查询 Auth0；融资责任人映射仍由业务所有方处理。扫描使用 D1 槽位和 lease，失败保留重试；正常业务采集/报告 Workflow 的 Cron 保持在各自所有方。

初始安装应用 Dashboard 1019、Messenger 0003 migration，配置 VAPID；0003 重建渠道 CHECK 时保留全部历史消息、尝试、人工重试及外键。本次移除推送权限查询无需 migration：先部署提供 /scan userIds 的 Messenger，再部署 Dashboard 删除 /eligible 并使用名单，最后删除 Gateway 的通知资格接口。不以模拟推送声称真实设备收到通知。

## 管理员测试消息

Dashboard「通知管理 → 测试消息」通过私有 `MessengerAdmin POST /test-messages` 提交 actor、requestId、userIds（最多 50 人）、channels、title、text。Gateway named action 与 Dashboard 均检查 admin，actor 从可信身份派生。Messenger 按用户已保存的独立联系邮箱、Telegram chat 和全部 Push 设备解析目标，不回退账号邮箱或默认 Telegram；显式测试不依赖业务类别订阅。

`0004_admin_test_batches.sql` 冻结批次及目标，防止网络重试重复发送或换收件人。每次最多生成 25 条投递，剩余由集中分钟 Cron 恢复。每条仍经 messages / Queue 投递，source 为 admin-test，payload 记录 actor；发送前重查联系方式与 Push 设备归属。返回的 skipped 给出未配置渠道，不泄漏 Push 凭据。批次入队不表示终端送达。
