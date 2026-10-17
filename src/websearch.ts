import type { DeepSeekSearchResult } from "./client.ts"
import { truncate } from "./text.ts"

/**
 * Structural shape of an OpenCode websearch result.
 * Kept local so the provider can be tested without loading the plugin runtime.
 */
export interface WebSearchResult {
  readonly url: string
  readonly title?: string
  readonly content?: string
  readonly time: { readonly published?: number }
}

/**
 * Convert DeepSeek results into OpenCode websearch results.
 *
 * DeepSeek returns `summary` (600-800 characters), `snippet`, and optionally
 * the full page in `content`. When full content was not requested, the summary
 * is the best value for a model to read.
 */
export function toWebSearchResults(
  results: readonly DeepSeekSearchResult[],
  maxContentChars: number,
): WebSearchResult[] {
  const seen = new Set<string>()
  const mapped: WebSearchResult[] = []

  for (const result of results) {
    const url = result.url?.trim()
    if (!url || seen.has(url)) continue
    seen.add(url)

    const content = firstNonEmpty(result.content, result.summary, result.snippet)
    mapped.push({
      url,
      title: result.title?.trim() || url,
      ...(content ? { content: truncate(content, maxContentChars) } : {}),
      time: publishedTime(result.date),
    })
  }

  return mapped
}

function firstNonEmpty(...values: ReadonlyArray<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ""
}

function publishedTime(date: string | null | undefined): { published?: number } {
  const parsed = date ? Date.parse(date) : Number.NaN
  return Number.isFinite(parsed) ? { published: parsed } : {}
}
