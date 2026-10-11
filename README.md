# Agent 自动化评测系统

## 工作台信息架构

工作台按照评测闭环划分为四个一级模块；进入模块后，通过页面顶部的二级标签切换具体任务：

- **总览**：展示项目、批次、执行用例和当前评测集，并提供评测集、跑测和报告的快捷入口。
- **评测集管理**：评测集列表、测试用例、审核与发布、评测规则。
- **跑测工作台**：新建跑测、RAG 自动采集、Agent 链路跑测、评测模型、运行任务。原有 Playwright 批量提问、回复采集、耗时记录和证据截图完整保留在“RAG 自动采集”。
- **根因分析**：评测报告、Bad Case、失败归因、版本对比、回归验证。

一轮完整跑测始终要求选择被测对象、包含已审核用例的评测集、执行方式和至少一项规则。检索规则会条件要求 Top-K，Agent 过程规则会条件要求 Trace，产物规则会条件要求输出文件；截图、评判模型、人工复核、并发、重试和对比基线属于可选配置。最终形成“评测集 → 执行与证据 → 报告 → 归因 → Bad Case → 回归”的可复用闭环。

评测集属于当前项目，名称由用户自由填写和修改，例如“黄金测试集”“异常场景集”。先创建并命名评测集，再把 Excel 用例导入当前选中的评测集；导入时不会再次要求填写名称或创建同名集。“测试用例”只展示当前选中评测集中的内容。系统内部使用稳定 ID 关联数据，跑测时可按名称选择，不要求用户维护版本号。

评测集卡片支持单独删除，删除前会确认；只属于该集的用例及其运行记录会被删除，共用用例保留。“发布”目前仅标记草稿/已发布状态，不冻结内容或限制跑测，页面会明确提示这一点。

## 评测模型配置

进入“跑测工作台 → 评测模型”，模型分为两类：**内置模型**由 `src/judge-models.ts` 列出模型 ID，共用本机 `.env` 的 `PI_PROVIDER=openai`、`PI_BASE_URL` 和 `PI_API_KEY`，网页只负责选择与测试连接；**自定义模型**可为当前项目填写另一组名称、Base URL、模型 ID 和 API Key，支持编辑与删除。两类模型都可设为项目默认模型，也可在“新建跑测”中切换默认模型。Agent 链路的“过程检查 + 模型评判”还可单次选择具体模型；纯规则检查不调用模型。RAG 及其他 pi Agent 评判阶段使用当前项目默认模型。首次加载时默认选择 `PI_MODEL` 对应的内置模型。

功能代码由 Git 管理；内置模型的共用密钥只在 Git 忽略的 `.env`，自定义模型密钥及各项目默认选择保存在 Git 忽略的 `data/judge-models.local.json`，API 不回显密钥。两份文件均为本机明文配置，仅适合单用户运行，请勿上传或分享。旧版自定义模型数组可自动读取；首次修改后写入新格式。删除自定义配置不清除历史评测结论；结果中保存当次评测模型的名称和模型 ID，便于追溯。

## Agent 过程评测（Langfuse）

从“跑测工作台 → Agent 链路跑测”进入，过程评测独立于原有 RAG 回答评测。

1. 在本地 `.env` 配置 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`，重启服务。密钥来自被测 Agent 日志所在的 Langfuse 项目，不是模型 API 密钥。
2. 填写指定任务的 Trace ID（不是网页地址），可关联测试用例，点击“读取 Trace”。默认查询近 30 天，可修改时间范围。日志异步上传，未完成时稍后重新读取。
3. 按“关联评测集 → 关联测试用例”选择当前项目中的用例，再读取 Trace，自动载入预期答案、完整预期轨迹、必需工具、禁止工具、参数约束与评分标准。也支持先读取 Trace，再点击“将所选用例要求载入当前任务”；此操作替换当前要求并清除旧结论。查看调用树时可点击节点查看输入、输出和耗时，也可离线导入 Trace JSON。
4. 核对并编辑本次评测要求。评分标准优先使用用例标准，缺省使用项目标准；本次修改不反写评测集。精确参数检查可填写 JSON 数组，例如 `[{"name":"video_trim","parameters":{"startTime":0,"endTime":4}}]`，参数名以实际工具输入为准。
5. “仅检查执行过程”运行确定性规则，包含禁止工具检查；“进行评测”要求非空评分标准，并将本次要求与实际 Trace 交给所选模型评判。自然语言轨迹及参数约束由模型判断，实际文件产物需独立验收。成功评测后保存当次要求和结论；重新读取同一用例的 Trace 保留已编辑要求，需要同步测试集时使用载入按钮。未配置真实模型时不会使用演示评分。

结论区分通过 / 不通过 / 待核验；异常可能被后续调用恢复，不直接等同任务失败。仅有 Trace 不能独立验证视频文件等产物，仍需单独检查。

脱敏链路、预期要求和评测结果保存在 SQLite 的 `agent_evaluations` 表；同项目、来源和 Trace ID 重读更新副本并清除旧结论，不覆盖原有回答评测记录。没有自动取最新日志，避免并发串链。API 可供评测脚本读取：

- `GET /api/langfuse/status`：配置状态，不返回密钥。
- `GET /api/projects/{projectId}/agent-evaluations`：评测记录列表。
- `POST /api/projects/{projectId}/agent-evaluations`：读取，提交 `{ "trace_id": "...", "case_id": 1 }`；可选 `run_id`、`from`、`to`，离线导入增加 `observations`。
- `GET /api/projects/{projectId}/agent-evaluations/{id}`：链路、要求和结论。
- `POST /api/projects/{projectId}/agent-evaluations/{id}/evaluate`：提交 `{ "tools": [{"name":"video_trim"}], "ordered": false, "expected_answer":"输出前4秒视频", "semantic": false }`。

按 [Langfuse 官方 Observations API](https://langfuse.com/docs/api-and-data-platform/features/observations-api) 实现 v2 分页，并显式读取 I/O。自部署 Langfuse v3 设置 `LANGFUSE_API_VERSION=v1`；不会在认证失败后自动切换接口。

验证：`npm test` 运行接口与规则测试；`npm run build` 后运行 `node scripts/verify-agent-ui.mjs` 验证导航、离线导入、节点输入输出、评测及窄屏布局。后者使用临时数据库、独立无界面 Chromium，截图保存到已忽略的 `.codex-tmp/agent-ui-qa/`。

完全使用 TypeScript/Node.js 构建的 Agent 评测工作台，`pi-mono / pi-agent-core` 负责评测 Agent 的模型循环、工具调用、事件流和状态；不依赖 Python。

## 功能

- 录入被测 Agent 的背景、能力、限制和评分标准
- pi Agent 分析资料缺口并反复生成追问
- pi Agent 通过结构化工具提交候选测试集
- 人工编辑标准答案、关键词、禁止内容并审核
- 自动执行单轮和多轮测试
- 记录回复、耗时、轮数和工具调用
- 规则评分与 pi Agent 失败归因
- HTML 报告和 Excel 报告
- SQLite 本地持久化
- Mock 被测 Agent 与 OpenAI 兼容接口

## 技术结构

```text
浏览器工作台
    ↓
Node.js HTTP API
    ├─ node:sqlite 数据层
    ├─ pi-agent-core 评测 Agent
    ├─ Playwright 浏览器执行器 / API 适配器
    ├─ 规则评分器
    ├─ ExcelJS / HTML 报告
    └─ 静态页面服务
```

核心目录：

```text
src/
  server.ts            HTTP API、页面服务和启动入口
  db.ts                SQLite 数据层
  services.ts          用例生成、执行编排和 pi Agent 接入
  agents.ts            被测 Agent 适配器
  browser-runner.ts    Playwright 对话、回复采集与证据截图
  evaluator.ts         确定性规则评分
  reports.ts           HTML / Excel 报告
  domain.ts            领域类型
pi-agent/src/
  harness.ts           pi-agent-core 循环和受控工具
  types.ts             pi Agent 输入输出协议
static/                评测工作台页面
```

## 启动

需要 Node.js 24+。

```powershell
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:8000>。

Windows 下也可以直接双击项目根目录的 `启动评测系统.cmd`。需要使用有界面的 Playwright 浏览器时，建议采用该方式启动；由后台工具启动的服务可能只能创建浏览器进程，无法在桌面显示窗口。

## pi Agent 模型

没有配置真实模型时，系统使用 pi 官方 Faux Provider，仍然执行完整的：

```text
Agent → tool call → tool result → Agent
```

项目启动时会自动读取根目录下的 `.env`。该文件已加入 `.gitignore`，用于保存本机真实配置；`.env.example` 只保留可提交的安全示例。

使用 OpenAI Chat Completions 兼容网关时，在 `.env` 中配置内置模型共用的连接。`PI_MODEL` 是首次默认模型，不限制只能使用这一个模型；页面中可以选另外五个内置模型。如果网关未授权某个模型，点击该模型的“测试连接”会报错。

```env
PI_PROVIDER=openai
PI_MODEL=你的评测模型名称
PI_BASE_URL=http://你的评测模型接口地址/v1
PI_API_KEY=你的评测模型密钥
```

使用 OpenAI 官方接口时，可以留空 `PI_BASE_URL` 和 `PI_API_KEY`，改填：

```env
OPENAI_API_KEY=your-key
```

保存 `.env` 后重新执行 `npm start` 才会加载新配置。不要把被测 Office Agent 的 JWT 写进 `.env`；JWT 应在网页中临时填写。

pi Agent 只开放四个结构化工具：

- `submit_questions`：提交资料追问
- `submit_test_cases`：提交候选测试用例
- `submit_diagnosis`：提交失败归因
- `submit_evaluation`：对浏览器捕获的真实回答进行语义评分

每个阶段仅允许调用对应工具，防止 Agent 跳过审核或直接改写业务数据。

## 被测 Agent 接入

### Playwright 浏览器（当前推荐）

适用于只能在已登录 Office 页面中使用、没有稳定公开 API 的 Agent。系统复用本机已经下载的 Chromium：

```text
E:\playwright-browsers\chromium-1234\chrome-win64\chrome.exe
```

操作步骤：

1. 启动系统并选择“Playwright 浏览器（推荐）”。
2. 填写 Office 页面地址，点击“打开测试浏览器 / 登录”。
3. 首次使用时，在弹出的 Chromium 中登录并进入目标 Agent。
4. 点击“执行已审核用例”，系统只打开 Office，不会立即发送问题。
5. 手动进入目标 Agent，回到评测页面点击“我已打开目标 Agent，开始执行”。
6. 系统自动新建对话、发送问题、等待回复、截图，并由测试 Agent 给出通过/不通过及理由。

批量执行会显示当前用例、完成数量、通过/失败数量和执行阶段。可选择“当前用例完成后暂停”，系统会先完整保存正在生成的回复、截图和评分，再暂停下一条用例；之后可继续执行。

确认执行前可以选择“从哪条用例开始执行”，系统只执行该编号及其后的已审核用例，适合失败后断点续跑。

### Excel 测试集导入

先创建并选中评测集，再点击“导入 Excel”。系统会自动在前 30 行识别表头，最低只要求两列：

- `初始问题` / `问题` / `测试问题`：发送给被测 Agent。
- `预期回答要点` / `预期回答` / `回复要求` / `黄金答案/必要事实`：交给测试 Agent 判断回复是否合格。

`编号`、`用例名称`、`类别`、`优先级` 和 `用例类型` 为可选列。导入的编号会自动增加当前项目代码前缀，例如 `F-01` 在 `XHS` 项目中保存为 `XHS-F-01`。所有原始列（包括尚未映射到系统标准字段的列）都会随用例保存，可在用例详情的“导入的原始字段”中查看。只有包含必填列的工作表会作为用例表导入；概览、人工审核、字段说明等辅助页会忽略。旧版 Office 用例维持已审核状态；通用 Agent 用例导入后待人工审核。

可选轨迹列包括 `必需工具`、`禁止工具`、`预期调用顺序`、`工具参数约束`、`最大工具调用数` 和 `预期轨迹`，会填入用例的“预期执行轨迹”。关联 Langfuse Trace 时，必需工具及其顺序可直接带入过程检查；禁止工具、参数说明和调用上限目前用于人工审核，不会被误报为已自动评分。页面可勾选删除单条或多条用例，可单独删除某个评测集，也可清空当前项目全部评测集，或输入项目名称删除整个项目。单独删除评测集只会删除它的专属用例及关联执行记录；共用用例保留在其他评测集中。项目删除会级联删除该项目的数据库记录。本地已保存的原始 Excel 副本与截图文件暂不物理清理。

登录状态只保存在 `data/playwright-profile/`。每条用例的证据保存在 `artifacts/{项目代码}/{用例编号}/{执行时间}/`：成功包含 `evidence.png`，失败包含 `failure.png` 和 `failure.json`；完成评分后还会生成便于直接阅读的 `result.txt` 及结构化 `result.json`。这些本地隐私目录均已加入 `.gitignore`。

评分、通过状态、理由和原始对话保存在本机 `data/agent_evals.db`，并在“执行与轨迹”页面与对应截图关联展示。

测试 Chromium 通过本机调试端口与 Playwright 连接。服务重启后会重新连接已经打开的测试浏览器，不会再次争抢同一个登录目录。

### Office Agent API

在页面“开始一轮可追溯评测”中选择 **Office Agent**，每次执行时填写：

- Office Agent API Base URL（Agent 网关地址，不是 `/office?officeId=...` 网页链接）
- 本次评测的 Agent ID
- Agent profile（例如 `xhs`；目标没有 profile 时可留空）
- 手动登录取得的 JWT（认证关闭时可留空）

系统调用：

```text
POST {Base URL}/{Agent ID}/{profile}/v1/chat/completions
```

请求使用 OpenAI Chat Completions 格式。Base URL、Agent ID 和 profile 保存在当前评测项目的 SQLite 配置中，因此换浏览器或清理缓存后仍会显示；JWT 只随本次执行发送，不写入 SQLite、环境文件或运行报告。更换被测 Agent 时直接修改 Agent ID。

每条用例执行时会自动生成独立的会话 ID，并通过 `X-Hermes-Web-Session-Id` 请求头发送，同时保存在执行记录中，避免不同用例的上下文互相污染。

测试用例支持 `dialogue`、`browser`、`hybrid` 三种执行类型，并可保存起始页面和结构化浏览器步骤。浏览器步骤需要连接可复用登录态的浏览器执行器；在执行器接入前，不应把这类步骤当作普通对话 API 执行。

### 通用 OpenAI 兼容接口

被测 LUI Agent 使用 OpenAI Chat Completions 兼容协议时设置：

```powershell
$env:AGENT_EVAL_BASE_URL="https://your-agent.example.com/v1"
$env:AGENT_EVAL_API_KEY="your-key"
$env:AGENT_EVAL_MODEL="your-model"
npm start
```

评测 Agent 和被测 Agent 的模型配置相互独立。

## 验证

```powershell
npm run check
npm test
```

测试覆盖 pi 工具循环、规则评分、SQLite、HTTP API、Mock 执行、Office Agent 动态路由/JWT 和 Excel 报告。


## 技术框架
这个 Agent 自动化评测项目目前采用以下技术栈：
语言：TypeScript
运行环境：Node.js 24
Agent 框架：pi-mono@earendil-works/pi-agent-core
@earendil-works/pi-ai

后端服务：Node.js 原生 HTTP Server
数据库：SQLite使用 Node.js 内置的 node:sqlite

前端：原生 HTML、CSS、JavaScript没有使用 React、Vue 等框架

报告生成：ExcelJS 生成 Excel
HTML 生成可视化评测报告

测试：Node.js 内置 node:test
构建：TypeScript Compiler（tsc）
被测 Agent 接入：内置 Mock Agent，方便闭环演示
支持 Office Agent 动态 Agent ID 和 OpenAI 兼容接口

数据与能力：测试集生成与人工审核
单轮、多轮对话执行
规则评分和问题诊断
工具调用、耗时和对话轨迹记录
HTML/Excel 报告导出



## 整体架构
原生 Web 前端
    ↓ HTTP API
Node.js + TypeScript 服务
    ↓
pi-agent-core 评测 Agent
    ├── 资料追问
    ├── 测试用例生成
    └── 失败诊断
    ↓
用例执行器 + 规则评分器
    ↓
SQLite + HTML/Excel 报告
