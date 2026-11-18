# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-11-18

### Changed

- Bilingual table headers now use two lines instead of one label: Chinese on the first line,
  English on the second (`摘要` then `Abstract`, joined with `<br>`). Narrow columns no longer
  break a label mid-word, and the header reads as two tidy rows.

## [0.4.0] - 2026-11-18

### Changed

- Table headers in the generated Markdown are bilingual, e.g. `摘要 Abstract`, `偏移 Offset`,
  `来源 Source`, `事件 Event`, `模型 Model`. It applies to every table in the turn file, the
  session index and the reading guide, so the structure can be scanned in either language.

## [0.3.0] - 2026-11-18

### Added

- `captureRealtime` (default `true`): switch the whole ⚡ in-memory layer off. The plugin then attaches
  no model-stream, status or request-error hook, and the file keeps only replayable durable events.
- `summaryMaxChars` (default `0`, meaning no limit): timeline summaries now keep the complete text
  instead of being cut at 80-100 characters. Set a positive budget if you want compact files.

### Changed

- §2 summaries, §8's event table and the empty-state hints follow the new budget and name the
  realtime switch, so an empty section explains itself.
- README (both languages), locale copy and the market index now describe the benchmarking use case —
  TTFT, tok/s, context size and finish reasons — next to the architecture walkthrough.

## [0.2.0] - 2026-11-18

### Changed

- **Package renamed** from `dsh-learning-trace` to `dsh-architecture-trace`, and the plugin row from
  `learning-trace` to `architecture-trace`. The old name read like an education product, while the
  plugin shows how DSH wires a prompt, a model call and a tool round-trip into one turn. The GitHub
  repository moves with it, so every URL, badge and the market index follow the new name.
- The output directory is unchanged (`dsh-traces/`), so earlier traces stay where they are.

## [0.1.2] - 2026-11-18

### Changed

- Display title is now 「DSH 架构追踪」/ "DSH architecture trace" instead of 「学习追踪」/
  "Learning trace". The old name read like an education product; the plugin is about seeing how
  DSH wires a prompt, a model call and a tool round-trip into one turn.
- Package description states that architecture angle.

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

[0.4.1]: https://github.com/aXYer-SI/dsh-architecture-trace/releases/tag/v0.4.1
[0.4.0]: https://github.com/aXYer-SI/dsh-architecture-trace/releases/tag/v0.4.0
[0.3.0]: https://github.com/aXYer-SI/dsh-architecture-trace/releases/tag/v0.3.0
[0.2.0]: https://github.com/aXYer-SI/dsh-architecture-trace/releases/tag/v0.2.0
[0.1.2]: https://github.com/aXYer-SI/dsh-architecture-trace/releases/tag/v0.1.2
[0.1.1]: https://github.com/aXYer-SI/dsh-architecture-trace/releases/tag/v0.1.1
[0.1.0]: https://github.com/aXYer-SI/dsh-architecture-trace/releases/tag/v0.1.0
