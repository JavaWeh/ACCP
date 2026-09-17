# 候选版本管理员交接

## 范围与版本

本轮仅构建 v0.5.0-rc.N 候选，不正式发布，不升级日常环境。REST 使用 `/api/v1`，Adapter 协议仍为 0.2。API、Worker 必须使用同一候选提交；Bridge 包覆盖 Windows amd64、Linux amd64/arm64、macOS amd64/arm64。`--version` 输出版本、提交、构建时间、Go 和平台信息，无需读取凭据或连接服务。

构建命令为 `node scripts/build-candidate.mjs v0.5.0-rc.1`；本机可用 ACCP_GO 指定 Go 路径。安装包只包含公共部署配置、迁移、契约与手册，不包含 `.accp-local`、本机账号、skills 或私钥。SHA256SUMS 校验每个包及清单，Go/Web SBOM 分别生成。工作树有未提交修改时清单标记 dirty，不能作为可发布候选。

候选流水线对 PR 执行五个平台的原生基础启动验证，人工触发时同样只生成候选产物和镜像归档，不创建正式 Release 或推送生产标签。平台标签依据 [GitHub runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，基础启动不构成多客户端联合验收。

## 安装、升级与回退

新安装按 [生产部署手册](production-deployment.md) 生成独立配置、登记企业管理员、配置 TLS/OIDC 与最小数据库角色。用相同版本的 API、Worker、迁移和运维包；部署前核对 SHA256SUMS、镜像 digest、SBOM 与测试报告。

下载候选安装包与 images.tar.gz 后，先执行 `sha256sum -c SHA256SUMS`，再 `docker load -i images.tar.gz`。解压安装包，在 compose.env 设置 `ACCP_IMAGE=accp-api:v0.5.0-rc.1`，使用已加载镜像执行部署手册中的命令，不传 `--build`。Worker 复用同一 API 镜像的 worker 入口；单独提供同 digest 的 accp-worker 标签。运维命令使用 `accp-ops:v0.5.0-rc.1`，备份调度环境的 ACCP_OPS_IMAGE 也必须同步。安装包不包含源码构建上下文，源码构建请使用对应提交的仓库。

API/Worker 与运维镜像的操作系统和应用组件由 [Syft](https://github.com/anchore/syft) 生成 CycloneDX SBOM。依赖扫描包含 Go 可达调用、根目录和 Web npm 锁定依赖；秘密扫描覆盖完整 Git 历史。唯一历史排除项是迁移测试中读取 `existing-m1-key` 的 SQL 误报，使用精确提交/文件/规则/行指纹，不排除整条规则或整个测试目录。

已有数据库先按 [运维手册](operations.md) 完成加密备份及 verify-backup，记录安装版本、迁移摘要和镜像。进入维护状态，停止 API/Worker，运行前向 migrate、grants，再启动同版本服务并运行 doctor。迁移校验不匹配或失败时保持维护状态，修复原因后重试，禁止改写历史迁移。没有破坏性自动降级；不能确认兼容时恢复到全新隔离卷，用备份对应镜像核验。

恢复后 Session 被撤销，自动领取和工具执行保持关闭。先核对未结工具/外部副作用和恢复清单，再 finish-recovery 和退出维护。PostgreSQL 是恢复依据；禁止重放全部历史工具副作用。每小时备份，保留 48 小时份与 30 日份；加密公钥可在线，解密私钥离线保存。完成演练记录实际 RPO 与从事故到重新允许业务的完整 RTO。

## 审计、诊断与清理

项目 ADMIN 可通过 `GET /api/v1/projects/{id}/audit-export?limit=100&cursor=...` 分页读取审计，权限每页重新校验。这个在线视图可能包含导出期间的新记录；需要一致性完整交接时用本机 `accp-ops audit-export --database-url-file FILE --actor USER --project PROJECT --reason TEXT --output audit.ndjson`。后者使用单次 REPEATABLE READ 事务流式写入，不把全部审计加载到内存。输出包含导出主体、项目、时间、原因和快照模式，文件默认 0600，已存在时拒绝覆盖。

`accp-ops diagnostics` 使用同一组数据库/actor/project/reason/output 参数，生成版本、迁移校验值、维护状态及计数。默认不包含正文、账号列表、密码、token、外部工具参数或环境变量；提供支持前仍应核对文件适用项目。

`accp-ops cleanup --database-url-file FILE --actor USER --project PROJECT --reason TEXT` 默认仅预览过期项目幂等记录数量；加 `--execute` 才删除并追加不可变审计。任务、Run、快照、Context 正文、成果、审计、工具账本与 Outbox 均不删除。企业幂等记录及其他运行数据本轮保留；长期保留策略不能以磁盘压力为由被自动绕过。

## 故障与交接责任

内部指标和告警见 [运行保障验收](acceptance-product-operations.md)。API 错误优先检查诊断、数据库、Worker 心跳与 Outbox；UNKNOWN 始终核对外部结果，禁止盲目重试。数据库/NATS/Session 轮换从本机入口运行并保存 operation ID；中断后使用原记录 resume。

交接清单：指定人类 Owner 与管理员、离线密钥保管人、每小时备份执行机器、恢复隔离卷位置、镜像/包摘要、测试与容量报告、未关闭缺陷。候选是否可发布以 [产品计划](product-delivery-plan.md) 的代码、测试、演练三列为准，不把流水线存在或镜像构建成功视为完整通过。
