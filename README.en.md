<div align="center">

# dsh-architecture-trace

**See what DSH is actually thinking.**

Flattens a whole turn — system prompt, request headers, every model call and streamed response, tool round-trips, TTFT, wrap-up — into one Markdown file you can read, search and diff: **a diagram of DSH's architecture that you can actually see**.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-5b6ce0)
![version](https://img.shields.io/badge/version-0.2.0-blue)
[![GitHub stars](https://img.shields.io/github/stars/aXYer-SI/dsh-architecture-trace?style=social)](https://github.com/aXYer-SI/dsh-architecture-trace/stargazers)

[中文](README.md) · [English](README.en.md) · [Live example](examples/session-demo/turn-01.md) · [Install](#install)

</div>

![Trace illustration: two model segments joined by a switch marker, an event timeline below](docs/preview.svg)

---

## You want this if —

- you are **reading DSH source** and want to see the exact system prompt the model received, and the exact shape of the tool list it was given;
- you are **debugging agent behavior** and need evidence, not guesses: how many steps, which one retried, why the turn ended;
- you are **comparing models or settings** and want TTFT, tok/s, context size and tool round-trip counts;
- you want to **keep a run** — a great one or a spectacular failure — for a write-up or a bug report.

## What it looks like in 30 seconds

```md
## 1 · Model track

This turn has 2 model segments and **1 switch**.

| Segment | Model | Start | Duration | Calls | Cause |
|--:|---|---|--:|--:|---|
| 1 | `deepseek/deepseek-v4.1-flash` | +0.006s | 268ms | 1 | `initial` |
| 2 | 🔀 `workbuddy/glm-5.3` | +0.274s | 0ms | 1 | `change` |

> 🔀 **Model switch**: `deepseek/deepseek-v4.1-flash` → `workbuddy/glm-5.3` (+0.274s)

## 2 · Full timeline

| # | Offset | Source | Event | Model | Summary |
|--:|--:|---|---|---|---|
| 3 | +0.006s | 🗄 durable | `request/header` | deepseek/deepseek-v4.1-flash | reason initial |
| 4 | +0.006s | 🗄 durable | `system/message` | · | system prompt 24,706 chars |
```

A complete turn is in the [live example](examples/session-demo/turn-01.md).

## Inside DSH

<p align="center">
  <img src="docs/screenshots/timeline.gif" alt="Rendered inside DSH: durable 🗄 rows first (turns, system prompt, user messages, tool calls), then the in-memory ⚡ rows (each llm/call, first-chunk TTFT, finish)" width="100%">
</p>

<p align="center"><sub>🗄 durable (replayable) ↔ ⚡ in-memory (live only), alternating</sub></p>

## What it records

| Badge | Source | Content | Replayable |
|---|---|---|---|
| 🗄 **Durable** | `session/event` (session log) | system prompt, request headers, final model messages, tool calls and results, turn boundaries | yes |
| ⚡ **In-memory** | `llm/stream`, `agent/status`, `agent/request-error` | **every model request** and its streamed response, TTFT, duration, chunk statistics, status transitions, request failures | no, gone with the process |

This is the part the plugin is pedantic about: every line is labelled with its layer, the timeline has a Source column, and section headings carry their layer too. You never mistake a live-only sample for a replayable log entry.

## Highlights

- **Two layers, never blurred.** Durable log and one-shot in-process activity are recorded and rendered separately.
- **Model switches stand out.** Segment table, 🔀 banners, a model column in the timeline, and field-level diffs in the request headers.
- **A performance ledger.** Message counts, characters, tool counts, TTFT, total duration, tokens, tok/s per request.
- **Failures leave a trace.** Retries, request errors and cancelled attempts appear in §5.x and §8 instead of vanishing.
- **Non-invasive.** No tools registered, no network requests, no prompt changes — it only listens to DSH events.
- **Never breaks a task.** Every hook is wrapped in `try/catch`; a recording failure logs one warning.

## Install

### Option 1 — DSH plugin market index (recommended)

1. Settings → Plugins → enable the experimental plugin market bundle if you have no Discover tab;
2. Add this index URL in Discover:

   ```
   https://raw.githubusercontent.com/aXYer-SI/dsh-architecture-trace/main/plugin-index.json
   ```

3. Search `learning trace` and install.

### Option 2 — Local directory

DSH → Settings → Plugins → Add plugin, pick this repository directory (the level containing `package.json`), then enable the `architecture-trace` row.

### Option 3 — CLI

```powershell
plugin_manager install_bundle target="D:\path\to\dsh-architecture-trace"
```

Installation links the directory: edit the source and refresh DSH — no reinstall. Requires DSH desktop (profile launch); Node.js ≥ 20 is for development and tests only.

## What using it feels like

1. Install it and work as usual — no habit change;
2. At the end of each turn, `dsh-traces/session-xxxx/turn-NN.md` appears (300 ms debounce, immediate flush at turn end);
3. Open it and read from §0 down, or search for `request/header` / `tool/call`.

## Output layout

Written to `dsh-traces/` in the session's working directory by default:

```
dsh-traces/
├── 00-格式说明.md              ← reading guide (written on first use)
└── session-xxxx/
    ├── index.md                ← turn index
    ├── turn-00.md              ← auxiliary calls outside a turn
    └── turn-01.md              ← the full first turn
```

## The nine sections of a turn file

| Section | Content | Layer |
|---|---|---|
| 0 · Overview | duration, steps, model track, switches, tool count, tokens | mixed |
| 1 · Model track | **which models took part, when the switch happened, calls per segment** | 🗄 + ⚡ |
| 2 · Full timeline | everything in order, with source and current-model columns | 🗄 + ⚡ |
| 3 · Prompts | the complete `system/message` text | 🗄 |
| 4 · Request headers | model config, tool list, field diff against the previous version | 🗄 |
| 5 · Model output | reasoning / text / tool requests for every step | 🗄 |
| 6 · Tool calls | arguments, results, duration, success or failure | 🗄 |
| 7 · Model conversation detail | request size, TTFT, duration, characters, tokens, tok/s | ⚡ |
| 8 · Wrap-up | end reason, errors, other events | 🗄 |

§5 and §7 complement each other: §5 is the durable final message, §7 is the call site where retries and per-chunk streams show up. For performance work, read §7.

## Spotting a mid-turn model switch

1. **§0 Overview** — model track shows `A → B`, switch count shows `🔀 N`;
2. **§1 Model track** — segment table plus a `🔀` banner;
3. **§2 Timeline** — the model column, with `🔀` on the `request/header` row where the switch happened;
4. **§4 / §5 / §7** — field-level diffs and switch banners.

The authority is the durable `request/header` event (reason `change`); the ⚡ calls confirm which model was actually used.

## Configuration

On the plugin row, or in the profile's patch layer:

```yaml
- id: architecture-trace
  config:
    outputDir: "C:/Users/you/dsh-traces"  # empty = <session cwd>/dsh-traces
    captureLlmCalls: true                  # ⚡ record every model call and stream
    includeStream: false                   # include the per-chunk record
    includeRaw: false                      # include raw event JSON
```

| Option | Default | Meaning |
|---|---|---|
| `outputDir` | empty | absolute path; empty writes into each session's own working directory |
| `captureLlmCalls` | `true` | turn off to keep only the durable layer, minimal overhead |
| `includeStream` | `false` | larger files |
| `includeRaw` | `false` | for debugging the plugin itself |

## Example

[`examples/session-demo/`](examples/session-demo/) is a fully synthetic sample generated by the test suite, deliberately including a mid-turn model switch:

- [00-格式说明.md](examples/session-demo/00-格式说明.md) — reading guide
- [index.md](examples/session-demo/index.md) — turn index
- [turn-01.md](examples/session-demo/turn-01.md) — the full first turn

## Privacy

These files are raw, machine-oriented records: the full system prompt, the opening of user messages, tool arguments and results (file contents, command output, API responses), and model output including reasoning.

Before sharing, search for tokens, keys, internal hostnames and personal data. Pointing `outputDir` outside version control is the easier habit.

## Tradeoffs and known limits

- **Only sessions in this process are recorded.** History is not backfilled; use the `session_*` tools for old sessions.
- **The ⚡ layer is lossy by nature**: it dies with the process, and the file is a snapshot taken at render time. Chunk samples are capped at 300 per call.
- **One file per turn**; auxiliary calls outside a turn land in `turn-00.md`.
- **No rotation, no cleanup**; output grows with use.
- **Chinese UI copy in 0.1.0**, and no interactive view on purpose — the output must stay greppable and diffable.

## Development

```powershell
node test/trace.test.mjs   # synthetic events + simulated stream
```

```
lib/index.js   plugin entry: session/event and llm/stream hooks, recording state, debounced flush
lib/render.js  pure rendering: turn record -> Markdown
lib/guide.js   body of 00-格式说明.md
```

## About the author

**aXyer** — independent developer with a long-standing interest in philosophy, Buddhism and psychology, now starting out with AI-assisted programming (vibe coding). This plugin is a by-product of learning to read DSH's internals.

A ⭐ is enough if it saves you some source reading; issues and pull requests welcome.

## License

[MIT](LICENSE) © 2026 aXyer
