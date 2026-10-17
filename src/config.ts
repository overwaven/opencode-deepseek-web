import type { PluginOptions } from "@opencode/plugin"

import { DEFAULT_BASE_URL, normalizeBaseURL } from "./client.ts"

export const PLUGIN_ID = "deepseek.web"
export const PROVIDER_ID = "deepseek"
export const TOOL_NAMESPACE = "deepseek"

export interface ResolvedConfig {
  readonly apiKey: string | undefined
  readonly baseURL: string
  readonly count: number
  readonly needContent: boolean
  readonly maxResultChars: number
  readonly maxFetchChars: number
  readonly timeoutMs: number
  readonly maxRetries: number
  readonly setDefault: boolean
}

/**
 * Read and validate plugin options. Invalid values fail plugin setup with a
 * message that names the option, instead of failing later inside a tool call.
 */
export function resolveConfig(options: PluginOptions, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  return {
    apiKey: resolveApiKey(options, env),
    baseURL: normalizeBaseURL(stringOption(options, "baseURL", DEFAULT_BASE_URL)),
    count: integerOption(options, "count", 10, 1, 50),
    needContent: booleanOption(options, "needContent", false),
    maxResultChars: integerOption(options, "maxResultChars", 8_000, 500, 10_000_000),
    maxFetchChars: integerOption(options, "maxFetchChars", 100_000, 500, 10_000_000),
    timeoutMs: integerOption(options, "timeoutMs", 30_000, 1_000, 120_000),
    maxRetries: integerOption(options, "maxRetries", 2, 0, 5),
    setDefault: booleanOption(options, "setDefault", true),
  }
}

function resolveApiKey(options: PluginOptions, env: NodeJS.ProcessEnv): string | undefined {
  if (options.apiKey !== undefined) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new Error('[deepseek-web] "apiKey" must be a non-empty string.')
    }
    return options.apiKey.trim()
  }

  const fromEnv = env.DEEPSEEK_API_KEY?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined
}

function stringOption(options: PluginOptions, name: string, fallback: string): string {
  const value = options[name]
  if (value === undefined) return fallback
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`[deepseek-web] "${name}" must be a non-empty string.`)
  }
  return value
}

function booleanOption(options: PluginOptions, name: string, fallback: boolean): boolean {
  const value = options[name]
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    throw new Error(`[deepseek-web] "${name}" must be true or false.`)
  }
  return value
}

function integerOption(options: PluginOptions, name: string, fallback: number, min: number, max: number): number {
  const value = options[name]
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`[deepseek-web] "${name}" must be an integer.`)
  }
  if (value < min || value > max) {
    throw new Error(`[deepseek-web] "${name}" must be between ${min} and ${max}.`)
  }
  return value
}
