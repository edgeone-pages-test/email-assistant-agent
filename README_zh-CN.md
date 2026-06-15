# AI 邮件助手

> 基于 LangGraph + CrewAI 构建的多 Agent 邮件分类与回复起草助手，部署在 EdgeOne Makers 上 — 自动分类收件箱、三角色协作起草回复、人工审批后再执行。

**框架:** LangGraph · **分类:** 编排 · **语言:** Python

[![部署到 EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?template=email-assistant-agent&from=within&fromAgent=1&agentLang=python)

## 概览

AI 邮件助手端到端处理收件箱：拉取邮件、LLM 分类、按用户规则排序，然后用三角色 CrewAI 流水线（分析师 → 撰稿员 → 润色员）起草回复。每封草稿都会暂停在人机协作检查点 — 你可以通过、编辑、驳回或要求重写，确认后系统才执行操作。整个流水线通过 SSE 向 React 前端实时推送进度。

- **多 Agent 协作起草** — 三角色 CrewAI 串行流水线（分析师、撰稿员、润色员），产出贴合语境和语气的回复
- **人机协作审批** — LangGraph `interrupt()` 在每封草稿处暂停流水线；支持通过 / 编辑 / 驳回 / 重写 / 跳过
- **实时流水线可视化** — SSE 推送节点级进度；前端渲染活动流程图 + 实时文字播报
- **可插拔邮件源** — 内置 10 封模拟邮件；设置一个环境变量即可切换到真实 IMAP 邮箱

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `AI_GATEWAY_API_KEY` | 是 | 模型网关 API Key。使用 **Makers Models API Key**，或任何 OpenAI 兼容的服务商密钥。 |
| `AI_GATEWAY_BASE_URL` | 是 | 网关 Base URL。Makers Models 填 `https://ai-gateway.edgeone.link/v1`。 |
| `AI_GATEWAY_MODEL` | 否 | 模型 ID。默认 `@makers/deepseek-v4-flash`。 |
| `EMAIL_PROVIDER` | 否 | `mock`（默认）或 `imap`。控制邮件数据来源。 |
| `IMAP_HOST` | 否 | IMAP 服务器地址（如 `imap.gmail.com`）。`EMAIL_PROVIDER=imap` 时必填。 |
| `IMAP_USER` | 否 | IMAP 登录用户名 / 邮箱地址。 |
| `IMAP_APP_PASSWORD` | 否 | 应用专用密码（Gmail: [在此创建](https://myaccount.google.com/apppasswords)）。 |

> 本模板遵循 **OpenAI 兼容** 标准 — 可将上述变量指向 Makers Models 或任何兼容的网关/服务商。

### 如何获取 `AI_GATEWAY_API_KEY`

1. 打开 [Makers 控制台](https://console.cloud.tencent.com/edgeone/makers)。
2. 登录并开通 Makers。
3. 进入 **Makers → Models → API Key**，创建一个密钥。
4. 将密钥填入 `AI_GATEWAY_API_KEY`（`AI_GATEWAY_BASE_URL` 设为 `https://ai-gateway.edgeone.link/v1`）。

内置模型（`@makers/deepseek-v4-flash`、`@makers/hy3-preview`、`@makers/minimax-m2.7`）免费但有速率限制，适合原型验证。生产环境请在控制台绑定自有服务商密钥（BYOK）。

### 连接真实邮箱（IMAP）

以 Gmail 为例：

1. 开启 [两步验证](https://myaccount.google.com/security)
2. 生成 [应用专用密码](https://myaccount.google.com/apppasswords)（选择"邮件" → "其他"）
3. 配置环境变量：
   ```bash
   EMAIL_PROVIDER=imap
   IMAP_HOST=imap.gmail.com
   IMAP_USER=yourname@gmail.com
   IMAP_APP_PASSWORD=abcdefghijklmnop
   ```

> 其他邮箱：Outlook (`outlook.office365.com`)、QQ 邮箱 (`imap.qq.com`)、163 (`imap.163.com`) — 替换 `IMAP_HOST` 并使用对应的授权码。

## 本地开发

**前置依赖:** Node.js, npm, Python 3.11+

```bash
npm install
cp .env.example .env
# 在 .env 中填入 AI_GATEWAY_API_KEY 和 AI_GATEWAY_BASE_URL
edgeone makers dev
```

打开 `http://localhost:8080/agent-metrics` 查看本地可观测面板。

## 项目结构

```text
email-assistant/
├── agents/email/                   # 后端: Python Agent 处理器
│   ├── run.py                      # /email/run — SSE 主入口 (fetch→classify→draft→review 循环)
│   ├── review.py                   # /email/review — 人机协作恢复 (Command(resume=decision))
│   ├── history.py                  # /email/history — 会话列表 / 详情 / 删除
│   ├── stop.py                     # /email/stop — 中止当前运行
│   ├── health.py                   # /email/health — 存活探针 + provider 信息
│   ├── _graph.py                   # LangGraph StateGraph 定义 & 编译
│   ├── _state.py                   # EmailAssistantState TypedDict
│   ├── _nodes.py                   # 7 个节点函数 (fetch, classify, prioritize, draft, review, apply, summarize)
│   ├── _routing.py                 # 3 个条件边函数
│   ├── _crew.py                    # CrewAI crew 适配器 (构建 kickoff 输入)
│   ├── _models.py                  # Pydantic v2 领域模型 (Email, DraftItem, ReviewDecision 等)
│   ├── _providers.py               # EmailProvider 协议 + MockProvider + IMAPProvider
│   ├── _events.py                  # CrewAI→LangGraph 事件桥 (跨线程)
│   ├── _llm.py                     # LLM 客户端初始化 (AI Gateway)
│   ├── _tools.py                   # CrewAI BaseTool 实现 (Tone, Template, ThreadContext)
│   ├── _crews/                     # @CrewBase crew 定义 (YAML agents + tasks)
│   ├── fixtures/                   # 10 封模拟 .eml 文件 + user_rules.json
│   ├── skills/                     # Skill 定义 (email-tone, email-templates, triage-rules)
│   └── prompts/                    # LangGraph 节点的系统提示词
├── src/                            # 前端: React + Vite
│   ├── App.tsx                     # SSE 状态机 + pipeline reducer
│   ├── components/
│   │   ├── ChatLayout.tsx          # 三栏响应式布局
│   │   ├── EmailInboxTree.tsx      # 左栏: 分类收件箱 + 搜索/筛选
│   │   ├── ConversationStream.tsx  # 中栏: 消息时间线 + 流式气泡
│   │   ├── DraftReviewCard.tsx     # 人机协作审批卡 (通过/编辑/驳回/重写/跳过)
│   │   ├── NodeFlowVisualizer.tsx  # 右栏: 流水线节点状态
│   │   ├── EmailDetailDrawer.tsx   # 邮件详情滑出面板
│   │   └── HistorySidebar.tsx      # 历史会话侧栏
│   ├── i18n.tsx                    # 国际化 (中/英)
│   └── historyStorage.ts           # localStorage 会话索引
├── edgeone.json                    # Agent 运行时配置
├── requirements.txt                # Python 依赖
└── package.json                    # 前端构建
```

> 以 `_` 开头的文件是私有模块 — 不会被 EdgeOne 暴露为公开路由。

## 工作原理

Agent 以 **会话模式** 运行在 `agents/email/` 下。共享相同 `conversation_id` 的请求会路由到同一份 LangGraph checkpoint，从而支持跨请求的人机协作循环。

### 流水线流程

```
拉取 → 分类 → 排序 → [起草 → 审批 → 执行]* → 总结
                       ↑_____ 重写 _____|
```

1. **拉取** (`/email/run`) — 从配置的 provider 拉取邮件（模拟数据或真实 IMAP），自动归档命中用户规则的发件人。
2. **分类** — 单次 LLM 批量调用，为每封邮件打上类别、优先级（0–100）和 `needs_reply` 标记。
3. **排序** — 应用 VIP 域名加权和用户规则，过滤出需要处理的邮件，按优先级降序排列。
4. **起草**（逐封） — 三角色 CrewAI 流水线串行执行：
   - *分析师*：阅读邮件，产出结构化分析简报（意图、关键点、建议模板/语气）
   - *撰稿员*：根据简报 + 可选模板起草回复正文
   - *润色员*：调整语气、追加签名，输出类型化的 `DraftItem` JSON
5. **审批** — 调用 `interrupt()`，图暂停。SSE 流推送 `human_review_required` 事件后关闭连接。前端渲染 `DraftReviewCard`。
6. **恢复** (`/email/review`) — 用户的决定（通过 / 编辑 / 驳回 / 重写 / 跳过）发回后端。LangGraph 从 checkpoint 恢复，通过 `Command(resume=decision)` 继续执行。
7. **执行** — 根据决定执行操作（保存草稿、归档、标记已读）。`cursor` 前进；如果还有邮件待处理，回到第 4 步。
8. **总结** — 生成本次处理的 Markdown 摘要。

### 关键技术细节

- **SSE 流式传输**：`stream_mode=["updates", "custom"]` — `updates` 驱动流水线可视化；`custom` 传递实时文字播报（progress 事件）。
- **Conversation ID**：通过 `Makers-Conversation-Id` 请求头传递。平台内置的 checkpointer（`context.store.langgraph_checkpointer`）按 thread 持久化图状态。
- **CrewAI 集成**：`crew.kickoff()` 是同步阻塞的 — 用 `asyncio.to_thread()` 包装。事件通过 `loop.call_soon_threadsafe` 桥接到异步 loop。
- **超时**：`edgeone.json` 中 `agents.timeout = 1800`（30 分钟），适应多封邮件的长会话场景。

### SSE 事件协议

```
event: session              → {"type":"session","conversationId":"...","task":"daily_digest"}
event: state_update         → {"classify":{"classified":[...]}}
event: progress             → {"phase":"draft","stage":"started","message":"正在起草..."}
event: human_review_required → {"draft":{...},"remaining":2}
event: done                 → {"summary":"..."}
event: error_message        → {"error":"..."}
data: [PAUSED]              # 运行暂停（等待审批）
data: [DONE]                # 运行完成
data: [CANCELLED]           # 运行被取消
```

## 相关资源

- [Makers Agents 文档](https://cloud.tencent.com/document/product/1552/132759)
- [快速开始: Agent 开发](https://cloud.tencent.com/document/product/1552/132786)
- [Makers Models](https://cloud.tencent.com/document/product/1552/132748)
## 许可证

MIT
