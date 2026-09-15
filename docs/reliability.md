# 技术难点、可靠性与可观测性

## 难点与取舍

| 难点 | 解决方案 | 保证边界 |
| --- | --- | --- |
| 客户端能力不齐 | 显式协商、独立 Adapter、轮询和人类启动降级 | 不支持的能力明确返回 |
| Context 漂移 | 不可变版本、快照、发布事件、Owner 决定升级 | 无法收回客户端已读内容 |
| 重复与乱序事件 | Outbox/Inbox、事件 ID 去重、聚合版本和回读 | 不承诺全局顺序 |
| 并发执行 | Task 行锁/条件更新、租约与 fencing | 不能撤销已开始的本地命令 |
| 外部恰好一次 | 持久化意图、下游幂等键、revision 条件、结果核对 | 不宣称跨系统事务原子性 |
| 审批后资源变化 | 绑定摘要与版本，执行前重新检查 | 参数变化必须重新审批 |
| 身份混淆 | 人类/Agent 分表、受限 Session、权限交集 | 凭证外借仍需企业管理 |
| 成果伪造 | 不可变 Git revision、摘要、服务端核验 | 内容一致不等于业务正确 |
| 提示注入与敏感日志 | 内容与策略隔离、元数据事件、脱敏审计 | 本地模型行为不由网关完全控制 |
| 模型不可重现 | 保存输入、版本、工具与成果链 | 不能保证模型输出逐字一致 |

## Outbox、Inbox 与恢复

业务事务写入状态、审计事实与 Outbox；投递 Worker 获得消息总线确认后记录投递。投递后崩溃可能导致重复，消费者在同一数据库事务写业务结果与 Inbox，再 ack。

Inbox 唯一键为 `(consumer_id, event_id)`。失败按指数退避，默认最多 5 次后进入失败队列并告警；人工检查原因后可重放。重放消费不直接触发不可逆操作，外部操作通过唯一 ToolInvocation 执行账本防重。

Session 撤销与取消不得仅依赖事件缓存；受控操作执行前必须读取权威授权状态。消息服务不可用时，已提交的业务变化留在 Outbox；高风险意图不得在审批或审计不可用时执行。

外部调用采用 REQUESTED → AWAITING_APPROVAL/READY → RUNNING → SUCCEEDED/FAILED/UNKNOWN/CANCELED。RUNNING 时崩溃先进入核对流程；不支持查询或幂等的下游操作需要人类处理 UNKNOWN，不能盲目重发。

## 观测信号

指标覆盖 Outbox 最旧未投递时间、失败队列数量、消费者延迟、活跃/丢失租约、待审批时间、工具失败与 UNKNOWN 数量、权限拒绝量。告警优先针对持续阻塞和结果不明，不针对每条正常事件。

API 和事件传递 correlation_id、causation_id 与 traceparent；审计记录关联 trace_id。普通 trace 可以采样，审计事实不可因采样丢失。日志记录资源 ID 与摘要，不记录凭证、完整 Prompt 或 Context 正文。

## 备份与演进

PostgreSQL 与对象存储建立联合备份清单，验证快照摘要和对象引用；事件总线可重建消费读模型，但不能替代权威数据库备份。恢复先校验元数据与对象，再恢复投递和操作核对，避免重启时重复外部副作用。

试点阶段先测实际负载，再设告警阈值、容量和 SLO。跨区域部署需要额外处理写入主权、租约与全局审批，不在本次基线假设内。

参考：[JetStream 至少一次交付](https://docs.nats.io/concepts/jetstream)、[MCP 安全实践](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)。
