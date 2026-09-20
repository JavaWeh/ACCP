# 运维、备份与恢复

本文适用于单企业单机 Compose 候选版本。日常环境升级、正式发布及多端联合验收不在本轮范围。生产角色和 TLS 初始安装见 [部署说明](production-deployment.md)。

## 本机维护

使用迁移账号从本机工具容器执行，HTTP 不提供数据库或密钥管理权限：

```sh
accp maintenance --action check
accp maintenance --action enter --actor USER_ID --reason 'Scheduled maintenance'
accp maintenance --action status
accp maintenance --action leave --actor USER_ID --reason 'Verification completed'
```

`DATABASE_URL_FILE` 指向迁移账号私有文件。执行人必须是当前有效项目 ADMIN。进入维护等待已有事务，拒绝尚未结算的 RUNNING 工具操作；失败有日志，可在操作结束或成为 UNKNOWN 后重试。维护期间允许读取和已授权 UNKNOWN 核对，其他写入返回 `503 MAINTENANCE`。客户端应保留原请求与幂等键。

密钥轮换由 `scripts/rotate-production.mjs` 完成。指定部署目录、Compose 环境文件、项目名、人类执行人、原因和 `database`、`nats` 或 `session` 类型；先 `--phase prepare`，再用返回的 `--operation UUID --phase apply`。状态可用 `--phase status` 查询。准备目录包含秘密，须与部署秘密使用相同访问控制，不进入版本库或诊断包。

轮换先进入维护，再停止 API/Worker。数据库轮换在事务中更新五个固定角色；NATS 轮换重建消息服务；Session 轮换保留旧验证键并切换活动签名键。旧 Session 仍受数据库撤销和过期检查约束。达到八个验证键上限时拒绝新增；旧键退休必须确认其令牌全部过期，不能直接删除仍使用的验证键。

中断后修复故障，使用原操作 UUID 继续，复用已经准备的密钥。检查未通过时保持维护；不要回填旧密码来猜测当前状态。执行记录标为 `SUCCEEDED` 前必须通过安装 doctor。该工具需要本机 Docker 管理权限。

## 加密备份

构建 `deploy/production/Dockerfile.ops`，获得包含 PostgreSQL 客户端的 `accp-ops` 镜像。恢复身份在独立离线位置创建：

```sh
accp-ops keygen --identity-file /offline/accp-backup-identity
accp-ops backup --database-url-file /run/backup-url --recipient AGE_PUBLIC_KEY \
  --config-manifest /run/public-config.json --image accp@sha256:IMAGE_DIGEST \
  --output /backups/backup.age
accp-ops verify-backup --input /backups/backup.age --identity-file /offline/accp-backup-identity
```

公开配置清单是字符串映射，记录配置文件摘要、部署版本和重建所需公开配置；禁止填写密码、token 或私钥。备份源必须使用 `accp` schema。备份包采用 [age 文件加密](https://pkg.go.dev/filippo.io/age)，同时校验导出文件摘要；公钥加密不认证备份发送者，恢复只使用可信备份目录及对应运行记录中的包。

定时入口为 `scripts/hourly-backup.mjs`。它只挂载数据库 URL、公开配置清单和备份目录，不挂载解密私钥。通过 `--recipient-file` 提供公钥，`--network` 指定部署私有网络，`--image` 和 `--ops-image` 使用候选产物的不可变标识。Linux 可安装 `deploy/production/accp-backup.service` / `.timer`，按 service 中列出的变量配置 `/etc/accp/backup.env`。Windows 任务计划每小时运行相同 Node 命令，关闭重叠实例。

保留最近 48 份小时包与每天首份的最近 30 份日包。清理仅匹配调度器自己的备份文件名，不删除数据库业务证据。备份失败不推进保留清理。`backup-journal.jsonl` 记录运行结果；进程被强制杀死后，确认没有备份仍在运行，再由本机操作者移除残留 `backup.lock`。工具临时目录需要足够容量，默认调度容器使用 4 GiB 临时文件系统；最终容量验收须确认是否需要调整。

## 全新隔离卷恢复

1. 启动全新 PostgreSQL 卷和空数据库，隔离 API/Worker；不对旧业务库执行覆盖。创建操作者账号，不安装运行时 ACL。
2. 校验备份，再运行 `accp-ops restore --isolated --database-url-file TARGET_URL_FILE --input BACKUP --identity-file OFFLINE_IDENTITY --actor ADMIN_ID --reason REASON --incident-at RFC3339_TIME`。
3. 恢复会比较全部表摘要，撤销旧 Session，关闭活跃 Run，把未结外部操作标记 UNKNOWN，并设置维护状态。失败或中断后保留隔离，使用另一个全新数据库重试。
4. 根据清单安装对应镜像、工具配置、新密钥和最小角色权限。创建四个非超级用户角色后，本机恢复操作者执行 `deploy/production/restore-ownership.sql`，将 schema、表、序列及函数所有权交还 `accp_migrator`，再执行 `grants.sql`；不要直接用运行时账号访问恢复库。
5. 从空 JetStream 卷启动消息服务。数据库只重新投递未进入 Feed 的事件；已有 Feed 通过数据库读取。不得把历史工具调用作为任务重新执行。
6. 项目 ADMIN 在运维页核对 UNKNOWN 的外部结果。每个恢复项通过 `accp-ops resolve-recovery --database-url-file FILE --item ID --actor ADMIN_ID --reason EVIDENCE` 留证；工具项必须先经原治理接口确认成功或失败。
7. 全部核对完成，执行 `accp-ops finish-recovery --database-url-file FILE --actor ADMIN_ID --reason EVIDENCE`，再执行 `accp maintenance --action leave`。重新建立 Session；旧 Session 不复活。

恢复 JSON 报告提供快照时间、表摘要、RPO 和恢复命令耗时。实际业务 RTO 还包括人工核对、权限重建和部署，必须另计；不能把命令耗时直接宣称为完整业务 RTO。任务、快照、成果、审计与副作用账本均保留。

## 监控与故障处置

API 指标通过单独内部端口 `9090/metrics` 暴露，公网 Caddy 不转发该端口。将 `deploy/monitoring/compose.yaml` 叠加在生产 Compose 后，预先创建仅本机可管理的 `secrets/grafana_password`。Prometheus/Grafana 只绑定本机 `19090` / `13000`，外部管理员使用受控隧道访问。规则和仪表盘随仓库提供。

| 信号 | 处置 |
| --- | --- |
| 数据库不可用 / API 5xx | 检查数据库健康和磁盘容量；保持幂等键，恢复后核对提交结果 |
| Outbox 积压 / 消费失败 | 检查 NATS、契约和 Worker；仅项目 ADMIN 可在运维页授权重放 |
| Worker 60 秒无进展 | 检查进程和依赖；恢复后确认进展指标更新及告警解除 |
| 租约丢失 | 核查运行和副作用；不能使用旧 fencing token 继续写入 |
| UNKNOWN / 恢复待核对 | 查询原外部系统，不自动重试；保留原绑定、审批和责任主体 |
| 待审批 | 由有效独立审核人处理，不能用重放或本机脚本绕过审批 |

项目运维页仅当前项目 ADMIN 可用，诊断不包含数据库密码、工具参数或正文。Keycloak 签名轮换遵循其 [官方管理员说明](https://www.keycloak.org/docs/latest/server_admin/)；本仓库的 `oidc-lifecycle-fixture.mjs` 仅针对隔离测试实例。
