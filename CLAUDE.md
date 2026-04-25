# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Google Apps Script (GAS) LINE bot for splitting bills on group trips (旅行用割り勘Bot). Deployed as a GAS web app — `doPost` handles LINE Messaging API webhooks. Persistent state lives in a single Google Sheet. Designed so groups can use it just by inviting the bot — no per-user setup.

## Commands

This project uses [`clasp`](https://github.com/google/clasp) to sync with the GAS project (`scriptId` in `.clasp.json`).

- `clasp push` — upload local `.js` / `.json` to GAS
- `clasp pull` — download GAS source
- `clasp open` — open the script in the GAS editor
- `clasp deploy --deploymentId <ID> --description "..."` — update an existing deployment in place (Webhook URL stays the same)
- `clasp deploy --description "..."` — create a new versioned deployment

No build / lint / unit-test tooling. Runtime is GAS V8 (`appsscript.json`). Tests are run from the GAS editor — see "Testing" below.

## Required Script Properties

`getConfig()` reads these from GAS Script Properties (Project Settings → Script Properties). The bot throws if either is missing:

- `CHANNEL_ACCESS_TOKEN` — LINE Messaging API channel access token
- `SPREADSHEET_ID` — target spreadsheet ID
- `SHEET_NAME` — optional, defaults to `シート1`

OAuth scopes are declared in `appsscript.json` (`spreadsheets`, `script.external_request`).

## Architecture

Two source files:
- `コード.js` — production code (entry: `doPost`). Filename is Japanese; preserve it (matches the GAS server file).
- `test.js` — test harness (functions prefixed `__test_`).

### Three-layer dispatch

`doPost(e)` is a thin I/O wrapper. The actual logic is in `handleEvent(event, config)`, a **pure function** returning `{ shouldReply, replyText, flexMessage?, quickReplyLabels }`. `sendReply(replyToken, result)` performs the LINE API call. This split exists so `handleEvent` can be exercised by tests without hitting LINE.

### Event types handled

- `message.text` — main command dispatch (see below)
- `join` — when bot is added to a group: replies with welcome + menu (so the bot self-introduces)
- Anything else — ignored

### Command dispatch (in `handleEvent`)

All command words use **exact match (`===`)** to avoid false positives in casual conversation (e.g., "精算しよう" does NOT trigger). The exceptions, which need prefix matching, are `@` / `＠` (and `#` / `＃` as alias) for the record syntax.

The `精算` / `清算` branch additionally accepts `精算\n…` (multi-line manual settlement). Single-token `精算` triggers the auto-fill flow.

LINE mentions: a message that mentions the bot itself (`mentionees[*].isSelf === true`) returns the menu. Mentions of other members are ignored, preserving normal LINE group behavior — the bot does not hijack the mention feature.

### Record syntax (`@` is canonical)

```
@（払った人）
（金額）
（内容）          ← optional
（対象者A）       ← only when limiting the split
（対象者B）...
```

- 2–3 lines → split among all participants at settlement time
- 4+ lines → only line 4+ are charged (limited split, written to column H)
- `#` / `＃` are accepted as aliases of `@` for backward compatibility but no longer documented in the help.

### Settlement (`computeSettlement` → `formatSettlementText` / `buildSettlementFlex`)

`computeSettlement(sourceId, receivedText)` parses participants, scans the sheet, computes balances, **flips matching rows to `精算済`**, and returns either `{ ok: true, data }` or `{ ok: false, error }`. The data structure is intentionally serializable so two formatters (text fallback + Flex Message) can share the same input.

Algorithm:
- Parallel maps `payments[name]` (paid) and `burdens[name]` (owed) over the participant list.
- For each `記録済` row: if column H is set, split among `participantList ∩ limitedMembers`; otherwise split equally among all participants. `floor + remainder` distribution reconciles to the yen.
- Balance = paid − burden; greedy two-pointer match between creditors and debtors yields the minimum-transaction payout list.
- The "1人あたり" summary is only shown when every contributing row was an `@` (non-limited) record (`isUniform === true`).

`精算` single-token flow: returns the unique payers from history with Quick Reply `[このメンバーで精算] [メンバーを追加して精算]`. The first button re-fetches and runs `computeSettlement`. The second returns the manual `精算\n…` format guide for adding 0-yen participants.

### History (`getHistoryData` → `formatHistoryText` / `buildHistoryFlex`)

Same compute/format/flex split. `getHistoryData(sourceId, { status })` filters by `記録済` (default — current history) or `精算済` (the hidden `過去の履歴` command). Latest 10 records, with `omittedCount` reported when truncated. The two views differ visually by header color: green (`#06C755`) for current, grey (`#6c757d`) for past.

### Cancel (`getRecentRecords` + `cancelRecordByRow`)

Typing `取消` lists the most recent 5 `記録済` rows of the group with Quick Reply buttons `[取消1] … [取消N] [キャンセル]`. Tapping `取消N` re-fetches and flips the Nth most recent row to `取消済`. Anyone in the group can cancel any record (intentionally — trip context).

### Typo prevention (`normalizeName` + `findSimilarPayer`)

When `@payer` is recorded, the new name is compared (after normalization: full-width → half-width, katakana → hiragana, trim) against existing payers. If a normalized match exists with a different raw form, a soft warning ("もしかして〇〇？") is appended to the success reply. Edit-distance is intentionally NOT used — friend trips often use 2-character abbreviated names that would be false positives.

### Spreadsheet schema (column → meaning)

The sheet *is* the database. Rows are appended on record, never deleted; status transitions encode lifecycle.

| Col | Index | Field |
|-----|-------|-------|
| A | 0 | timestamp |
| B | 1 | sourceId (groupId or userId) |
| C | 2 | senderId (LINE userId of the sender) |
| D | 3 | payer name |
| E | 4 | amount (number) |
| F | 5 | content / memo |
| G | 6 | status: `記録済` / `精算済` / `取消済` |
| H | 7 | limited-target members, comma-separated (set only when 4+ lines were sent) |

Note: `リセット済` no longer occurs — the `リセット` command was removed (旅行 lifecycle = 精算 is the natural end).

### Quick Reply / Flex helpers

- `buildQuickReply(labels)` — builds a quickReply object from a label array; each label is sent as the message text when tapped.
- `sendReply(replyToken, result)` — chooses Flex (if `result.flexMessage`) or text (`result.replyText`), attaches Quick Reply, posts to LINE.
- `MENU_TEXT` / `MENU_LABELS` — the canonical hub menu shown by both `ヘルプ` and bot-mention replies. Hidden commands (e.g., `過去の履歴`) are intentionally not in `MENU_LABELS`.

## Testing

`test.js` provides:
- `__test_runAll()` — end-to-end smoke (cleanup → seed records → exercise queries → settle → cleanup). Logs to GAS execution log.
- `__test_handleEvent_dispatch()` — ~30 unit-ish tests over `handleEvent`. Reports pass/fail with `✅` / `❌` markers.

Run from the GAS editor (clasp push first). Tests use `TEST_SOURCE_ID = "TEST_GROUP_001"` so they don't pollute production data on the same sheet.

## Notes for editing

- After any edit, `clasp push` updates the HEAD; the LINE webhook is bound to a versioned deployment (current: `AKfycbxIV39…`). Run `clasp deploy --deploymentId <ID> --description "..."` to publish.
- `コード.js` is intentionally a single file; resist splitting unless there's a real need (GAS module loading is order-quirky).
- The HEAD deployment created automatically by GAS is *not* publicly accessible (returns 401 to anonymous POSTs). For an externally-callable URL use `clasp deploy` to make a versioned one.
