import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../src/index.ts"

interface Registered {
  id: string
  name: string
  execute: (input: { query: string }, context: { signal: AbortSignal }) => Promise<unknown>
}

interface RegisteredTool {
  name: string
  execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}

interface Harness {
  provider: Registered | undefined
  tool: RegisteredTool | undefined
  selected: string | false | undefined
  namespace: string | undefined
}

async function load(options: Record<string, unknown>): Promise<Harness> {
  const harness: Harness = { provider: undefined, tool: undefined, selected: undefined, namespace: undefined }

  const ctx = {
    options,
    websearch: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (provider: Registered) => {
            harness.provider = provider
          },
          default: {
            get: () => harness.selected,
            set: (selection: string | false) => {
              harness.selected = selection
            },
          },
        })
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          namespace: (namespace: { name: string }) => {
            harness.namespace = namespace.name
          },
          add: (tool: RegisteredTool) => {
            harness.tool = tool
          },
        })
        return { dispose: async () => {} }
      },
    },
  }

  await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0])
  return harness
}

function withFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    return handler(url, init)
  }) as typeof fetch

  return () => {
    globalThis.fetch = original
  }
}

test("registers a DeepSeek websearch provider, selects it, and adds deepseek_fetch", async () => {
  const harness = await load({ apiKey: "test-key" })

  assert.equal(harness.provider?.id, "deepseek")
  assert.equal(harness.provider?.name, "DeepSeek Search")
  assert.equal(harness.selected, "deepseek")
  assert.equal(harness.namespace, "deepseek")
  assert.equal(harness.tool?.name, "fetch")
})

test("does not override the provider selection without a key", async (t) => {
  const warn = t.mock.method(console, "warn", () => {})
  const hadKey = Object.hasOwn(process.env, "DEEPSEEK_API_KEY")
  const previous = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY

  try {
    const harness = await load({})

    assert.equal(harness.provider?.id, "deepseek")
    assert.equal(harness.selected, undefined)
    assert.equal(warn.mock.callCount(), 1)
  } finally {
    if (hadKey && previous !== undefined) process.env.DEEPSEEK_API_KEY = previous
  }
})

test("the websearch provider returns OpenCode results", async () => {
  const restore = withFetch(() =>
    Response.json({
      results: [
        {
          title: "Example",
          url: "https://example.com",
          summary: "A summary",
          date: "2026-01-01T00:00:00Z",
        },
      ],
    }),
  )

  try {
    const harness = await load({ apiKey: "test-key" })
    const results = (await harness.provider!.execute(
      { query: "example" },
      { signal: new AbortController().signal },
    )) as Array<{ url: string; content: string; time: { published?: number } }>

    assert.equal(results.length, 1)
    assert.equal(results[0]?.url, "https://example.com")
    assert.equal(results[0]?.content, "A summary")
    assert.equal(results[0]?.time.published, Date.parse("2026-01-01T00:00:00Z"))
  } finally {
    restore()
  }
})

test("deepseek_fetch returns Markdown and metadata", async () => {
  const content = "a".repeat(600)
  const restore = withFetch(() => Response.json({ title: "Example", content }))

  try {
    const harness = await load({ apiKey: "test-key", maxFetchChars: 500 })
    const result = await harness.tool!.execute(
      { url: "https://example.com" },
      { signal: new AbortController().signal },
    )

    assert.ok(result.content?.startsWith("a".repeat(500)))
    assert.match(result.content ?? "", /\[truncated: showing first 500 of 600 characters\]$/)
    assert.deepEqual(result.metadata, {
      url: "https://example.com",
      title: "Example",
      characters: 600,
      truncated: true,
    })
  } finally {
    restore()
  }
})

test("deepseek_fetch surfaces API errors as tool errors", async () => {
  const restore = withFetch(() =>
    Response.json({ error: { message: "Insufficient balance" } }, { status: 402 }),
  )

  try {
    const harness = await load({ apiKey: "test-key" })
    await assert.rejects(
      harness.tool!.execute({ url: "https://example.com" }, { signal: new AbortController().signal }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Insufficient balance/)
        assert.match(error.message, /insufficient balance/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test("deepseek_fetch rejects missing URLs", async () => {
  const harness = await load({ apiKey: "test-key" })
  await assert.rejects(
    harness.tool!.execute({}, { signal: new AbortController().signal }),
    /non-empty url/,
  )
})
