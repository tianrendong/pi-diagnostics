# pi-diagnostics

Know why your prompt cache missed, and when it's gone.

- **Cache-miss reasons.** When a turn re-bills cached tokens, see the provider's explanation (Anthropic, OpenAI):

  ```
  Cache miss: 42k tokens re-billed (~$0.12)

  ↳ Provider diagnostics reason: tools_changed
  ```

- **Expiry reminders.** A note appears when your cache has likely expired, so you know it's a cheap moment to `/compact`, switch models, or change tools.

Both are display-only and never add to model context.

## Install

```bash
pi install npm:pi-diagnostics
```

Run `/diagnostics` to see recent results.

## License

MIT
