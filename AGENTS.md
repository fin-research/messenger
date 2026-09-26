# Messenger

独立 Cloudflare Worker，拥有消息投递、重试、D1 `messenger` 与 Queue `messenger`。遵循同级 `eastmoney/AGENTS.md`、共享架构和凭据规则。

- Hono + Zod 管理私有 HTTP 契约；Resend 与 grammY 分别拥有渠道 API。
- `Messaging` 仅供业务 Worker 提交；`MessengerAdmin` 仅供 Dashboard 管理端。默认 fetch 固定 404，关闭公网路由、workers.dev、preview。
- 业务内容、收件人规则由调用方维护；Secret 和渠道重试只在此仓库。
- D1 是事实来源，Queue 只携带 ID。任何异步状态变化必须通过条件更新；不能自动重试 Telegram 不确定结果。
- `accepted` 仅表示渠道接收，不等于收件箱送达。不要用测试模拟声称真实投递。
- 任何 schema 变更新增 migrations，不改写已应用的迁移。保留历史和幂等键。
- 不记录密钥、bot URL 或完整消息正文到日志。
- 检查：`pnpm typegen`、`pnpm check`、`pnpm test`、`pnpm deploy:dry`、`git diff --check`。生产 migration 使用 `pnpm db:migrate:remote`。
- 只提交本任务文件，推送并核对 CI；发布经过验证的提交，核对 Worker 版本与私有绑定。

接入示例见 [README](README.md)；投递状态与通知边界见[架构](docs/ARCHITECTURE.md)，验证、订阅与发布见[开发运维](docs/DEVELOPMENT.md)。
