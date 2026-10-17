import assert from "node:assert/strict"
import test from "node:test"

import {
  DeepSeekClient,
  DeepSeekError,
  apiURL,
  normalizeBaseURL,
  normalizeFetchURL,
} from "../src/client.ts"

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function setup(handler: (call: Call) => Response | Promise<Response>, overrides: { maxRetries?: number } = {}) {
  const calls: Call[] = []
  const client = new DeepSeekClient({
    apiKey: "test-key",
    maxRetries: overrides.maxRetries ?? 0,
    fetch: async (url, init) => {
      const call = { url, init }
      calls.push(call)
      return handler(call)
    },
  })
  return { client, calls }
}

test("search sends an authenticated request and returns results", async () => {
  const { client, calls } = setup(() =>
    jsonResponse({
      results: [{ title: "DeepSeek V4", url: "https://example.com/v4", summary: "Released." }],
    }),
  )

  const results = await client.search("DeepSeek V4", { count: 5, needContent: true })

  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.url, "https://api.deepseek.com/v1/tools/search")
  assert.equal(call.init?.method, "POST")
  assert.equal((call.init?.headers as Record<string, string>).authorization, "Bearer test-key")
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    query: "DeepSeek V4",
    count: 5,
    need_content: true,
  })
  assert.equal(results[0]?.url, "https://example.com/v4")
})

test("search clamps count into the API range", async () => {
  const { client, calls } = setup(() => jsonResponse({ results: [] }))

  await client.search("query", { count: 500 })

  assert.equal(JSON.parse(String(calls[0]!.init?.body)).count, 50)
})

test("search rejects an empty query before calling the API", async () => {
  const { client, calls } = setup(() => jsonResponse({ results: [] }))

  await assert.rejects(client.search("   "), (error: unknown) => {
    assert.ok(error instanceof DeepSeekError)
    assert.match(error.message, /non-empty query/)
    return true
  })
  assert.equal(calls.length, 0)
})

test("fetch returns Markdown content and a title", async () => {
  const { client, calls } = setup(() =>
    jsonResponse({ title: "Example", content: "# Example\n\nHello world." }),
  )

  const page = await client.fetchPage("https://example.com")
  assert.deepEqual(page, { title: "Example", content: "# Example\n\nHello world." })
  assert.equal(calls[0]!.url, "https://api.deepseek.com/v1/tools/fetch")
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { url: "https://example.com/" })
})

test("fetch rejects an empty 200 response", async () => {
  const { client } = setup(() => jsonResponse({ title: "Empty", content: "   " }))

  await assert.rejects(client.fetchPage("https://example.com"), /could not retrieve usable content/i)
})

test("API errors include the upstream message and status", async () => {
  const { client } = setup(() =>
    jsonResponse(
      { error: { message: "'count' must be between 1 and 50", type: "invalid_request_error" } },
      400,
    ),
  )

  await assert.rejects(client.search("query"), (error: unknown) => {
    assert.ok(error instanceof DeepSeekError)
    assert.equal(error.status, 400)
    assert.match(error.message, /'count' must be between 1 and 50/)
    assert.match(error.message, /HTTP 400/)
    return true
  })
})

test("retryable errors are retried", async () => {
  let attempts = 0
  const { client } = setup(
    () => {
      attempts++
      if (attempts === 1) return jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "0" })
      return jsonResponse({ results: [{ url: "https://example.com", title: "Example" }] })
    },
    { maxRetries: 1 },
  )

  const results = await client.search("query")
  assert.equal(attempts, 2)
  assert.equal(results.length, 1)
})

test("non-retryable errors fail immediately", async () => {
  let attempts = 0
  const { client } = setup(
    () => {
      attempts++
      return jsonResponse({ error: { message: "invalid key" } }, 401)
    },
    { maxRetries: 2 },
  )

  await assert.rejects(client.search("query"), /invalid key/)
  assert.equal(attempts, 1)
})

test("a missing API key fails with a configuration hint", async () => {
  let calls = 0
  const keyless = new DeepSeekClient({
    apiKey: undefined,
    fetch: async () => {
      calls++
      return jsonResponse({ results: [] })
    },
  })

  await assert.rejects(keyless.search("query"), /DEEPSEEK_API_KEY is not set/)
  assert.equal(calls, 0)
})

test("timeouts surface as a clear error", async () => {
  const client = new DeepSeekClient({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async () => {
      throw new DOMException("The operation timed out.", "TimeoutError")
    },
  })

  await assert.rejects(client.search("query"), /timed out after 30000ms/)
})

test("caller aborts are propagated instead of retried", async () => {
  const controller = new AbortController()
  let attempts = 0
  const client = new DeepSeekClient({
    apiKey: "test-key",
    maxRetries: 3,
    fetch: async () => {
      attempts++
      controller.abort(new DOMException("Stopped", "AbortError"))
      throw new DOMException("Stopped", "AbortError")
    },
  })

  await assert.rejects(client.search("query", { signal: controller.signal }), /Stopped/)
  assert.equal(attempts, 1)
})

test("normalizeBaseURL strips trailing slashes and rejects non-HTTP URLs", () => {
  assert.equal(normalizeBaseURL("https://api.deepseek.com///"), "https://api.deepseek.com")
  assert.throws(() => normalizeBaseURL("ftp://example.com"), /http or https/)
  assert.throws(() => normalizeBaseURL("not a url"), /absolute HTTP/)
})

test("apiURL accepts bases with and without /v1", () => {
  assert.equal(apiURL("https://api.deepseek.com", "/tools/search"), "https://api.deepseek.com/v1/tools/search")
  assert.equal(apiURL("https://api.deepseek.com/v1", "/tools/search"), "https://api.deepseek.com/v1/tools/search")
  assert.equal(apiURL("https://proxy.example.com/deepseek", "/tools/fetch"), "https://proxy.example.com/deepseek/v1/tools/fetch")
})

test("normalizeFetchURL accepts only credential-free HTTP(S) URLs", () => {
  assert.equal(normalizeFetchURL("https://example.com"), "https://example.com/")
  assert.throws(() => normalizeFetchURL("file:///etc/passwd"), /HTTP and HTTPS/)
  assert.throws(() => normalizeFetchURL("https://user:pass@example.com"), /username or password/)
  assert.throws(() => normalizeFetchURL(""), /non-empty URL/)
})
