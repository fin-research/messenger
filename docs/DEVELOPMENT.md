# Messenger 开发运维

## 验证与发布

```sh
pnpm install --frozen-lockfile
pnpm typegen
pnpm check
pnpm test
pnpm deploy:dry
git diff --check
```

Schema 变化新增 migration，不改写已应用文件。生产变更先执行 `pnpm db:migrate:remote`，再部署经验证的 Worker 并核对版本与私有 binding。真实外发测试必须明确收件人和发件人；模拟渠道测试不证明真实投递。

Worker Secret 为 `RESEND_API_KEY`、`VAPID_PRIVATE_KEY`；Secrets Store 保存 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_USER_ID`。VAPID 公钥为公开配置；不提交 `.dev.vars`、`.env` 或凭据。

## Workflow 订阅

平台事件映射以 `src/workflow-events.ts` 和 `wrangler.jsonc` 为准。新 Workflow 先部署所有方 binding，创建事件 Queue 与死信 Queue，应用 Messenger migration 并部署 Worker，再运行 `node scripts/sync-workflow-subscriptions.mjs` 只读计划；核对后用 `--apply` 同步。脚本不覆盖已有订阅；缺少 binding 时必须失败。死信需核实原因后原样重投事件 Queue，不把未知 schema 当成功丢弃。

## 恢复边界

D1 是事实来源；Queue 仅调度 ID。检查 inbox、outbox、lease、retry_audit 和死信，再决定恢复或人工重试。Telegram `uncertain` 要求确认渠道结果；Resend 幂等窗口过期后不能盲目自动重发。历史 Dashboard/Ingest 业务记录不删除，订阅与设备变更不通过重放旧消息改写。
