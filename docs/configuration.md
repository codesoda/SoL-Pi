# Configuration

SoL-Pi reads one effective JSON configuration file at extension startup. It uses Pi's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs rather than assuming fixed directories.

## Search order

1. `<working-directory>/<Pi config directory>/sol-pi.json`, only after Pi marks the project trusted
2. `<Pi agent directory>/sol-pi.json`
3. Built-in defaults when neither file exists

For the official Pi distribution, the first two locations normally resolve to `.pi/sol-pi.json` and `~/.pi/agent/sol-pi.json`.

The project file replaces the global file. SoL-Pi does not merge them.

## Schema

```json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": false,
  "observationPackThresholdsKiB": { "default": 10 },
  "evidencePreservingReducer": false,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

Feature keys may be omitted and then default to `false`. `cacheWriteReadRatio` may be omitted and then defaults to `12.5`; when present it must be a finite non-negative number, and `0` explicitly means that a cache write adds no cost relative to a cache read. `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` may be omitted and then use the built-in reducer route; when present each must be a non-empty string. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid ratios, and invalid reducer model fields stop extension loading with a direct error.

For the managed all-enabled installation described in the [agent installation and configuration protocol](../agents-install.md), validate the effective file before starting Pi:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

This preflight does not make every valid SoL-Pi configuration all-enabled. Without `--require-all-enabled`, omitted feature keys retain their normal `false` defaults. The managed workflow uses the flag because its acceptance criterion is that all four mechanisms are active.

## Feature behavior

- `actionFusion`: registers SoL-Pi replacements for Pi's `edit` and `write` tools.
- `observationPack`: registers `obs_recall` and a provider-context projection handler.
- `observationPackThresholdsKiB`: sets the optional default and per-tool minimum result sizes in KiB.
- `evidencePreservingReducer`: registers a `tool_result` handler and delegates long diagnostic-log reduction to the configured reducer provider/model.
- `evidencePreservingReducerProvider`: provider namespace used to resolve the reducer model through Pi's model registry.
- `evidencePreservingReducerModel`: model id used for Evidence-Preserving Reducer.
- `onlineContextCompact`: registers `update_plan` and boundary-driven native compaction after the other SoL-Pi context transformers.
- `cacheWriteReadRatio`: supplies the single economic decision ratio used by Online Context Compact.

## ObservationPack thresholds

Use one optional map to override thresholds. For example, this configuration enables ObservationPack, uses 4 KiB for `bash`, and keeps the built-in 10 KiB fallback for every other tool:

```json
{
  "version": 1,
  "observationPack": true,
  "observationPackThresholdsKiB": {
    "bash": 4
  }
}
```

Add `"default": 8` inside the map to change the fallback to 8 KiB. Tool-specific entries take precedence over that fallback. Omission of the map, an empty map, or omission of `default` keeps the 10 KiB fallback. The map alone does not enable ObservationPack.

- Values must be positive integer KiB counts, not strings such as `"4KiB"`. One KiB is 1,024 bytes. Zero, fractions, non-finite numbers, and values whose byte count exceeds JavaScript's safe integer range are rejected.
- Tool names match exactly and are case-sensitive; wildcards are not expanded. Keys must be non-empty and contain no whitespace. `default` is reserved for the fallback.
- Eligibility uses the UTF-8 byte count of text blocks joined with newlines. Only results **strictly larger** than the selected threshold qualify.
- The tool name belongs to the result, not to commands inside it. Action Fusion results use `write` or `edit`, not `bash`.
- Errors, mixed text/image results, and reducer receipts remain excluded. The first two requests still receive the full output. Archive, placeholder, and recall behavior are unchanged.
- Small thresholds can produce a placeholder larger than the original result, increase recall work, and cause more cached-prefix changes. A lower threshold does not guarantee lower cost.

The project file still replaces the entire global file, including this map. A project map with only `bash: 4` uses the built-in fallback of 10 KiB, even if the global file sets a different `default`. Include `observationPack: true` in the selected file to enable the feature.

The programmatic factory accepts the same map: `createObservationPackExtension({ bash: 4 })`. Thresholds are validated and snapshotted when the extension is created; changing the original map does not affect a running instance.

## Evidence-Preserving Reducer runtime inputs

The release entry supplies the run label and session-derived storage. It uses one configurable model route:

- **Reducer provider/model** — from `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` in the effective `sol-pi.json`. If omitted, SoL-Pi uses its built-in reducer route. SoL-Pi resolves that model through Pi's model registry and still relies on Pi-managed authentication; do not put credentials in `sol-pi.json`.

## Online Context Compact runtime inputs

The release entry uses two runtime inputs:

- **Context window** — from `ExtensionContext.getContextUsage()`, used for window-pressure protection.
- **Cache write/read ratio** — from `cacheWriteReadRatio` in the effective `sol-pi.json`. The value remains fixed for the session and is not recomputed when the model changes. It drives one runtime decision and is not a cost report.

The configured ratio stays fixed for the loaded extension. The mechanism stores its current plan, progress summaries, request horizon, context growth, and compaction debt as versioned custom entries in Pi's session log. After a successful compaction it sends one hidden, generic message with `triggerTurn: true`, which starts a new turn and asks the assistant to continue the current plan, preserving existing step IDs when updating progress. A settlement barrier keeps print and JSON modes in the same Pi invocation until that continuation settles, so callers do not need to resume the session or inject `Continue working`. Cancelling or exiting does not schedule an automatic continuation. The mechanism creates no separate Online Context Compact files. The programmatic factory exposes only a matching retained-tail value for installations whose Pi compaction setting differs from the default.

## Pi integration

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer resolves its configured reducer provider/model through `ExtensionContext.modelRegistry` and uses Pi-managed authentication. If the configured reducer model is unavailable or the nested model call fails, the original tool result continues unchanged.

SoL-Pi does not configure shell paths, command prefixes, storage paths, run IDs, provider URLs, reasoning levels, timeouts, or per-mechanism enable flags through environment variables. Apart from the EPR reducer provider/model route in `sol-pi.json`, model selection remains with Pi. Action Fusion uses Pi's default shell behavior. Persistent artifacts are derived from Pi's session directory and session ID.

## Trust

A project-local config can enable file mutation, shell execution, local archival, and remote diagnostic-log reduction. SoL-Pi waits for Pi's `session_start` context and ignores the project file unless `ctx.isProjectTrusted()` is true. Prefer the global file when you want one personal configuration across trusted projects.
