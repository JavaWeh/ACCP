# 贡献指南

欢迎为 ACCP 改进使用体验、修复缺陷、完善文档或扩展协作能力。产品介绍与本地试用见 [README](README.md)；本指南帮助贡献者准备开发环境、验证变更并提交可审核的 PR。

## 选择贡献内容

先搜索已有 [Issue](https://github.com/JavaWeh/ACCP/issues) 和 [PR](https://github.com/JavaWeh/ACCP/pulls)，避免重复工作。文档纠错和小范围修复可直接提交 PR；新能力或架构调整先通过 Issue 说明使用场景、范围和验收条件，并与 [产品交付计划](docs/product-delivery-plan.md) 对齐。

| 类型 | 入口 | 需要说明 |
| --- | --- | --- |
| 缺陷报告 | [Bug 模板](.github/ISSUE_TEMPLATE/bug_report.yml) | 环境、复现步骤、预期与实际行为、验收条件 |
| 功能建议 | [Feature 模板](.github/ISSUE_TEMPLATE/feature_request.yml) | 用户遇到的问题、预期收益、方案及范围 |
| 明确的贡献任务 | [Task 模板](.github/ISSUE_TEMPLATE/task.yml) | 目标、相关资料与依赖、成果、验收条件及风险 |

每个 Issue 都需要人类 Owner；尚未分配时，报告者可先填写自己的 GitHub 用户名，移交后更新。日志、配置、截图和附件应脱敏，不包含凭证或真实业务数据。

## 准备开发环境

从最新 `main` 创建开发分支，没有仓库写权限时先 fork，再克隆自己的仓库。开发分支遵循 [开发工作流](docs/development-workflow.md)，使用 `dev/<topic>` 或任务明确指定的分支名。

按改动范围准备工具，无需为纯文档修改启动整个平台：

| 工具 | 使用场景 | 版本依据 |
| --- | --- | --- |
| Node.js 与 npm | 文档、契约工具和 Web 开发 | Node.js 22.22.3、npm 10；见 [package.json](package.json) |
| Go | API、Worker、Bridge 和 SDK 开发 | [go.mod](go.mod) |
| Docker 与 Compose v2 | 本地平台、数据库和事件集成验证 | [本地 Compose](compose.yaml) 与 CI 配置 |
| Chromium | Web 组件与端到端测试 | 由仓库锁定的 Playwright 安装 |

在仓库根目录安装文档与契约工具：

```sh
npm ci --ignore-scripts
```

需要完整平台时，按 [README 快速开始](README.md#快速开始) 创建独立开发环境。升级已有环境请先阅读 [升级说明](docs/m3-m4-platform.md#运行与升级)，保留数据卷并跳过首次初始化。

### 找到相关代码

| 目录 | 内容 |
| --- | --- |
| `web/` | React 控制台，独立的依赖与构建配置 |
| `cmd/accp/`、`internal/` | Go API、Worker、身份、任务、治理及运维实现 |
| `cmd/accp-bridge/`、`pkg/client/` | 本地 Bridge 与 Go 协作 SDK |
| `contracts/` | OpenAPI、Schema、正例与预期拒绝的反例 |
| `docs/` | 用户指南、部署运维、架构、协议与 ADR |
| `scripts/`、`deploy/` | 校验工具、本地配置、部署与运维脚本 |
| `.github/` | Issue / PR 模板与持续集成 |

领域模型和设计依据见 [架构](docs/architecture.md)、[数据模型](docs/data-model.md)、[协作协议](docs/protocol.md) 和 [ADR 索引](docs/adr/README.md)。

## 开发与验证

### 所有变更的基础检查

在仓库根目录运行：

```sh
npm run check
git diff --check
```

`check` 覆盖 Markdown、内部链接与锚点、OpenAPI、Schema、契约正反例、验证工具测试和私有文件禁入规则。修改契约时同步协议文档和正反例；结构校验不能替代运行时权限与状态机测试。

README 面向产品使用者，说明用途、能力和上手路径；开发命令放在本指南或对应模块文档，设计取舍放在 ADR。描述功能时区分已实现行为、实际验证结果和后续计划。

### Go 控制面、Worker、SDK 与 Bridge

先对改动的 Go 文件运行 `gofmt -w <file.go>`，再执行：

```sh
go mod download
go mod verify
go vet ./...
go test ./...
go build ./cmd/accp ./cmd/accp-bridge
```

涉及数据库、权限、状态机或事件协作时，准备专用测试 PostgreSQL 和启用 JetStream 的 NATS，配置 `ACCP_TEST_DATABASE_URL` 与 `ACCP_TEST_NATS_URL` 后运行：

```sh
go test -race -tags=integration -count=1 ./...
```

测试数据库用户需要创建 schema 的权限，不得连接生产数据库。Windows 的 race 检测需要 C 编译器，CI 在 Linux 上执行。环境配置与 smoke 步骤见 [执行层开发与验收](docs/m2-execution.md#开发验证与验收)。

### Web 控制台

在仓库根目录安装前端依赖并启动开发服务：

```sh
npm --prefix web ci --ignore-scripts
npm --prefix web run dev
```

Vite 默认将 `/api` 代理到 `http://127.0.0.1:18080`。若使用 README 的默认本地部署，可在忽略文件 `.accp-local/compose.env` 中将 `ACCP_HTTP_PORT` 设为 `18080`，并将 `ACCP_PUBLIC_URL` 改为 `http://127.0.0.1:18080`，然后重新运行 Compose 启动命令。开发认证入口为 `/dev-login`，账号来自该部署生成的 `.accp-local/dev-users.json`。

提交 Web 变更前，从仓库根目录运行格式和构建检查，再进入 `web/` 执行组件测试：

```sh
npm --prefix web run check:format
npm --prefix web run build
cd web
npx playwright install chromium
npm run test:ui
```

`test:ui` 使用合成 API 响应，不需要后端，覆盖组件交互、键盘操作、多语言和移动布局。UI 约定、翻译与品牌资源见 [Web 开发说明](web/README.md)。

修改登录或真实业务流程时，还需运行连接独立开发部署的端到端测试。在 `web/` 目录的当前 shell 中设置 `ACCP_WEB_URL` 为实际 API 地址、`ACCP_WEB_CREDENTIALS_FILE` 为对应凭证文件路径（例如 `../.accp-local/dev-users.json`），再执行 `npm test`。测试会创建真实数据，不得指向生产环境；组件测试不能替代这项验证。

### 部署、恢复与外部接入

涉及数据库迁移、身份认证、密钥、备份或工具副作用的变更，应在隔离环境验证正常与失败路径，并说明兼容性、升级和恢复方式。

对应步骤见 [生产部署](docs/production-deployment.md)、[运维与恢复](docs/operations.md) 和 [受控工具接入](docs/m3-m4-platform.md#工具配置与-mcp-gateway)。保留脱敏的检查结果，明确目标环境与未覆盖项；不要把样例验收扩大为任意客户端、多人或生产兼容性结论。

## 提交 Pull Request

使用 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)，让每个 PR 围绕一个可审核的目标：

1. 说明用户遇到的问题、触发场景和变更后的行为，关联 Issue；修复使用 `Closes #<编号>`，仅引用使用 `Refs #<编号>`。
2. 标明人类 Owner、审核人，以及相关 Context、ADR 或接口契约。Agent 可作为执行工具记录，由人类对变更负责。
3. 填写实际运行的检查、结果和证据；未运行或失败的检查说明原因，不勾选为通过。
4. 说明权限、协议和数据兼容性影响；涉及迁移或部署时附升级步骤与回退或恢复方案。
5. 响应审核意见并处理 CI 失败，检查通过且人类接受后合并。Agent 自评不能替代审核，高风险变更不得自动合并。

公共接口变化同步契约及示例，重要架构取舍补 ADR。提交信息使用 `docs:`、`feat:`、`fix:`、`test:` 或 `chore:` 等明确前缀；保留远程历史，不强制推送共享分支，不夹带无关改动。

## 提交与推送检查

使用明确的文件清单暂存，避免 `git add .`。暂存后在仓库根目录运行：

```sh
git diff --cached --name-only
git diff --cached --check
npm run check:private
```

审核暂存内容并提交后、推送前，再运行：

```sh
npm run check:history
```

私有文件检查覆盖索引与工作区候选公共文件；历史检查扫描 `HEAD` 的全部可达提交，包含后来已删除的文件。禁止提交 skills、个人 Agent 配置、本地索引、凭证和环境数据。检查器不能识别所有秘密，提交者仍需核验内容。

发现私有内容已进入本地提交时，停止推送并修复尚未公开的历史；已经公开的凭证应立即撤销。CI 发生在上传之后，不能代替本地推送前检查。完整流程见 [开发工作流](docs/development-workflow.md)。
