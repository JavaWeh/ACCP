# 短期容量验证

## 数据与运行方式

仅在独立空数据库 `accp_capacity` 运行，必须设置 `ACCP_BENCH_ISOLATED=1`。使用 [容量 Compose](../deploy/capacity/compose.yaml) 限制总资源为 8 vCPU、16 GiB：PostgreSQL 3/10 GiB、NATS 1/2 GiB、HTTP 控制面与驱动 4/4 GiB。无宿主数据库端口、无日常环境复用，不关闭 PostgreSQL 持久化。

```sh
node scripts/capacity-env.mjs .accp-local/capacity-optimized
docker build -f deploy/capacity/Dockerfile -t accp:bench-optimized .
```

将新目录 compose.env 的 ACCP_BENCH_IMAGE 改成上一步镜像。每轮使用不同 Compose 项目名和新目录、新卷，先运行 `docker compose -p accp-capacity-optimized --env-file .accp-local/capacity-optimized/compose.env -f deploy/capacity/compose.yaml run --rm bench -mode seed`，再使用同一配置 `run --name accp-capacity-optimized-run bench -mode run -label optimized`。保留任务容器和 report.json 以便核对退出码与日志。`-smoke` 仅 30 秒脚本检查，报告永不判为容量通过。

种子使用真实 bootstrap/Context API，再批量插入 100000 个草稿任务及关联。50 人、20 项目，其中热点项目 70000 个任务。20 个 Run 通过注册、委托、握手、分配、提交和 claim API 创建，每 5 秒续租；每个 Run 提交正文成果与独立人工批准的工具操作。受控下游将每次调用同步追加到数据库之外的 receipt 文件，重复执行也记录；运行期间重复调度，最终核对 20 次调用、20 个成功账本、零重复。

请求为 40% 服务端筛选分页、20% 草稿写入、10% 项目概览、10% 明确的跨项目拒绝、20% 详情。热点和多项目由任务分布及轮转查询共同覆盖。固定到达时间调度，不因慢响应降低目标发送量；延迟从计划到达时间计算，最多 128 个在途请求，溢出记为失败。HTTP 使用真实开发凭证数据库校验；TLS/OIDC 与真实 Git 由独立浏览器演练证明，不混入 API 压测数据。

## 指标和判定

每轮预热 5 分钟、50 RPS 稳定 20 分钟、100 RPS 突发 5 分钟。稳定和突发均检查读 p95 ≤500 ms、写 p95 ≤1000 ms、非预期错误率 <0.5%、事件可见 p95 ≤5000 ms；预热仍记录但不作为最终门槛。事件时间为 Outbox 提交到 feed 落库；未落库事件按当前年龄计算并单列积压，不能只统计成功事件。阶段报告立即写盘；未有 complete=true 的结果属于中断，不能标为完整通过。

安全门槛包括最低活跃 Run 20、心跳错误 0、重复活跃 Run 0、外部调用重复 0。Project 授权锁、运行 fencing、唯一活跃 Run 约束、持久幂等与 UNKNOWN 不重试保持原样。实际测试结果及限制随候选交付更新，工具存在不能代替门槛通过。

## 优化与风险

新增前向迁移 009，匹配筛选列表的排序表达式，增加未投递 Outbox 索引。连接池默认仍为 10，可配置 2–64；生产 API 默认 20、Worker 10，空闲和生命周期有上限。事件 Worker 每 250 ms 最多处理 64 条且单轮期限 1 秒；延迟 NAK/ACK 未确认消息继续轮询。每条事件仍使用原项目/投递顺序、发布 ID、Inbox 去重和 ACK，不直接执行历史工具副作用。

批处理与池配置需要在最终提交重跑全量 race 和实际负载。基线未优化镜像与优化镜像应分别保存 digest、阶段报告和退出状态，不覆盖失败或中断的结果。本轮不包含连续稳定性观察与正式生产放行。
