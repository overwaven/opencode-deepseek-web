import assert from "node:assert/strict"
import test from "node:test"

import { toWebSearchResults } from "../src/websearch.ts"

test("maps DeepSeek results to websearch results", () => {
  const results = toWebSearchResults(
    [
      {
        url: "https://example.com/a",
        title: "A",
        summary: "A summary",
        snippet: "A snippet",
        date: "2026-01-02T03:04:05Z",
      },
      {
        url: "https://example.com/b",
        title: "B",
        content: "Full page content",
        summary: "B summary",
      },
    ],
    8_000,
  )

  assert.deepEqual(results, [
    {
      url: "https://example.com/a",
      title: "A",
      content: "A summary",
      time: { published: Date.parse("2026-01-02T03:04:05Z") },
    },
    {
      url: "https://example.com/b",
      title: "B",
      content: "Full page content",
      time: {},
    },
  ])
})

test("falls back from content to summary to snippet", () => {
  const results = toWebSearchResults(
    [
      { url: "https://example.com/empty-content", content: "  ", summary: "summary" },
      { url: "https://example.com/no-summary", snippet: "snippet" },
      { url: "https://example.com/none" },
    ],
    8_000,
  )

  assert.equal(results[0]?.content, "summary")
  assert.equal(results[1]?.content, "snippet")
  assert.equal("content" in (results[2] ?? {}), false)
})

test("drops duplicate URLs and results without a URL", () => {
  const results = toWebSearchResults(
    [
      { url: "https://example.com", title: "first" },
      { url: "https://example.com", title: "second" },
      { url: "   ", title: "missing" },
      { title: "also missing" },
    ],
    8_000,
  )

  assert.equal(results.length, 1)
  assert.equal(results[0]?.title, "first")
})

test("uses the URL as a fallback title", () => {
  const results = toWebSearchResults([{ url: "https://example.com" }], 8_000)
  assert.equal(results[0]?.title, "https://example.com")
})

test("truncates long result content", () => {
  const results = toWebSearchResults([{ url: "https://example.com", content: "abcdefghij" }], 4)
  assert.equal(results[0]?.content, "abcd\n\n[truncated: showing first 4 of 10 characters]")
})

test("ignores unparseable publication dates", () => {
  const results = toWebSearchResults([{ url: "https://example.com", date: "not a date" }], 8_000)
  assert.deepEqual(results[0]?.time, {})
})
