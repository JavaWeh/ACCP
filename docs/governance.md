# Human-Agent Governance

当前运行实现见 [M3/M4 平台](m3-m4-platform.md)。成果验收、独立操作审批与 Gateway 已实现；本地独立凭证绕行仍不属于强制治理范围。

## 人类责任与身份

Task Owner 对任务交付负责；delegated_by_user_id 表示把权限委托给 Agent 的人；AgentIdentity 表示执行客户端；AgentSession 表示一次有期限的授权关系。实际请求主体、Owner、委托人和审核人分别保存，不能把它们合并为一个 user_id。

人类身份来自企业 OIDC。MVP 不实现公共注册或跨企业邀请。Agent 注册及 Session 授权由有效人类成员发起；每个 Run 绑定项目与委托范围。

## 默认角色与动作

| 动作 | 允许主体 |
| --- | --- |
| 管理项目成员、策略、工具目录 | 项目 ADMIN，人类 |
| 创建任务、提交候选 Context、注册 Agent | MEMBER 或 ADMIN，人类 |
| 分配执行、提交/重试/取消任务 | Task Owner，或带审计原因的 ADMIN，人类 |
| 发布 Context、接受 API 契约成果 | REVIEWER 或 ADMIN，人类 |
| 高风险操作审批 | REVIEWER 或 ADMIN 人类，且不是本次请求的人类委托人 |
| 最终 Task 验收 | 当前 Task Owner，人类；其他人需先正式移交责任 |
| claim、心跳、报告、提交成果、受限工具调用 | 有对应委托范围的 AgentSession |
| 只读资源 | 有相应项目及资源访问权的成员/Session |

角色可组合；ADMIN 不绕过高风险请求人与审批人分离规则。VIEWER 不允许委托写权限。权限取人类当前权限、Session scopes、项目/资源 ACL 和工具策略交集；未显式允许的动作拒绝。

管理员更换 Owner 必须记录移交原因。存在活跃 Run 时先停止并处理在途操作，再进行移交；旧成果保留产生时 Owner 和委托人，不能改写历史责任。

## 高风险审批

默认高风险：生产数据写入、破坏性操作、受保护分支合并、生产部署、权限或凭证配置变更。工具风险分类由受信策略管理员配置，不能由 Agent 自报。未登记工具、未知资源或无法分类的副作用默认拒绝执行。

审批绑定：ToolInvocation ID、Session 与 Run、工具与 schema 版本、资源 ID 和版本、规范化参数摘要、成果/Commit SHA、策略版本、有效期。JSON 参数规范化后计算摘要；审批页面显示可读参数和脱敏 diff，而不只显示一串 hash。

Approval 状态：PENDING、APPROVED、REJECTED、EXPIRED。决定不可原地覆盖；操作变更、新策略或目标 revision 变化导致原审批不再适用，创建新记录。默认审批有效期 30 分钟，执行仍必须满足有效 Session 和 Run 租约。

Worker 领取已批准意图时原子标记执行，并在副作用前重新鉴权。人类审批不隐含无限重试权限，不能把一次部署批准复用为以后部署。

## MCP Gateway 安全边界

Gateway 校验 access token 的 audience 为当前网关资源；控制面 token 不能自动作为下游 Git、DB 或 CI 凭证。下游凭证独立获取、按工具和资源最小授权，不返回给 Agent。[MCP 授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) 明确要求 audience 校验。

注册工具与下游端点需要管理员权限。URL、重定向和目标网络范围采用允许列表，阻止工具和 Context 引用诱导网关访问未授权内网资源。Context 与工具输出按不可信数据处理，不将其中的指令提升为系统策略。

MVP 管控的是受治理凭证、资源与网关流量。开发者本地拥有独立 SSH、数据库账号或 shell 权限时可以绕行；平台不能声称这些操作已被阻止或完整审计。集中式 Runner、隔离文件系统与网络出口属于后续阶段。

## 审计、保留与撤销

业务变更事务保存审计事实与 outbox。工具执行先记录意图，再调用外部系统，最后保存结果；发生崩溃时通过操作 ID 核对，保留 UNKNOWN 状态。

审计字段包括人类责任主体、实际 actor、客户端/Adapter 版本、Session、TaskRun、ContextSnapshot、资源版本、参数摘要、成果、审批和 trace_id。原始日志不保存 token、密钥或完整敏感 Context。

MVP 默认事件回读 7 天、运行日志 30 天、审计元数据 180 天。被保留审计或成果引用的快照和摘要不能独立清理；对象内容的保留策略由企业配置，删除后保留带原因的墓碑并明确不可再获取正文。法律保留要求由部署企业配置，不预设适用于所有行业。

审计写入账号无更新/删除历史记录权限；独立备份并记录导出摘要。MVP 不宣称抵御数据库管理员篡改；需要不可抵赖证据时增加独立签名与 WORM 存储。

成员停用或 Session 撤销后，新的读取、领取和工具调用立即拒绝，待执行意图取消，已开始的外部副作用按实际结果核对。已被本地客户端下载的内容无法远程收回。

## 必须验证的越权场景

Agent 作为 Owner/审批人、跨项目关联、旧 Session 重放、过期租约写入、审批后变更参数、伪造 API_READY、Context 提示注入、下游 token 透传和权限撤销后的快照读取，都必须在未来运行时测试中被拒绝。

当前 Schema 和示例只验证结构，不能证明上述运行时控制已经存在。
