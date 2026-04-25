# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Google Apps Script (GAS) LINE bot for splitting bills (割り勘). Deployed as a GAS web app whose `doPost` handles LINE Messaging API webhooks. State is persisted in a single Google Sheet.

## Commands

This project uses [`clasp`](https://github.com/google/clasp) to sync with the GAS project (`scriptId` in `.clasp.json`).

- `clasp push` — upload local `.js` / `.json` to GAS
- `clasp pull` — download GAS source
- `clasp open` — open the script in the GAS editor
- `clasp deploy` — create a new web app deployment (after edits, the LINE Webhook URL must point at the latest deployment)

There is no build, lint, or test tooling — runtime is GAS V8 (`appsscript.json`).

## Required Script Properties

`getConfig()` reads these from GAS Script Properties (Project Settings → Script Properties). The bot throws if either is missing:

- `CHANNEL_ACCESS_TOKEN` — LINE Messaging API channel access token
- `SPREADSHEET_ID` — target spreadsheet ID
- `SHEET_NAME` — optional, defaults to `シート1`

OAuth scopes are declared in `appsscript.json` (`spreadsheets`, `script.external_request`).

## Architecture

All logic lives in `コード.js` (single file). Entry point is `doPost(e)`, which:

1. Parses the LINE webhook event, extracts `replyToken` and `sourceId` (`groupId || userId`).
2. Branches on the message text against a fixed command set (order matters — see below).
3. Each handler returns a reply string; `doPost` posts it back via the LINE reply API.
4. On error, a row tagged `ERROR` is appended to the sheet and a generic apology is replied.

### Command dispatch order (in `doPost`)

The `if/else if` chain is order-sensitive. In particular:

- `ヘルプ` / `使い方` is checked first.
- `＃` / `#` (limited split) **must** be checked before `@` / `＠` (normal payment) because `＃`-prefixed messages would otherwise fall through.
- Messages containing LINE `mention.mentionees` are explicitly ignored (`shouldReply = false`) so `@user` LINE mentions don't collide with the `@payer` command.
- Anything not matching a command is silently ignored.

### Spreadsheet schema (column → meaning)

Rows are appended by `@` and `＃` handlers; the sheet *is* the database.

| Col | Index | Field |
|-----|-------|-------|
| A | 0 | timestamp |
| B | 1 | sourceId (groupId or userId — scopes records per chat) |
| C | 2 | senderId (LINE userId of the sender — used by `取消`) |
| D | 3 | payer name |
| E | 4 | amount (number) |
| F | 5 | content / memo |
| G | 6 | status: `記録済` / `精算済` / `取消済` / `リセット済` |
| H | 7 | limited-target members, comma-separated (only for `＃`; empty for `@`) |

Status transitions are how the bot avoids deleting rows: `cancelLastRecord`, `resetAllRecords`, and `calculateSettlement` all *update G* rather than removing rows. Queries (`showHistory`, `showMembers`, settlement) filter on `sourceId` + `status === "記録済"`.

### Settlement algorithm (`calculateSettlement`)

Tracks two parallel maps over the participant list parsed from the user's `精算` message:

- `payments[name]` — total each person paid
- `burdens[name]` — total each person should owe

For each `記録済` row in the same `sourceId`:
- If H (limited members) is set, burden is split among `participantList ∩ limitedMembers` (the `＃` path; flips `onlyAtCommandsUsed = false`).
- If H is empty, burden is split equally among all `participantList` (the `@` path).
- Split uses `floor + remainder` distribution so totals reconcile to the yen.

Balance = `paid - burden`; positives are creditors, negatives are debtors. A two-pointer greedy walk produces the minimum-transaction payoff list. The `1人あたり` summary line is only shown when every contributing row was an `@` record (i.e., uniform split applies).

After computing, all consumed rows are flipped to `精算済`.

### Input normalization

`zenkakuToHankaku` converts full-width digits (`０-９`) before `parseInt`, so amounts typed on a Japanese IME work. Non-digit characters are then stripped from amount strings.

## Notes for editing

- This is a single-file GAS project — adding files means updating `clasp` push order and ensuring GAS picks them up. Prefer extending `コード.js`.
- The filename `コード.js` is in Japanese; preserve it (it matches the GAS file name on the server).
- After any edit, `clasp push` then redeploy the web app version that LINE's Webhook URL targets — old deployments keep serving stale code otherwise.
