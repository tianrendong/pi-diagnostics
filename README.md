# pi-diagnostics

Pi extension that opts into provider prompt-cache diagnostics and stores returned results in the session transcript.

- **Anthropic Messages:** adds `diagnostics.previous_message_id` on every request. First request sends `null`; later requests reference preceding `responseId`.
- **OpenAI Responses:** adds `prompt_cache_options.comparison_response_id` when a previous response exists.
- Captures diagnostics from streaming `message_start` / `response.completed` events without changing response bytes.
- Adds `anthropic_cache_diagnostics` / `openai_prompt_cache_diagnostics` to assistant messages.
- Diagnostics notifications use `Cache miss, provider diagnostics reason: X`, without a `Warning:` prefix or token counts. `unavailable` warns only when cached tokens actually dropped versus previous turn (under half of previous prompt read from cache, more than 1,024 tokens lost).
- Notices are saved as non-context session entries and rendered again on resume, reload, and transcript rebuilds, like Pi's native cache-miss notices. Automatic notices are recorded at turn end, after the assistant response. They never add model context or trigger another turn.
- `/diagnostics` shows recent results and saves its output in session history.

Provider diagnostics are free and best-effort. No prompt or output content is persisted by this extension. Provider fingerprints are handled under provider retention policies.

## Install

Requires [Pi](https://pi.dev) and Node.js 22.19 or newer.

```bash
pi install npm:pi-diagnostics
```

Restart Pi or run `/reload` to load the extension.

Or add the npm source to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-diagnostics"]
}
```

## Configuration

Defaults enable providers named `anthropic`, `openai`, and `ramp-router`. This covers Ramp Router's OpenAI Responses adapter while avoiding unrelated proxy routes that may reject provider-specific fields.

```bash
# Enable every supported API route, including other routers/proxies.
export PI_DIAGNOSTICS_PROVIDERS='*'

# Only enable one provider.
export PI_DIAGNOSTICS_PROVIDERS='openai'

# Notices: miss (default), all, or off. Raw diagnostics remain on assistant messages with off.
# Selected notices persist even in non-interactive sessions; RPC also receives a UI notification.
export PI_DIAGNOSTICS_NOTIFY=all

# Disable extension behavior without removing package.
export PI_DIAGNOSTICS=0
```

Anthropic diagnostics require direct Claude API support. OpenAI diagnostics require Responses API models that support prompt-cache diagnostics (GPT-5.6+ per OpenAI docs). Unsupported routes should be excluded from `PI_DIAGNOSTICS_PROVIDERS`.

## Development

```bash
git clone https://github.com/tianrendong/pi-diagnostics.git
cd pi-diagnostics
npm ci --ignore-scripts
npm run check
npm test
```

Test the local extension without installing the package:

```bash
pi --extension ./src/index.ts
```

## License

MIT
