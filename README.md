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
pnpm deploy
```

Secrets：Worker `RESEND_API_KEY`；Secrets Store `TELEGRAM_BOT_TOKEN` / `TELEGRAM_USER_ID`。不提交 `.dev.vars` 或 `.env`。

切换顺序：创建 D1/Queue → migration → 部署 messenger 和配置 Secret → 追加调用方 migration → Gateway 权限目录/Auth0 scope → Dashboard / Ingest 绑定与调用方发布。先核验新服务，最后停用调用方渠道凭据。真实外发测试需明确指定收件人；常规验收仅 mock 渠道和只读线上探针。
