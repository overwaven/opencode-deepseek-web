# opencode-deepseek-web

DeepSeek **Search** and **Fetch** for [OpenCode V2](https://opencode.ai/v2/docs/).

The plugin plugs DeepSeek's in-house search engine into OpenCode's built-in
`websearch` tool, and adds a `deepseek_fetch` tool that turns a URL into Markdown
through DeepSeek's Fetch API. No browser, no separate gateway, and no changes to
your model provider.

## What it adds

- **`websearch` provider `deepseek`** — the existing `websearch` tool queries
  `POST https://api.deepseek.com/v1/tools/search` and receives DeepSeek's ranked
  results, summaries, publication dates, and optional full page content.
- **`deepseek_fetch` tool** — fetches one URL with
  `POST https://api.deepseek.com/v1/tools/fetch` and returns the page as Markdown.
  It declares the `webfetch` permission, so existing rules keep working.
- Timeouts, bounded retries for `408`, `429`, and `5xx`, `Retry-After` support,
  deduplicated results, and truncation of oversized pages.

DeepSeek's Fetch API is separate from the built-in `webfetch` tool, which reads
the URL directly. Both can coexist: use `deepseek_fetch` when you want DeepSeek's
extraction and Markdown conversion.

## Install

Add the package to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-deepseek-web"]
}
```

Or install it with the OpenCode CLI:

```bash
opencode plugin add opencode-deepseek-web
# or straight from GitHub, before the npm release
opencode plugin add github:overwaven/opencode-deepseek-web
```

For local development, point `plugins` at the package directory:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-deepseek-web"]
}
```

Restart the OpenCode service after changing plugins:

```bash
opencode service restart
```

## API key

The plugin reads `DEEPSEEK_API_KEY` from the environment:

```bash
export DEEPSEEK_API_KEY=sk-...
opencode
```

Or pass it as a plugin option:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-deepseek-web",
      "options": {
        "apiKey": "sk-..."
      }
    }
  ]
}
```

The same key is used for both Search and Fetch. Search and Fetch are billed per
successful request, and both are rate limited per account (5 QPS each). See the
[DeepSeek Search & Fetch guide](https://api-docs.deepseek.com/guides/search).

## Usage

Once installed, just ask:

```text
Search the web for the latest DeepSeek V4 release notes and cite the sources.
```

The model calls the `websearch` tool, which uses DeepSeek. To read a specific
page, the model calls `deepseek_fetch`:

```text
Fetch https://api-docs.deepseek.com/guides/search and summarize the rate limits.
```

DeepSeek search operators work because the query is forwarded unchanged:
`site:`, `-site:`, quoted phrases, `lang:`, `after:`, and `before:`.

## Selecting the provider

By default the plugin makes `deepseek` the active websearch provider. To keep
another provider and still use it explicitly:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-deepseek-web",
      "options": { "setDefault": false }
    }
  ],
  "websearch": { "provider": "exa" }
}
```

Then choose `deepseek` when OpenCode asks, or set it as the configured provider.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `DEEPSEEK_API_KEY` | DeepSeek API key. |
| `baseURL` | `https://api.deepseek.com` | API base URL, including a proxy prefix if needed. A trailing `/v1` is accepted. |
| `count` | `10` | Search results per query, 1–50. `count` does not change the per-request price. |
| `needContent` | `false` | Ask DeepSeek for full page content in each search result. Larger context, one request. |
| `maxResultChars` | `8000` | Per-result content cap when `needContent` is on. |
| `maxFetchChars` | `100000` | Cap for `deepseek_fetch` output before truncation. |
| `timeoutMs` | `30000` | Timeout per HTTP attempt. |
| `maxRetries` | `2` | Retries for `408`, `429`, and `5xx` responses, 0–5. |
| `setDefault` | `true` | Make `deepseek` the default `websearch` provider when an API key is available. |

Example with options:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-deepseek-web",
      "options": {
        "count": 8,
        "needContent": false,
        "maxFetchChars": 60000
      }
    }
  ]
}
```

## Permissions

OpenCode's standard actions apply:

- `websearch` with the query as the resource.
- `webfetch` with the requested URL as the resource for `deepseek_fetch`.

Allow them explicitly if your configuration asks for approval:

```jsonc
{
  "permissions": [
    { "action": "websearch", "resource": "*", "effect": "allow" },
    { "action": "webfetch", "resource": "*", "effect": "allow" }
  ]
}
```

## Development

```bash
npm install
npm run typecheck
npm test
```

The plugin is written in TypeScript and published as TypeScript source, which
OpenCode loads directly. Tests use Node's built-in test runner and type
stripping.

To publish a release:

```bash
npm version patch
npm publish
```

## License

MIT
