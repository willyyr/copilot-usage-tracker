# 📊 Copilot CLI Usage Tracker

A [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli/) extension that tracks your token usage across all sessions, broken down by model. Perfect for enterprise users with unlimited plans who want visibility into their actual consumption.

## Why?

GitHub Copilot CLI shows token usage at the end of each session, but there's no built-in way to see your **total usage over time**. This extension silently records every session's usage data and gives you tools to query it whenever you want.

## What It Tracks

For every session, the extension captures:

- **Per-model token breakdown** — input, output, cache-read, and cache-write tokens
- **API call count** and **cost multiplier** (premium request weight)
- **Session metadata** — start/end time, working directory, models used
- **Code changes** — lines added/removed, files modified

## Installation

### Quick Install (copy the file)

```bash
# Clone this repo
git clone https://github.com/willyyr/copilot-usage-tracker.git

# Copy the extension to your Copilot CLI extensions directory
# macOS / Linux
mkdir -p ~/.copilot/extensions/usage-tracker
cp copilot-usage-tracker/extension.mjs ~/.copilot/extensions/usage-tracker/extension.mjs

# Windows
mkdir %USERPROFILE%\.copilot\extensions\usage-tracker 2>nul
copy copilot-usage-tracker\extension.mjs %USERPROFILE%\.copilot\extensions\usage-tracker\extension.mjs
```

### Verify

Start a new Copilot CLI session (or run `/clear`). You should see:

```
📊 Usage tracker active — use `usage_report` to see your token usage
```

## Usage

The extension provides 4 tools you can invoke by asking the agent naturally:

### `usage_report` — Aggregated Overview

> "Show my token usage"
> "How many tokens did I use this week?"
> "Show usage for today"

Returns a table like:

```
=== All-Time Usage ===

Metrics
Metric                   Value
-----------------------  ------------------------------------
Sessions                 42
API calls                1,337
Premium requests (cost)  892.0
Input tokens             12,450,000
Output tokens            3,200,000
Cache-read tokens        8,100,000
Cache-write tokens       1,050,000
Raw token cost estimate  $184.42
Pricing coverage         100.0% of requests (1,337 / 1,337)
Date range               Mar 1, 2026 -> Mar 27, 2026

By model
Model              Requests   Share  Premium Cost      Input     Output  Cache Read  Cache Write
-----------------  --------  ------  ------------  ---------  ---------  ----------  -----------
claude-haiku-4.5       500   37.4%          41.0    350,000    100,000     300,000       40,000
claude-sonnet-4.5       420   31.4%         420.0  5,100,000    900,000   3,500,000      380,000
gpt-5.3-codex          328   24.5%         164.0  2,800,000    400,000   1,200,000      180,000

Request share by model
claude-haiku-4.5   [###########-----------------]   37.4% (500)
claude-sonnet-4.5  [#########-------------------]   31.4% (420)
gpt-5.3-codex      [#######---------------------]   24.5% (328)

Raw token pricing estimate
Estimated total (cited models only): $184.42
Coverage: 100.0% of requests (1,337 / 1,337)
Model              Raw Est.  Coverage             Source
-----------------  --------  -------------------  ------------------------
claude-sonnet-4.5  $101.93   Exact cited pricing  Anthropic Claude pricing
gpt-5.3-codex      $65.10    Exact cited pricing  OpenAI API pricing
claude-haiku-4.5   $17.39    Exact cited pricing  Anthropic Claude pricing

Sources
[1] Anthropic Claude pricing - https://docs.anthropic.com/en/docs/about-claude/pricing
[2] OpenAI API pricing - https://developers.openai.com/api/docs/pricing
```

The report always includes:

- A metrics table for top-level totals
- A per-model table
- A request-share bar graph based on total requests
- A raw token-cost estimate using exact public pricing sources only

If a model does not have an exact public pricing source, the report shows `N/A` for that estimate and excludes it from the raw-cost total.

**Time range filters:** `today`, `yesterday`, `week`, `month`, `all`

### `usage_sessions` — Per-Session List

> "Show my recent sessions"
> "List sessions from this week"

```
═══ Recent Sessions (3) ═══

▸ Mar 27, 2026, 09:20 AM  [a1b2c3d4]
  Models: claude-opus-4.6, claude-haiku-4.5  |  Input: 450,000  Output: 85,000
  Dir: C:\Users\wireut\repos\my-project

▸ Mar 26, 2026, 03:45 PM  [e5f6g7h8]
  Models: claude-sonnet-4.5  |  Input: 120,000  Output: 32,000
  Dir: C:\Users\wireut\repos\other-project
```

### `usage_export` — CSV Export

> "Export my usage to CSV"
> "Export this month's usage to usage.csv"

Exports data with columns: `date, session_id, model, requests, cost, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens`

Great for importing into Excel, Google Sheets, or any analytics tool.

### `usage_clear` — Reset Data

> "Clear my usage data"

Wipes all stored data. Requires explicit confirmation.

## How It Works

The extension uses the [Copilot CLI Extension SDK](https://github.com/github/copilot-cli) to:

1. **Listen to `assistant.usage` events** — fired after each LLM API call with per-call token counts
2. **Listen to `session.shutdown` events** — provides authoritative per-model aggregated metrics when a session ends
3. **Persist to `~/.copilot/usage-tracker/usage.json`** — a simple JSON file that grows with each session

Data is stored locally on each machine. If you use Copilot CLI on multiple machines, each tracks independently.

## Data Storage

All data is stored in:

```
~/.copilot/usage-tracker/usage.json
```

This file is **not synced anywhere** — it stays on your local machine. You can back it up, move it between machines, or merge exports from multiple machines using the CSV export.

## Multi-Machine Setup

Since the extension is user-scoped (`~/.copilot/extensions/`), you need to install it on each machine:

1. Clone this repo on each machine
2. Copy `extension.mjs` to `~/.copilot/extensions/usage-tracker/`
3. Restart Copilot CLI or run `/clear`

Usage data is tracked per-machine. Use `usage_export` on each machine and combine the CSVs if you want a unified view.

## Requirements

- [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli/) v1.0.12 or later
- The extension uses only Node.js built-in modules (`fs`, `path`, `os`) — no dependencies needed

## License

MIT
