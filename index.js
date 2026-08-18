/**
 * dsh-session-follow-search
 *
 * A `ctx.web` search provider that follows the session's currently selected LLM
 * provider. At each search it resolves the initiating Agent's model selection,
 * looks that provider up in the `llm-pi-ai` settings section for its `baseURL`,
 * wire `api` protocol and `apiKeyEnv`, resolves the key through `ctx.credentials`,
 * and posts the native DeepSeek `web_search_20250305` Messages request to that
 * provider's `/v1/messages` endpoint.
 *
 * Only `anthropic-messages` is searchable by this build, so a provider running
 * another wire protocol is answered with an explicit not-supported error rather
 * than a quiet miss. The provider reuses the LLM provider's credential
 * *reference* (`apiKeyEnv`) and never reads a secret out of settings:
 * configuration carries the reference, the key is resolved per operation
 * through the credentials seam exactly like the LLM adapter does.
 */

const PROVIDER_ID = 'session-follow-search'
const SETTINGS_NS = 'llm-pi-ai'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 4096
const MAX_USES = 5
const SEARCH_MODEL = 'deepseek-v4-flash'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'
// Row-level native-search override. When the operator configures a native
// search provider (one that actually executes `web_search_20250305`), search is
// pinned to it and never follows the session LLM provider. When unset, search
// follows the session and will fail loud if the provider cannot do native
// search — the LLM then chooses its own fallback.
const NATIVE_CONFIG_KEY = 'nativeSearch'
// Legacy key kept working so an existing patch that set it is not broken.
const LEGACY_OVERRIDE_KEY = 'searchProviderOverride'
// Endpoint prefix each pi-ai wire protocol appends to the provider `baseURL`.
const API_SUFFIX = {
  'anthropic-messages': '/v1/messages',
  'openai-completions': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
}

/** SettingsNamespace is a branded string at runtime its own plain value. */
function ns(value) {
  return value
}

function trimSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/** The wire endpoint for one protocol, appending its suffix to the provider `baseURL`. */
function endpointFor(api, base) {
  const suffix = API_SUFFIX[api]
  if (suffix === undefined) return undefined
  const b = trimSlash(base)
  // When the configured baseURL already carries the suffix's leading `/v1`, do
  // not duplicate it (`https://x/v1` + `/v1/messages` would miss).
  const v1 = b.endsWith('/v1') ? b.slice(0, -3) : b
  return `${v1}${suffix}`
}

function signalThrows(signal) {
  if (signal && signal.aborted) throw abortError(signal)
}

function abortError(signal) {
  const error = new Error('session-follow-search: search aborted')
  error.name = 'AbortError'
  error.signal = signal
  return error
}

function errorMessage(status, payload) {
  let candidate = payload && (payload.error || payload.message) || undefined
  if (candidate && typeof candidate === 'object' && typeof candidate.message === 'string') candidate = candidate.message
  if (typeof candidate === 'string' && candidate.length > 0) return candidate
  return `HTTP ${status}`
}

/**
 * Build the per-protocol request body. All supported protocols carry the DeepSeek
 * native web-search tool `web_search_20250305`, but its wire position differs:
 * `anthropic-messages` declares it under `tools` as a server tool; the OpenAI
 * paths declare the same tool under `tools` in their own shape. We reuse the
 * official DeepSeek body for Messages and the equivalent for native tool calls
 * here, so a gateway must support `web_search_20250305` to return results.
 */
function requestBody(api, query, model) {
  const m = model && model.length > 0 ? model : SEARCH_MODEL
  if (api === 'anthropic-messages') {
    return {
      model: m,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_USES }],
    }
  }
  // openai-completions / openai-responses
  return {
    model: m,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: `Perform a web search for the query: ${query}` }],
    tools: [{
      type: 'function',
      function: { name: 'web_search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    }],
    tool_choice: { type: 'function', function: { name: 'web_search' } },
  }
}

function requestHeaders(api, apiKey) {
  const base = { 'content-type': 'application/json', accept: 'application/json' }
  if (api === 'anthropic-messages') {
    return { ...base, 'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, 'anthropic-version': ANTHROPIC_VERSION }
  }
  return { ...base, authorization: `Bearer ${apiKey}` }
}

/** Parse a response based on the wire protocol that produced it. */
function parseResponse(api, payload) {
  if (api === 'anthropic-messages') return parseAnthropicResponse(payload)
  return parseOpenaiResponse(payload)
}

function parseAnthropicResponse(payload) {
  const sources = []
  const snippets = new Map()
  const blocks = payload && Array.isArray(payload.content) ? payload.content : []
  for (const block of blocks) {
    if (block && block.type === 'text' && Array.isArray(block.citations)) {
      for (const cite of block.citations) {
        if (cite && typeof cite.url === 'string' && cite.url.length > 0
          && typeof cite.cited_text === 'string' && cite.cited_text.length > 0
          && !snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text)
      }
    }
  }
  for (const block of blocks) {
    if (block && block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (!item || item.type !== 'web_search_result' || typeof item.url !== 'string') continue
        if (item.url.length === 0 || sources.some((s) => s.url === item.url)) continue
        const source = { url: item.url }
        if (typeof item.title === 'string' && item.title.length > 0) source.title = item.title
        const snippet = snippets.get(item.url)
        if (snippet === undefined && typeof item.snippet === 'string' && item.snippet.length > 0) source.snippet = item.snippet
        else if (snippet !== undefined) source.snippet = snippet
        if (typeof item.page_age === 'string' && item.page_age.length > 0) source.publishedAt = item.page_age
        sources.push(source)
      }
    }
  }
  return { sources, truncated: false }
}

/**
 * Parse an OpenAI-completions/responses reply into the seam's sources. Native
 * `web_search_20250305` results, when a gateway surfaces them, arrive as a
 * function `tool_calls` (openai-completions) or as a `web_search` item in a
 * content block (openai-responses). We map the most common shapes and tolerate
 * being handed a normal assistant text reply (zero sources). A provider that
 * lacks native search answers with the explicit zero-result error from the
 * caller.
 */
function parseOpenaiResponse(payload) {
  const sources = []
  const seen = new Set()
  const push = (url, title, snippet) => {
    if (typeof url !== 'string' || url.length === 0 || seen.has(url)) return
    seen.add(url)
    const source = { url }
    if (typeof title === 'string' && title.length > 0) source.title = title
    if (typeof snippet === 'string' && snippet.length > 0) source.snippet = snippet
    sources.push(source)
  }
  const choices = payload && Array.isArray(payload.choices) ? payload.choices : []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const msg = choice.message
    if (msg && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (!call || typeof call.function !== 'object') continue
        const arg = call.function.arguments
        if (typeof arg !== 'string') continue
        let parsed
        try { parsed = JSON.parse(arg) } catch (e) { continue }
        const arr = parsed && Array.isArray(parsed.results) ? parsed.results : []
        for (const item of arr) {
          const entry = item && typeof item === 'object' ? item : {}
          push(entry.url, entry.title, entry.snippet)
        }
      }
    }
  }
  // openai-responses content blocks may carry `web_search` items inline.
  if (payload && Array.isArray(payload.output)) {
    for (const block of payload.output) {
      if (block && block.type === 'web_search' && Array.isArray(block.results)) {
        for (const item of block.results) {
          push(item && item.url, item && item.title, item && item.text)
        }
      }
    }
  }
  return { sources, truncated: false }
}
export const name = 'dsh-session-follow-search'
export const inject = ['web']

export function apply(ctx, config = {}) {
  const web = ctx.web
  if (!web || typeof web.registerSearchProvider !== 'function') return

  const searchBaseURLs = config.searchBaseURLs && typeof config.searchBaseURLs === 'object' ? config.searchBaseURLs : {}

  /** Read the resolved `llm-pi-ai` settings section, or undefined while unregistered. */
  const readSection = () => {
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.get !== 'function') return undefined
    return settings.get(ns(SETTINGS_NS))
  }

  /** The LLM provider (id + connection facts) the current session names, or undefined. */
  const resolveProvider = () => {
    const section = readSection()
    if (section === undefined || section === null || typeof section !== 'object') return undefined
    const profiles = section.providers
    if (profiles === undefined || profiles === null || typeof profiles !== 'object') return undefined

    let id
    let model
    const defaultModel = ctx.get('agentDefaultModel')
    if (defaultModel !== undefined && typeof defaultModel.currentSelection === 'function') {
      try {
        const sel = defaultModel.currentSelection()
        id = sel.provider
        model = sel.model
      } catch (e) { /* never blocks search */ }
    }
    if (id === undefined || id === null || id.length === 0) {
      const agents = ctx.get('agents')
      const agent = agents === undefined || typeof agents.currentInitiator !== 'function'
        ? undefined
        : agents.currentInitiator()
      if (agent !== undefined && agent.session !== undefined && typeof agent.session.requestHeader === 'function') {
        const header = agent.session.requestHeader()
        const cfg = header === undefined ? undefined : header.config
        if (cfg !== undefined && typeof cfg.provider === 'string' && cfg.provider.length > 0) {
          id = cfg.provider
          model = cfg.model
        }
      }
    }
    if (id === undefined || id === null || id.length === 0) return undefined

    const profile = profiles[id]
    if (profile === undefined || profile === null || typeof profile !== 'object') return undefined
    const baseURL = typeof profile.baseURL === 'string' && profile.baseURL.length > 0 ? profile.baseURL : undefined
    if (baseURL === undefined) return undefined
    return {
      id,
      model: typeof model === 'string' && model.length > 0 ? model : undefined,
      baseURL: (typeof searchBaseURLs[id] === 'string' && searchBaseURLs[id].length > 0) ? searchBaseURLs[id] : baseURL,
      api: typeof profile.api === 'string' ? profile.api : undefined,
      apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined,
    }
  }

  web.registerSearchProvider({
    id: PROVIDER_ID,
    available() {
      return resolveProvider() !== undefined
    },
    async search(request, signal) {
      const native = config[NATIVE_CONFIG_KEY] ?? config[LEGACY_OVERRIDE_KEY]
      const override = nativeSearchTarget(native)
      const creds = ctx.get('credentials')

      // Native-search override: the operator gave explicit endpoint/key; do not
      // consult the session. Without a usable override, fall through to follow.
      if (override !== undefined) {
        const apiKey = await resolveApiKey(override.apiKeyEnv, creds)
        if (apiKey === undefined || apiKey.length === 0) {
          throw new Error(`session-follow-search: no credential for native search (resolves "${override.apiKeyEnv}"); store it through the credentials service or export it`)
        }
        signalThrows(signal)
        const body = requestBody('anthropic-messages', request.query, override.model)
        const headers = requestHeaders('anthropic-messages', apiKey)
        const endpoint = endpointFor('anthropic-messages', override.baseURL)
        return await postAndParse('anthropic-messages', endpoint, headers, body, request, signal)
      }

      const provider = resolveProvider()
      if (provider === undefined) {
        throw new Error('session-follow-search: no current LLM provider named by the session; select a provider in the model picker first')
      }
      const endpoint = endpointFor(provider.api, provider.baseURL)
      if (endpoint === undefined) {
        throw new Error(`session-follow-search: provider "${provider.id}" uses protocol "${provider.api}", which this build has no search endpoint for (supported: ${Object.keys(API_SUFFIX).join(', ')})`)
      }

      const apiKey = await resolveApiKey(provider.apiKeyEnv, creds)
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error(`session-follow-search: no credential for provider "${provider.id}" (resolves "${provider.apiKeyEnv || '(none)'}"); store it through the credentials service or export it`)
      }

      signalThrows(signal)
      const body = requestBody(provider.api, request.query, provider.model)
      const headers = requestHeaders(provider.api, apiKey)
      return await postAndParse(provider.api, endpoint, headers, body, request, signal)
    },
  })
}

function resolveApiKey(apiKeyEnv, creds) {
  return (async () => {
    if (apiKeyEnv === undefined || apiKeyEnv === null || apiKeyEnv.length === 0) return undefined
    if (creds !== undefined && typeof creds.resolve === 'function') {
      try {
        const hit = await creds.resolve(ns(apiKeyEnv))
        if (hit !== undefined && hit.value !== undefined && hit.value.length > 0) return hit.value
      } catch (e) { /* treated as missing below */ }
      // When credentials exist but miss, fall back to the launching env only if
      // no credential seam is configured; when the seam is mounted it is the
      // whole credential plane. We do not silently read an ambient key here.
    } else if (apiKeyEnv !== undefined) {
      return launchEnvironmentValue(apiKeyEnv)
    }
    return undefined
  })()
}

/** The configured native-search override, or undefined when none applies. */
function nativeSearchTarget(raw) {
  // Accept a bare truthy (official DeepSeek native), a provider-id string
  // (legacy `searchProviderOverride`), or a config object with the native
  // fields. `true`/string map to official DeepSeek defaults.
  if (raw === undefined || raw === null || raw === false) return undefined
  const isObject = typeof raw === 'object'
  const baseURL = isObject && typeof raw.baseURL === 'string' && raw.baseURL.length > 0
    ? raw.baseURL
    : DEEPSEEK_DEFAULT_BASE_URL
  const apiKeyEnv = isObject && typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.length > 0
    ? raw.apiKeyEnv
    : DEFAULT_API_KEY_ENV
  const model = isObject && typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : undefined
  return { baseURL, apiKeyEnv, model }
}

async function postAndParse(api, endpoint, headers, body, request, signal) {
  let response
  try {
    const options = { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body) }
    if (signal !== undefined) options.signal = signal
    response = await fetch(endpoint, options)
  } catch (error) {
    signalThrows(signal)
    throw new Error(`session-follow-search: request to ${endpoint} failed: ${error && error.message ? error.message : String(error)}`, { cause: error })
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    signalThrows(signal)
    throw new Error(`session-follow-search: provider returned a non-JSON response (HTTP ${response.status})`, { cause: error })
  }
  if (!response.ok) {
    throw new Error(`session-follow-search: provider error (HTTP ${response.status}): ${errorMessage(response.status, payload)}`)
  }
  signalThrows(signal)
  const result = parseResponse(api, payload)
  if (result.sources.length === 0) {
    throw new Error('session-follow-search: provider returned no native search results; it may not support web search')
  }
  if (request.maxResults !== undefined && result.sources.length > request.maxResults) {
    result.sources = result.sources.slice(0, request.maxResults)
    result.truncated = true
  }
  return result
}

function launchEnvironmentValue(name) {
  try {
    const env = typeof process !== 'undefined' && process.env ? process.env : undefined
    return env ? env[name] : undefined
  } catch (e) {
    return undefined
  }
}