/** Shared text helpers. */

export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[truncated: showing first ${maxChars} of ${text.length} characters]`
}
