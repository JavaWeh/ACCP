# ACCP Collaboration Protocol v0.1

> 当前实现包含 M1–M3 控制面与 M4 Web 功能。运行、升级与验收见 [M3/M4 平台](m3-m4-platform.md)；边界与代价见 [ADR 0006](adr/0006-controlled-delivery-console.md)。真实客户端联合验收暂缓。

## 状态与传输

运行支持以 OpenAPI 的 `x-accp-milestone: M1 | M2 | M3 | M4` 和实现说明为准；`future` 表示尚未实现的接口。Bridge 继续使用协作协议 0.2，M3 REST 增量不改变已注册客户端的协商版本。

本协议是 ACCP 项目自有草案，不是外部 ACP 标准的实现声明。`/api/v1` 是 API 主版本命名空间，`0.1` 是当前预发布协议版本；在首个稳定版本前，破坏性修改仍必须记录并升级协议 minor，不能悄悄改变已登记 Adapter 的语义。

- REST 使用 HTTPS + JSON；[OpenAPI](../contracts/openapi.yaml) 定义输入输出。
- JSON Schema 使用 draft 2020-12；[契约索引](../contracts/README.md) 提供模型和示例。
- 通知使用 SSE，轮询使用同一事件读模型；两者都只读，不能触发领域状态修改。
- MCP 使用固定基线 2025-11-25，远程 Streamable HTTP，本地 Bridge 可提供 stdio。初始化握手协商实际支持版本，不静默升级到未知版本。
- Adapter 通过标准 API 领取与上报，无需控制面主动调用厂商客户端。

## 身份与公共请求约定

所有业务请求验证 bearer token 的 issuer、audience、有效期和主体类型。`organization_id` 来自认证授权，`project_id` 需验证成员关系；请求字段不能覆盖认证事实。Session ID 只是资源标识，不是凭证。

人类 OIDC 登录后可在授权范围内创建 AgentSession。Session 返回的短期 ACCP 凭证只适用于指定资源与范围；实际令牌签发/刷新依赖实现阶段的企业身份配置，本仓库不存放真实凭证。

所有 POST 请求要求 `Idempotency-Key`。作用域为企业、认证主体、路由及资源；相同键与相同请求返回已记录结果，不重新执行。相同键对应不同规范化输入返回 `409 IDEMPOTENCY_CONFLICT`。默认保留响应 24 小时；有外部副作用的 invocation 去重记录独立保留到审计保留期结束。

修改已有实体要求 `If-Match: "<version>"`，服务器返回对应 `ETag`。版本不符返回 `412 VERSION_CONFLICT`，缺少前置条件返回 428。Create 和 claim 不要求已有资源版本，claim 以数据库原子领取防重入。

Run 写接口同时要求 `X-Run-Fencing-Token`。服务器检查 Session、活跃租约与当前 token；Agent 不能自增 token。幂等重放仍先检查当前访问权限；已撤销身份不能借重放读取旧的敏感结果。

错误采用 Problem Details 结构：`type`、`title`、`status`、`code`、`detail`、`trace_id`。401 表示身份失效，403 表示授权不足，409 表示状态/幂等冲突，412 表示版本冲突，422 表示领域校验失败，429 表示限流，503 表示暂时不可用。

## 命令与接口

| 接口组 | 语义 |
| --- | --- |
| Projects / Tasks | 创建有 Owner 的 DRAFT 任务，查询任务，用 submit/retry/cancel 命令推进状态 |
| Dependencies / Assignments | 人类修改可编辑任务的 DAG，选择 Agent 或能力队列 |
| Agents / Sessions | 人类注册 Agent，创建/撤销受限 Session；禁止 Agent 为自己扩大授权 |
| Runs | claim 原子创建 Run 与快照，heartbeat 续租，reports 上报观测 |
| Contexts | 建立权威来源，提交候选版本，人类发布并创建可引用快照 |
| Artifacts | Agent 登记内容引用，服务端补全责任链；人类接受/拒绝已核验成果 |
| Approvals / Invocations | 查询待审操作、提交人类决定、读取操作结果 |
| Reviews | Owner 对绑定 Run 与成果版本的验收作出接受/退回决定 |
| Events / Audit | 在当前权限下读取通知与历史证据 |

具体路径、请求字段和权限说明见 OpenAPI。没有通用的 `PATCH status` 或“由 Agent 发布领域事件”接口。审批请求由 Gateway 策略生成，不能让 Agent 自填低风险等级跳过策略。

## Adapter 握手与能力

[Adapter Schema](../contracts/schemas/adapter.schema.json) 定义 manifest、握手请求与响应。Adapter 提供稳定 `adapter_id`、自身版本、支持的协议版本、客户端元数据及能力；控制面选择一个双方支持的版本和能力集合。无交集返回 `UNSUPPORTED_PROTOCOL`，不可尝试猜测兼容性。

必须支持领取任务、读取快照、成果上报、心跳和接收取消意图。通知至少支持轮询，SSE 可选；自动启动和真正终止客户端进程单独声明为可选能力。`cooperative` 取消仅表示能向执行者展示/传递停止意图，不承诺命令已停止。

Local Bridge 流程：人类启动客户端 → 注册/授权 → 协商能力 → claim → 读取快照 → 执行 → 心跳/报告 → 登记成果。MCP 客户端可通过 Bridge 暴露的 `accp.tasks.claim`、`accp.context.read`、`accp.runs.report` 等工具使用相同逻辑。Bridge 不能通过抓取聊天文本宣称完成任务。

## 租约与并发

MVP 默认租约 90 秒、心跳建议每 30 秒；以服务端时间判断。claim 返回这些实际值及 fencing token。租约到期将 Run 标为 LOST，Task 转为 BLOCKED，等待人类决定重试。

同一 Task 只允许一个活跃 Run；旧 Session 的延迟报告、成果提交和工具调用必须被拒绝。旧客户端产生的本地文件可以作为后续新 Run 的显式输入，不追写旧 Run。数据库中的 fencing 不能阻止已开始的外部命令，网关需要版本条件和操作核对。

## 事件信封与订阅

[事件 Schema](../contracts/schemas/event.schema.json) 使用 CloudEvents `specversion: "1.0"`。事件包含唯一 ID、控制面 source、完整 type、subject、time、聚合版本及业务 data。`type` 命名为 `io.accp.<EVENT_NAME>.v1`，如 `io.accp.API_READY.v1`。

data 包含企业/项目、相关 Task/Run/Context/Artifact 引用、correlation_id 和 causation_id。只携带允许公开给相应订阅者的元数据，不广播 Context 正文、凭证或完整工具参数。关联与因果 ID 不授予资源访问权限。

| 事件 | 可信产生条件 |
| --- | --- |
| TASK_ASSIGNED | 人类授权的 Assignment 已提交 |
| TASK_STARTED | Run 和快照领取事务成功 |
| CONTEXT_PUBLISHED | 人类发布候选 ContextVersion |
| API_READY | API 成果已核验、人工接受，对应 API Context 已发布 |
| CODE_READY | 绑定不可变 revision 的代码成果已核验，可进入审核 |
| REVIEW_REQUIRED | 完成候选通过输入校验，Task 进入 IN_REVIEW |
| APPROVAL_REQUESTED / APPROVAL_DECIDED | 策略创建审批 / 人类决定提交 |
| TASK_COMPLETED | Owner 接受指定成果，Task 进入 DONE |
| TASK_FAILED | 一次 Run 失败或失去租约，Task 保留可恢复状态 |

SSE 使用事件游标作为 `id`，支持 `Last-Event-ID`；HTTP 轮询使用 `cursor` 与 JSON page。默认读窗口 7 天，过期游标返回 `410 CURSOR_EXPIRED`，客户端重新获取任务快照后建立新订阅。事件存储与审计保留期独立。

同一聚合按版本排序，不承诺不同任务全局有序。重复事件按 ID 去重，旧版本忽略；版本存在缺口则回读资源。重放只重建读模型或触发幂等处理，不能直接重放生产副作用。

## MCP 操作与审批桥接

Gateway 为 `/mcp` 资源服务器，并为下游 MCP 服务充当独立客户端。工具目录经允许列表筛选；校验工具 schema、资源边界、参数、Session/Run、权限和风险后才能执行。

需审批时，首次 `tools/call` **不执行下游操作**：持久化不可变 ToolInvocation 和 Approval，返回声明过的结构化 `approval_required` 结果与 invocation_id、approval_id。普通 MCP 客户端可读取人类可读说明；支持协作能力的 Bridge 可轮询 `/tool-invocations/{id}`。

人类批准只授权这一次已绑定操作。Worker 在重新检查权限、资源版本、策略和有效期后执行该持久化意图；结果通过查询接口返回，客户端不需要重新发起原始副作用。修改参数创建新意图，不能复用旧审批。低风险调用可以同步返回结果，但仍先持久化操作记录。

网关适配的工具响应必须声明上述结果形状，不能对客户端伪装成下游原始同步成功。无当前租约、审批过期或撤销时停止待执行操作；结果不明进入 UNKNOWN 并先核对外部系统。

## 兼容性与参考规范

公共契约拒绝未声明的业务字段；兼容扩展放入显式 `extensions`，键应采用组织命名空间，不得改变核心语义。新增必填字段、枚举或行为变化需升级协商版本并补充迁移说明。

- [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)
- [CloudEvents 1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)
- [MCP 2025-11-25 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP 授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
