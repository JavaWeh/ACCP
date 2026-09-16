# 架构决策记录

ADR 描述设计选择与代价；“接受”表示设计基线已选定，不代表运行时实现已完成。

| ADR | 决策 |
| --- | --- |
| [0001](0001-control-plane.md) | Go 模块化控制面与独立执行边界 |
| [0002](0002-versioned-protocol.md) | 自有版本化协作协议、固定 Context 与来源证据 |
| [0003](0003-events-and-governance.md) | 至少一次事件、操作账本与人类审批 |
| [0004](0004-m1-foundation.md) | M1 人类控制面、PostgreSQL 内容与事务边界 |

变更决策时新增 ADR 并标明取代关系；历史决定不直接擦除。每条记录包含背景、选择、替代方案、后果和重新评估条件。

- [0005：M2 执行与协议增量](0005-m2-execution.md)。

- [0006：受控交付与 Web 控制台](0006-controlled-delivery-console.md)。

- [0007：常驻 Bridge 的有界自动续租](0007-bridge-lease-renewal.md)。
