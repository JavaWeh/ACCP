# 协议契约

本目录包含 ACCP v0.1 基础模型和 v0.2 执行增量。OpenAPI 的 `x-accp-milestone: M1` / `M2` 表示当前实现，`future` 表示后续能力；M2 支持人类身份和受限 Agent Session。运行限制与验收见 [M2 异构执行](../docs/m2-execution.md)。

## 入口

- [OpenAPI](openapi.yaml)：REST 请求、响应、鉴权、版本与错误。
- [Domain Schema](schemas/domain.schema.json)：领域模型和命令输入输出。
- [M2 Schema](schemas/m2.schema.json)：0.2 能力协商、领取必需代码版本、新增事件和分页输出。
- [M1 Schema](schemas/m1.schema.json)：人类/项目查询、角色变更与不可变内容上传。
- [Event Schema](schemas/event.schema.json)：CloudEvents 信封与十类领域事件。
- [Adapter Schema](schemas/adapter.schema.json)：manifest 与协议能力协商。
- [示例清单](examples/manifest.json)：每个正例与预期失败反例的 Schema 引用。

Schema 的 `$id` 和 OpenAPI server 使用 `accp.example` 保留域名，仅为文档标识，不存在可调用的部署服务。示例 ID、用户、URI 和摘要均为虚构，客户端名称 A/B 表示异构接入模式。

## 正反例与校验

```sh
npm ci --ignore-scripts
npm run check:openapi
npm run check:contracts
npm run test:tooling
```

正例覆盖核心请求、输出、十类事件和两种 Adapter。反例覆盖缺少 Owner、错误协议版本、事件类型与载荷不匹配、来源缺失、非法状态、缺少租约 token 和审批主体结构错误。

反例是预期被拒绝的 JSON，不是可直接使用的请求模板。校验器检查它们确实失败，并核对预期的校验关键字，避免因另一个偶然错误通过负例测试。

## 结构与语义的分界

JSON Schema 可拒绝未知字段、缺失字段、错误类型和不支持的枚举。它不能证明 owner_user_id 对应人类成员、审批人具有权限、依赖无环或事件来源可信；这些要求见 [数据模型](../docs/data-model.md)、[治理](../docs/governance.md) 和 [MVP 运行时验收](../docs/mvp.md)。

源于 Run 的 provenance 由服务端补全，客户端不在成果登记请求中自行填写。审批决定接口只接受人类认证主体，不能通过传入 `actor_type: HUMAN` 获得审批能力。

## 维护规则

协议与示例修改须同步 [协议说明](../docs/protocol.md)。OpenAPI 引用独立 Schema，避免维护重复模型。所有 POST 使用幂等键；已有资源变更要求版本前置条件，Run 写操作还要求 fencing token。

新增核心字段或行为需兼容性评审；破坏性变更升级协议版本。不要把厂商私有字段加入业务必填项，扩展放入显式 extensions。
