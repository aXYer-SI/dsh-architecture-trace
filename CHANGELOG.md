# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-18

### Fixed

- A structured finish reason, such as `{ kind: 'tool-calls' }`, rendered as `[object Object]`
  in the timeline summary, in the per-call detail and in the §7 request table. It now shows the
  kind, any error, and the chunk count. Covered by a test with an object finish reason.

### Added

- Screenshots of a real trace in the README, showing the 🗄 durable rows and the ⚡ in-memory rows.

## [0.1.0] - 2026-11-18

### Added

- Session recording over `session/event`: system prompt, request headers with field diffs,
  assistant messages, tool calls and results, turn and step boundaries.
- In-memory recording over `llm/stream`: every model call, time to first chunk, duration,
  chunk and character statistics, token usage, finish reason.
- Status transitions (`agent/status`) and model request failures (`agent/request-error`).
- Per-turn Markdown renderer with nine sections and an explicit 🗄 durable / ⚡ in-memory label
  on every line.
- Model-track detection: segments, switch banners, and a model column in the timeline.
- Debounced flushing (300 ms), immediate flush at turn end, final flush on session disposal.
- Options: `outputDir`, `captureLlmCalls`, `includeStream`, `includeRaw`.
- Reading guide (`00-格式说明.md`) written once per output directory.
- Test suite with synthetic events and a simulated stream.

[0.1.1]: https://github.com/aXYer-SI/dsh-learning-trace/releases/tag/v0.1.1
[0.1.0]: https://github.com/aXYer-SI/dsh-learning-trace/releases/tag/v0.1.0
