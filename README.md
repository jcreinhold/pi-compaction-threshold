# pi-compaction-threshold

A [Pi](https://pi.dev) extension that proactively compacts the session once
estimated context usage crosses a configurable **token ceiling** — before Pi's
own window-relative auto-compaction would fire.

Pi's built-in compaction triggers when

```
contextTokens > contextWindow - reserveTokens
```

so on a large-window model (say 1M tokens) it waits until ~984k. That leaves a
lot of context to reread on every turn. This extension lets you say "compact
once we pass *N* tokens, whatever the model's window" — an earlier, fixed
ceiling.

```
tokens: 0 ──────────────────────── N (ceiling) ─────────── contextWindow - reserveTokens
                                          │                        │
                                   compact here              Pi would compact here
```

It is a *trigger only*: the actual summarization is Pi's own compaction
machinery (`ctx.compact()`), with its own settings (`compaction.keepRecentTokens`,
`compaction.reserveTokens`).

## Why an absolute ceiling (instead of a percentage)

The ceiling ignores `contextWindow` deliberately. The point is to compact
before the window-relative threshold, so the decision must not move when you
switch models. On a model whose window is smaller than the ceiling, the
ceiling is simply never reached — Pi's native overflow protection still fires
first. **Leave Pi's native auto-compaction enabled.** This extension only adds
an earlier firing point; it never replaces the overflow safety net.

## Install

```sh
mkdir -p ~/.pi/agent/extensions
ln -s ~/Code/pi-compaction-threshold ~/.pi/agent/extensions/pi-compaction-threshold
```

Then run `/reload` in Pi (auto-discovered extensions hot-reload).

To uninstall: remove the symlink and `/reload` again.

## Configure

Settings live in Pi's own settings files — `~/.pi/agent/settings.json`
(global) or `<project>/.pi/settings.json` (project overrides global):

```json
{
  "compactionThreshold": {
    "enabled": true,
    "tokens": 250000
  }
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `compactionThreshold.enabled` | boolean | `true` | Master switch for the proactive trigger |
| `compactionThreshold.tokens` | positive integer | `250000` | Compact when estimated context tokens reach this ceiling |

Invalid values do not break the extension: each bad field falls back to its
default and you get a one-time warnings notification on `session_start`.

## Behavior

- Decision point: `turn_end` (the turn is complete; compaction's context
  rebuild cannot race an in-flight request).
- `tokens` unknown (right after a compaction, before the next LLM response)
  is treated as "no decision", never as "compact".
- While a compaction is in flight, further threshold crossings are ignored,
  so long-running agent loops cannot stack compactions.

### The `keepRecentTokens` trap

After compacting, Pi keeps the most recent `compaction.keepRecentTokens`
(default 20k) unsummarized. If your ceiling sits **at or below** that number,
the kept remainder alone re-crosses the ceiling — every post-compaction turn
fires a fresh compaction, forever.

If you set such a ceiling, the extension warns you about it at
`session_start` (never clamps silently). As a rule of thumb, leave real
headroom above 20k — the default 250k is ~12×.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest: config parsing + decision function
```

Layout follows the [pi extension template](https://pi.dev/docs/latest/extensions)
with two deviations, noted for future maintainers:

- Single entry point: the Pi-facing wrapper is `index.ts` at the repo root
  (so a symlink into `~/.pi/agent/extensions/` is discovered as
  `*/index.ts`); the entire `src/` tree is Pi-agnostic — no
  `@earendil-works/pi-*` imports.
- No settings command (`/compact-threshold:settings`), no migrations, no
  event bus: one knob, configured directly in `settings.json`.

## License

MIT
