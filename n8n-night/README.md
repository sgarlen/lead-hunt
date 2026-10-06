# n8n-night

Nine n8n workflows that Claude Code built on an empty local n8n in 19 minutes.

The rule was: replace the tools people pay for, fix whatever breaks, no help from me.
Everything runs on a laptop with no API keys and no cloud plan.

## Workflows

| # | Workflow | What it does | Schedule | Stands in for |
|---|---|---|---|---|
| 01 | Uptime monitor | Pings 4 sites, appends status to `uptime.jsonl` | every 5 min | UptimeRobot |
| 02 | RSS digest | Reads 4 feeds, writes the last 48h to `digest.md` | daily, 08:00 | Feedly Pro |
| 03 | Mention tracker | Searches Hacker News for keywords, writes `mentions.md` | hourly | mention trackers |
| 04 | Page change monitor | Hashes 3 pages, logs which ones changed | every 6 h | Visualping |
| 05 | Price alerts | Pulls BTC, ETH, SOL from CoinGecko, flags 3%+ moves | every 15 min | TradingView alerts |
| 06 | Broken link checker | Extracts links from a page and checks each one | weekly | link checkers |
| 07 | Post queue | Moves due posts from `queue.json` to `outbox.jsonl` | every 10 min | Buffer |
| 08 | Lead webhook | `POST /webhook/lead`, validates email, appends to `leads.jsonl` | on request | Zapier |
| 09 | Morning report | Reads every output file, builds `report.html` | daily, 07:00 | - |

67 nodes in total. These are small versions of the paid tools, not full replacements:
the post queue does not publish to X (that needs an API key), and the mention tracker only covers Hacker News.

## Run it

Needs Node.js and n8n (`npm install -g n8n`). The scripts are PowerShell.

```powershell
node build.mjs                      # generate workflows/*.json with paths for your machine
Copy-Item queue.seed.json out/queue.json
./run.ps1                           # import and run every workflow once
./n8n.ps1 publish:workflow --id=night01uptime   # repeat for each workflow id
./n8n.ps1 start                     # http://localhost:5680
```

`n8n.ps1` keeps this instance isolated: its database lives in `.n8n/` in this folder and file access is limited to `out/`.
The JSON files in `workflows/` contain absolute paths from the original run, so run `node build.mjs` before importing.

On macOS or Linux set `N8N_USER_FOLDER`, `N8N_RESTRICT_FILE_ACCESS_TO` and `N8N_PORT` yourself and call `n8n` directly.

## Files

- `build.mjs` - compact workflow definitions, generates `workflows/*.json`
- `run.ps1` - imports workflows and executes each one once
- `n8n.ps1` - n8n CLI wrapper for the isolated instance
- `dashboard.html` - animated summary of the run
- `record.mjs` - renders the dashboard to mp4 (needs Chrome and ffmpeg)

## Notes from the real run

- n8n 2.11.2, 2026-10-06
- 7 of 9 workflows passed on the first run, 2 failed and were fixed
- Code nodes run in a sandbox: `URL` is not available there
- HTTP Request with a text response puts the body in `data`, not `body`
- `n8n execute` needs a Manual Trigger in the workflow to start from
