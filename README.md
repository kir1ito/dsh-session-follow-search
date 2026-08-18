# dsh-session-follow-search

A `ctx.web` search provider for **DeepSeek Harness** that, by default, follows
the session's currently selected LLM provider — reusing that provider's
`baseURL`, wire protocol, model and credential (`apiKeyEnv`) at every web
search. Switch the provider/model in the composer's model picker and the next
search posts through the same provider, with no separate search configuration
to keep in sync.

When the session provider cannot execute native search (it lacks
`web_search_20250305` server-side support), the search **fails loud**: the
explicit error is returned to the calling LLM, which then decides its own next
step. Optionally pin search to a dedicated native-search endpoint with the
`nativeSearch` config instead of following the session.

## How search works

The plugin registers one search provider
(`id: session-follow-search`) with `ctx.web`. Each search:

1. **Native override?** If `config.nativeSearch` is set, the request is pinned
   to that native endpoint and the session is never consulted.
2. **Otherwise follow the session provider.** Resolve in order:
   1. the initiating Agent's **model selection** (`provider` and `model`) from
      the same source the runtime uses for the next assembled step; fall back
      to the session's latest `request/header`.
   2. that provider id in the **`llm-pi-ai` settings section** for its
      `baseURL`, wire `api` protocol and `apiKeyEnv`.
   3. the **credential** via `ctx.credentials` using that `apiKeyEnv`, exactly
      as the LLM adapter does.
3. Post the native DeepSeek search request
   (`web_search_20250305`) and map the response back into the seam's normalized
   `sources[]`.

The wire endpoint is chosen from the profile's `api` value exactly like the pi-ai
adapter: `anthropic-messages` → `{baseURL}/v1/messages`,
`openai-completions` → `{baseURL}/v1/chat/completions`,
`openai-responses` → `{baseURL}/v1/responses`. A provider with any other `api`
is answered with an explicit `no search endpoint for protocol "…"` error.

## Native search detection

`web_search_20250305` is Anthropic's **server-side web-search tool**. DeepSeek's
official Anthropic-compatible endpoint executes it and returns
`web_search_tool_result` blocks. Many new-api / gateway deployments do NOT
execute the tool — they echo a `tool_use` decision and expect the caller to run
the search itself. Because this plugin (like the official `web-search-deepseek`
provider) only makes server-side native-search requests, such a gateway returns
zero result blocks and is surfaced as the explicit
`provider returned no native search results` error. That is by design: an
unsupported provider fails loud rather than returning empty, and the LLM picks
the follow-up.

## Configuration

Declared on the plugin's bundle row:

```yaml
- id: web
  config:
    searchProvider: session-follow-search     # pin the seam (replace web-search-deepseek's id)

- insert:
  - id: session-follow-search
    name: dsh-session-follow-search
    config: {}
```

Row-level `config` keys (all optional):

- `nativeSearch` — when set, search is pinned to a native endpoint and never
  follows the session. Values:
  - `true` — official DeepSeek native endpoint (`https://api.deepseek.com/anthropic/v1`,
    key `DEEPSEEK_API_KEY`, model `deepseek-v4-flash`).
  - an object —
    `{ baseURL, apiKeyEnv, model }` to target your own native-capable endpoint.
  - *(legacy)* a provider-id string via `searchProviderOverride` also enables
    the override.
- `searchBaseURLs.<provider>` — *(legacy, mostly redundant)* per-provider search
  endpoint override. Prefer `nativeSearch`.

`apiKeyEnv` and `baseURL` are read live from the `llm-pi-ai` settings section at
each search, so changing the model picker, the provider profile, or the stored
credential reaches the next search without a restart.

## Integration

Install the package into a profile and reload:

```sh
dsh plugin --profile web add ./dsh-session-follow-search
```

Then set the `web` row's `searchProvider` to `session-follow-search` in the
profile's `cordis.patch.yml` (see the shipped patch).

## Model Experience

- **Model-facing contract**: the `web_search` tool model-visible surface is
  unchanged. Each search is an auxiliary model request to the session's current
  LLM provider endpoint, so it consumes that provider's token quota and a
  credential that provider can authenticate with.
- **KV-cache / prompt effect**: none — the provider registers no prompt section.
- **Diagnostics**: an absent session selection, a provider with no search
  endpoint, a missing credential, or a provider returning no native results all
  surface as explicit `session-follow-search: …` errors rather than empty
  results, so the calling LLM can choose its own fallback.

## Known Limitations and Deferred Work

- Only `anthropic-messages`, `openai-completions`, and `openai-responses`
  profiles have a search endpoint; other wire protocols fail loud.
- Native search requires the provider to execute the server-side
  `web_search_20250305` tool. Gateways that echo a `tool_use` instead of
  executing it are reported as "no native search results".
- The OpenAI-protocol search bodies and result parsing cover the common shapes
  but are not verified against every gateway variant.
- The provider follows the *current* Agent's selection; with no initiating
  agent and no default selection recorded it reports that no provider is
  selected.