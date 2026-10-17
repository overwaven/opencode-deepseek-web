import assert from "node:assert/strict"
import test from "node:test"

import { resolveConfig } from "../src/config.ts"

test("applies defaults", () => {
  const config = resolveConfig({}, { DEEPSEEK_API_KEY: "env-key" })

  assert.deepEqual(config, {
    apiKey: "env-key",
    baseURL: "https://api.deepseek.com",
    count: 10,
    needContent: false,
    maxResultChars: 8_000,
    maxFetchChars: 100_000,
    timeoutMs: 30_000,
    maxRetries: 2,
    setDefault: true,
  })
})

test("an explicit apiKey wins over the environment", () => {
  const config = resolveConfig({ apiKey: "option-key" }, { DEEPSEEK_API_KEY: "env-key" })
  assert.equal(config.apiKey, "option-key")
})

test("a missing key is allowed and reported as undefined", () => {
  assert.equal(resolveConfig({}, {}).apiKey, undefined)
})

test("overrides are validated", () => {
  const config = resolveConfig(
    {
      baseURL: "https://proxy.example.com/deepseek/",
      count: 3,
      needContent: true,
      maxResultChars: 2_000,
      maxFetchChars: 4_000,
      timeoutMs: 5_000,
      maxRetries: 0,
      setDefault: false,
    },
    {},
  )

  assert.equal(config.baseURL, "https://proxy.example.com/deepseek")
  assert.equal(config.count, 3)
  assert.equal(config.needContent, true)
  assert.equal(config.maxResultChars, 2_000)
  assert.equal(config.maxFetchChars, 4_000)
  assert.equal(config.timeoutMs, 5_000)
  assert.equal(config.maxRetries, 0)
  assert.equal(config.setDefault, false)
})

test("rejects invalid values with the option name", () => {
  assert.throws(() => resolveConfig({ apiKey: "  " }, {}), /"apiKey"/)
  assert.throws(() => resolveConfig({ baseURL: "ftp://example.com" }, {}), /baseURL/)
  assert.throws(() => resolveConfig({ count: 51 }, {}), /"count"/)
  assert.throws(() => resolveConfig({ count: 1.5 }, {}), /"count"/)
  assert.throws(() => resolveConfig({ needContent: "yes" }, {}), /"needContent"/)
  assert.throws(() => resolveConfig({ timeoutMs: 10 }, {}), /"timeoutMs"/)
  assert.throws(() => resolveConfig({ maxRetries: 6 }, {}), /"maxRetries"/)
})
