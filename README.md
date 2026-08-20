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

### Check points

The ceiling is enforced **mid-turn**, not just at turn boundaries, because
long autonomous agent loops (many tool rounds inside one user message) do
most of their context growth between `turn_end` events. Each completed unit
of work is a check point:

- `turn_end` — a turn boundary (the case the original design covered)
- `tool_execution_end` — after each finished tool call, the biggest source
  of mid-turn context growth; the tool is already complete, so nothing
  in-flight is lost
- `message_end` (assistant) — a single long response that crossed the
  ceiling on its own

### The interruption

When a check point finds estimated context at/above the ceiling, the
extension calls `ctx.compact()`. Pi's manual compaction **aborts the current
agent operation first** (its own documented contract), so the running turn
is interrupted, the session is compacted, and the agent goes idle.

Two consequences worth knowing:

1. **The interrupted turn does not resume on its own.** Manual compaction
   (`reason: "manual"`) never sets Pi's retry flag; only Pi's own
   context-overflow recovery retries a turn, and an extension cannot request
   that path. What you lose is the *rest* of the current turn — nothing is
   deleted from the session, and the structured summary's `## Progress` /
   `## Next Steps` sections exist precisely so you can say **"continue"**
   and pick up where it stopped.
2. **No stacking.** While a compaction is in flight, further check points
   ignore the threshold, so a grinding halt cannot queue a second one.

### Edge cases

- `tokens` unknown (right after a compaction, before the next LLM response)
  is treated as "no decision", never as "compact".
- If the ceiling is set below the current context at install time, the next
  check point fires immediately — expected; raise the ceiling.
- A failed summarization leaves the session as it was (no partial compaction)
  and notifies; the next check point retries.

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
