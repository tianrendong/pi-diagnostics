# pi-diagnostics

Know why your prompt cache missed, and when it's gone.

- **Cache-miss reasons.** When a turn re-bills cached tokens, see the provider's explanation (Anthropic, OpenAI):

  ```
  Cache miss: 42k tokens re-billed (~$0.12)
  ↳ Provider diagnostics reason: tools_changed
  ```

- **Expiry reminders.** A note appears when your cache has likely expired, so you know it's a cheap moment to `/compact`, switch models, or change tools.

- **Smarter cache warming.** With `cacheWarming: "idle"`, keeps the cache warm when you're likely to reply soon: text in the editor, a queued message, or the agent's last message asks you something. It only ever adds warms that clear Pi's savings bar; it never cancels warming Pi chose.

Diagnostics and reminders are display-only and never add to model context.

## Install

```bash
pi install npm:pi-diagnostics
```

Run `/diagnostics` to see recent results.

## License

MIT
