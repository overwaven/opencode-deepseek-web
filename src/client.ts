/**
 * Minimal client for the DeepSeek Search and Fetch APIs.
 *
 * https://api-docs.deepseek.com/guides/search
 */

import { truncate } from "./text.ts"

const DEFAULT_BASE_URL = "https://api.deepseek.com"
const SEARCH_PATH = "/tools/search"
const FETCH_PATH = "/tools/fetch"
const MAX_RETRY_DELAY_MS = 4_000

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

const STATUS_HINTS: Readonly<Record<number, string>> = {
  400: "the request was rejected as invalid",
  401: "the DeepSeek API key is missing or invalid",
  402: "the DeepSeek account has insufficient balance",
  403: "the fetch request was rejected by DeepSeek's security policy",
  404: "DeepSeek could not retrieve usable page content",
  408: "DeepSeek timed out while reading the request",
  413: "the request body was too large",
  429: "the DeepSeek rate limit was exceeded",
  500: "DeepSeek returned an internal server error",
  504: "a downstream request timed out",
}

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>

export interface DeepSeekClientOptions {
  /** DeepSeek API key. When absent, every request fails with a clear error. */
  readonly apiKey: string | undefined
  /** API base URL, for example `https://api.deepseek.com`. */
  readonly baseURL?: string
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Retries for 408, 429, and 5xx responses. Defaults to 2. */
  readonly maxRetries?: number
  /** Injectable fetch implementation, used by tests. */
  readonly fetch?: FetchImplementation
}

export interface SearchOptions {
  /** Number of results, 1 to 50. Defaults to 10. */
  readonly count?: number
  /** Ask DeepSeek to include full page content in each result. */
  readonly needContent?: boolean
  readonly signal?: AbortSignal
}

export interface DeepSeekSearchResult {
  readonly rerank_score?: number
  readonly title?: string
  readonly url?: string
  readonly snippet?: string
  readonly summary?: string
  readonly content?: string
  readonly site_name?: string | null
  readonly site_icon?: string | null
  readonly date?: string | null
  readonly authority?: number
}

interface DeepSeekSearchResponse {
  readonly results?: readonly DeepSeekSearchResult[]
}

interface DeepSeekFetchResponse {
  readonly title?: string
  readonly content?: string
}

interface DeepSeekErrorBody {
  readonly error?: {
    readonly message?: unknown
    readonly code?: unknown
  }
}

export class DeepSeekError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, options: { status: number; code?: string | undefined; cause?: unknown }) {
    super(message, { cause: options.cause })
    this.name = "DeepSeekError"
    this.status = options.status
    this.code = options.code
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
}

export class DeepSeekClient {
  readonly #apiKey: string | undefined
  readonly #baseURL: string
  readonly #timeoutMs: number
  readonly #maxRetries: number
  readonly #fetch: FetchImplementation

  constructor(options: DeepSeekClientOptions) {
    this.#apiKey = options.apiKey
    this.#baseURL = normalizeBaseURL(options.baseURL ?? DEFAULT_BASE_URL)
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#maxRetries = options.maxRetries ?? 2
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async search(query: string, options: SearchOptions = {}): Promise<readonly DeepSeekSearchResult[]> {
    const normalized = query.trim()
    if (normalized.length === 0) {
      throw new DeepSeekError("DeepSeek search needs a non-empty query.", { status: 0 })
    }
    if ([...normalized].length > 128) {
      throw new DeepSeekError("DeepSeek search queries are limited to 128 characters.", { status: 0 })
    }

    const payload = await this.#post<DeepSeekSearchResponse>(
      SEARCH_PATH,
      {
        query: normalized,
        count: clampInteger(options.count ?? 10, 1, 50),
        need_content: options.needContent ?? false,
      },
      options.signal,
      "search",
    )

    if (!Array.isArray(payload.results)) {
      throw new DeepSeekError("DeepSeek search returned an unexpected response.", { status: 0 })
    }
    return payload.results
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<{ title: string; content: string }> {
    const normalized = normalizeFetchURL(url)
    const payload = await this.#post<DeepSeekFetchResponse>(FETCH_PATH, { url: normalized }, signal, "fetch")

    const content = typeof payload.content === "string" ? payload.content.trim() : ""
    if (content.length === 0) {
      throw new DeepSeekError(`DeepSeek could not retrieve usable content from ${normalized}.`, { status: 404 })
    }

    return {
      title: typeof payload.title === "string" ? payload.title.trim() : "",
      content,
    }
  }

  async #post<T>(
    path: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<T> {
    if (!this.#apiKey) {
      throw new DeepSeekError(
        "DEEPSEEK_API_KEY is not set. Add it to the environment or pass the apiKey plugin option.",
        { status: 401 },
      )
    }

    const url = apiURL(this.#baseURL, path)
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.#fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": "opencode-deepseek-web",
          },
          body: JSON.stringify(body),
          signal: combineSignals(signal, this.#timeoutMs),
        })
      } catch (cause) {
        if (signal?.aborted) throw cause
        if (attempt < this.#maxRetries) {
          await delay(backoff(attempt), signal)
          continue
        }
        const timedOut = isAbortError(cause)
        throw new DeepSeekError(
          timedOut
            ? `DeepSeek ${label} timed out after ${this.#timeoutMs}ms.`
            : `Could not reach DeepSeek for ${label}: ${errorMessage(cause)}`,
          { status: 0, cause },
        )
      }

      if (response.ok) return (await this.#json<T>(response, label)) as T

      const failure = await readFailure(response, label, attempt)
      if (!failure.retryable || attempt >= this.#maxRetries) throw failure.error
      await delay(failure.retryAfterMs, signal)
    }
  }

  async #json<T>(response: Response, label: string): Promise<T> {
    try {
      return (await response.json()) as T
    } catch (cause) {
      throw new DeepSeekError(`DeepSeek ${label} returned an invalid JSON response.`, { status: 0, cause })
    }
  }
}

export function normalizeBaseURL(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "")
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`[deepseek-web] baseURL must be an absolute HTTP(S) URL, received "${value}".`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`[deepseek-web] baseURL must use http or https, received "${value}".`)
  }
  return trimmed
}

/**
 * Build a tool endpoint. Both `https://api.deepseek.com` and the
 * OpenAI-compatible `https://api.deepseek.com/v1` form work.
 */
export function apiURL(baseURL: string, path: string): string {
  return /\/v1$/.test(baseURL) ? `${baseURL}${path}` : `${baseURL}/v1${path}`
}

export function normalizeFetchURL(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new DeepSeekError("The fetch tool needs a non-empty URL.", { status: 0 })
  }
  if (trimmed.length > 8192) {
    throw new DeepSeekError("URLs passed to DeepSeek fetch are limited to 8192 characters.", { status: 0 })
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new DeepSeekError(`"${trimmed}" is not a valid URL.`, { status: 0 })
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DeepSeekError("Only HTTP and HTTPS URLs can be fetched.", { status: 0 })
  }
  if (parsed.hostname.length === 0) {
    throw new DeepSeekError("The fetch URL needs a host.", { status: 0 })
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new DeepSeekError("Fetch URLs must not contain a username or password.", { status: 0 })
  }

  return parsed.toString()
}

async function readFailure(
  response: Response,
  label: string,
  attempt: number,
): Promise<{ error: DeepSeekError; retryable: boolean; retryAfterMs: number }> {
  const apiMessage = await readErrorMessage(response)
  const hint = STATUS_HINTS[response.status]
  const detail = [`HTTP ${response.status}`, hint].filter((part) => part !== undefined).join(" - ")
  const message = `DeepSeek ${label} failed: ${apiMessage || response.statusText || "request failed"} (${detail}).`

  return {
    error: new DeepSeekError(message, { status: response.status }),
    retryable: RETRYABLE_STATUS.has(response.status),
    retryAfterMs: retryAfter(response, attempt),
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as DeepSeekErrorBody
    const message = payload.error?.message
    return typeof message === "string" ? message.trim() : ""
  } catch {
    return ""
  }
}

function retryAfter(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after")
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return clampInteger(seconds * 1_000, 0, MAX_RETRY_DELAY_MS)

    const date = Date.parse(header)
    if (Number.isFinite(date)) return clampInteger(date - Date.now(), 0, MAX_RETRY_DELAY_MS)
  }
  return backoff(attempt)
}

function backoff(attempt: number): number {
  return Math.min(250 * 2 ** attempt, MAX_RETRY_DELAY_MS)
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { DEFAULT_BASE_URL }
