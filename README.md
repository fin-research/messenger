# Messenger

私有 Cloudflare Worker，集中处理业务通知、邮件、Telegram、Web Push、投递历史与人工重试。业务 Worker 通过命名 `Messaging` Service Binding 提交；Dashboard 管理端通过 `MessengerAdmin` 查询和重试。默认 HTTP 入口返回 404。

## 提交消息

`POST /messages` 用于明确指定渠道和收件人的业务消息：

```json
{"source":"financing","idempotencyKey":"reminder/rule/task/period","channel":"email","to":["recipient@example.com"],"subject":"提醒","text":"内容"}
```

Telegram 使用 `channel: "telegram"` 和 `text`。成功返回 202 表示 D1 已持久化；相同来源、key 和内容返回原记录，key 相同但内容不同返回 409。`GET /messages/:id` 查询状态。`accepted` 仅表示渠道接受请求，不证明收件箱或设备已送达。

`POST /notifications` 用于按用户和类别发送逻辑通知；调用方提交事件与目标账号，Messenger 根据用户设置决定渠道和独立联系方式。工作流终态与交易、融资提醒也走这层。管理端的消息列表、详情、人工重试和管理员测试消息通过私有 `MessengerAdmin` 入口提供。

内部状态、订阅与渠道边界见 [架构](docs/ARCHITECTURE.md)；资源初始化、验证、发布与恢复见 [开发运维](docs/DEVELOPMENT.md)。Agent 规则从 [AGENTS](AGENTS.md) 进入。
