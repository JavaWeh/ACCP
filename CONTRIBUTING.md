# 贡献指南

ACCP 当前已实现 M1–M3 控制面和 M4 Web 产品功能；单人双客户端样例验收已完成，见 [实际记录与限制](docs/acceptance-2026-09-16.md)。业务实现须对应已确认的 MVP 任务，不能把样例结果扩大为任意客户端、多人或生产兼容性。范围和验收见 [MVP 路线](docs/mvp.md)。

## 开始贡献

1. 阅读 [项目说明](README.md) 和 [开发工作流](docs/development-workflow.md)，确认变更所属阶段。
2. 搜索已有 Issue 和 PR，避免重复；按下表选择模板，先明确问题、范围和验收条件。
3. 从最新 `main` 创建开发分支；没有仓库写权限时先 fork，再在自己的仓库中开发。
4. 完成相关验证，通过 PR 提交变更，并响应人类审核意见。

| Issue 类型 | 适用场景 | 必填信息 |
| --- | --- | --- |
| [缺陷报告](.github/ISSUE_TEMPLATE/bug_report.yml) | 已实现功能与预期不符 | 人类 Owner、环境、复现步骤、预期与实际行为、验收条件 |
| [功能建议](.github/ISSUE_TEMPLATE/feature_request.yml) | 新能力或现有流程改进 | 人类 Owner、问题、方案与范围、Context、验收条件 |
| [协作任务](.github/ISSUE_TEMPLATE/task.yml) | 已明确的文档、契约或实现工作 | 人类 Owner、目标、Context 与依赖、成果与验收、风险 |

尚未分配负责人时，报告者可先填写自己的 GitHub 用户名，并在移交时更新。公开 Issue、PR 和附件中的日志、配置及截图必须脱敏，不包含 token、凭证或真实业务数据。

## 责任与证据

- 每个 Issue 有人类 Owner；Agent 名称只填写为执行工具。
- 提交设计依据：Context 版本、关联 ADR、接口契约和验收条件。
- PR 说明问题、最终行为、成果与验证证据；人类确认后合并。
- Agent 自评不能代替审核，高风险变更不得自动合并。

## 分支与提交

- 默认分支为 `main`，开发分支使用 `dev/<topic>`，或任务明确指定的分支名。
- 首次基线按维护者授权直接进入 `main`；后续变更使用 PR。
- 提交信息使用 `docs:`、`feat:`、`fix:`、`test:` 或 `chore:` 等明确前缀。
- 保留远程历史，不强制推送共享分支；不要夹带无关改动。
- 公共规范不要求访问任何个人机器上的文件或服务。

## 本地开发与验证

### 文档与契约

需要 Node.js 22.22.3 和 npm 10，版本约束以 [package.json](package.json) 为准。在仓库根目录运行：

```sh
npm ci --ignore-scripts
npm run check
git diff --check
```

契约修改要同步正反例及协议文档。结构校验不能替代服务端权限与状态机测试，未实现的行为应在验收矩阵中标为待实现。

### Go 控制面、SDK 与 Bridge

源码开发使用 [go.mod](go.mod) 指定的 Go 版本。修改 Go 代码后，先对改动文件运行 `gofmt -w <file.go>`，再执行：

```sh
go mod download
go mod verify
go vet ./...
go test ./...
go build ./cmd/accp ./cmd/accp-bridge
```

涉及数据库、权限、状态机或事件协作的变更，还需使用专用测试 PostgreSQL 和启用 JetStream 的 NATS。配置 `ACCP_TEST_DATABASE_URL`、`ACCP_TEST_NATS_URL` 后运行：

```sh
go test -race -tags=integration -count=1 ./...
```

测试数据库用户需要创建 schema 的权限，不得连接生产数据库。Windows 的 race 检测需要 C 编译器；CI 在 Linux 上执行。集成测试及本地 Docker Compose v2 启动、升级和 smoke 验收步骤见 [M2 开发说明](docs/m2-execution.md)。

### Pull Request

使用 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 说明问题、最终行为、关联 Issue、Context 和人类责任。修复 Issue 时可填写 `Closes #<编号>`；仅引用时使用 `Refs #<编号>`。

- 让每个 PR 围绕一个可审核的目标；架构取舍补 ADR，公共接口变化同步契约及示例。
- 填写实际运行的检查、结果和验证证据；未运行或失败的检查说明原因，不勾选为通过。
- 涉及数据迁移、兼容性或部署时，说明影响、升级步骤及回退方式。
- 提交后查看文档/契约与控制面 CI 结果，处理失败及审核意见；检查通过且人类接受后合并。

## 提交与推送检查

使用明确文件清单暂存，避免 `git add .`。暂存后重新运行 `npm run check:private`，提交后运行 `npm run check:history`，再推送已验证的提交。

检查器同时检查索引与工作区候选公共文件，并扫描 `HEAD` 的全部可达历史。即使私有文件后来被删除，历史中曾包含它仍会导致失败。CI 检查发生在上传后，不能代替本地推送前检查。

禁止提交任何 skills、本地 Agent 配置、索引数据、真实凭证或环境数据。若发现私有内容已在提交中，停止推送，先修复尚未公开的本地历史；已经公开的凭证需要立即撤销，不能依赖后续删除文件。

详见 [开发工作流](docs/development-workflow.md)。
