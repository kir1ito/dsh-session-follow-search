# dsh-session-follow-search

一个面向 **DeepSeek Harness** 的 `ctx.web` 搜索 provider。默认**跟随会话当前选中的 LLM provider**——每次网页搜索都复用该 provider 的 `baseURL`、线上协议（wire protocol）、模型与凭据（`apiKeyEnv`）。在作曲器（composer）的模型选择器里切换 provider/模型，下一次搜索就会走同一个 provider，无需再单独维护一份搜索配置。

当会话 provider 无法执行原生搜索（缺少 `web_search_20250305` 服务端支持）时，搜索会**明确失败**：把具体错误返回给调用它的 LLM，由 LLM 自行决定后续方案。也可用 `nativeSearch` 配置把搜索固定到某个原生搜索端点，而不是跟随会话。

## 搜索如何工作

插件向 `ctx.web` 注册一个搜索 provider（`id: session-follow-search`）。每次搜索：

1. **有原生搜索覆盖吗？** 若设置了 `config.nativeSearch`，请求钉到该原生端点，绝不读会话。
2. **否则跟随会话 provider。** 按顺序解析：
   1. 发起 Agent 的**模型选择**（`provider` 与 `model`），来源与运行时组装下一步所用的同一处；取不到则回退到会话最新的 `request/header`。
   2. 在 **`llm-pi-ai` settings section** 里按该 provider id 查它的 `baseURL`、线上 `api` 协议与 `apiKeyEnv`。
   3. 用 `apiKeyEnv` 经 `ctx.credentials` 解析**凭据**，与 LLM 适配器完全一致。
3. 发送 DeepSeek 原生搜索请求（`web_search_20250305`），并把响应映射回 seam 里规范化的 `sources[]`。

线上端点按 profile 的 `api` 值决定，与 pi-ai 适配器一致：
`anthropic-messages` → `{baseURL}/v1/messages`，
`openai-completions` → `{baseURL}/v1/chat/completions`，
`openai-responses` → `{baseURL}/v1/responses`。
其它任何 `api` 值都会以明确的 `no search endpoint for protocol "…"` 错误回应。

## 原生搜索的识别

`web_search_20250305` 是 Anthropic 的**服务端网页搜索工具**。DeepSeek 官方 Anthropic 兼容端点会执行它并返回 `web_search_tool_result` 结果块。许多 new-api / 网关部署**并不会执行**这个工具——它们只回显一个 `tool_use` 决策，期望调用方自己去跑搜索。因为本插件（与官方 `web-search-deepseek` provider 一样）只发送**服务端原生搜索请求**，这样的网关会返回 0 个结果块，并表现为明确的 `provider returned no native search results` 错误。这是有意为之：不支持的 provider 明确失败而不是返回空结果，由 LLM 决定下一步。

## 配置

在插件的 bundle 行上声明：

```yaml
- id: web
  config:
    searchProvider: session-follow-search     # 钉住 seam（替换 web-search-deepseek 的 id）

- insert:
  - id: session-follow-search
    name: dsh-session-follow-search
    config: {}
```

行的 `config` 键（全部可选）：

- `nativeSearch` — 设置后搜索钉到原生端点，绝不跟随会话。取值：
  - `true` — 官方 DeepSeek 原生端点（`https://api.deepseek.com/anthropic/v1`，key 用 `DEEPSEEK_API_KEY`，模型 `deepseek-v4-flash`）。
  - 一个对象 — `{ baseURL, apiKeyEnv, model }`，指向你自带的原生能力端点。
  - *(遗留)* 通过 `searchProviderOverride` 传一个 provider-id 字符串也能启用覆盖。
- `searchBaseURLs.<provider>` — *(遗留，基本冗余)* 单个 provider 的搜索端点覆盖。建议改用 `nativeSearch`。

`apiKeyEnv` 与 `baseURL` 在每次搜索时从 `llm-pi-ai` settings section **实时读取**，所以改动模型选择器、provider 配置或已存凭据，都不需要重启即可在下一次搜索生效。

## 安装

把包装进 profile 并重载：

```sh
dsh plugin --profile web add ./dsh-session-follow-search
```

然后在 profile 的 `cordis.patch.yml` 里把 `web` 行的 `searchProvider` 设为 `session-follow-search`（见随附的 patch）。

## 模型体验（Model Experience）

- **面向模型的契约**：`web_search` 工具对模型可见的表面不变。每次搜索是对会话当前 LLM provider 端点发起的辅助模型请求，因此消耗该 provider 的 token 配额，并使用该 provider 能够认证的凭据。
- **KV-cache / 提示词影响**：无——本 provider 不注册任何提示词 section。
- **诊断**：会话未选择、provider 无搜索端点、凭据缺失、或 provider 未返回原生结果，都以明确的 `session-follow-search: …` 错误呈现（而不是空结果），从而让调用它的 LLM 可以自行选择回退。

## 已知限制与未决事项

- 只有 `anthropic-messages`、`openai-completions`、`openai-responses` 三类 profile 有搜索端点；其它线上协议明确失败。
- 原生搜索要求 provider 执行服务端 `web_search_20250305` 工具。只会回显 `tool_use` 而不执行的网关，会被报告为"no native search results"。
- OpenAI 协议下的搜索请求体与结果解析覆盖常见形态，但未针对每种网关变体逐一验证。
- provider 跟随的是**当前** Agent 的选择；在无发起 Agent 且无默认选择记录时，会报告"未选择 provider"。