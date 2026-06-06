# pi-telegram-tool-status

[![Tested with pi-telegram](https://img.shields.io/badge/Companion-pi--telegram-blue)](https://github.com/llblab/pi-telegram)

Companion extension for [`pi-telegram`](https://github.com/llblab/pi-telegram) by [@llblab](https://github.com/llblab). Displays compact Telegram progress messages for tools executed by the agent.

> ⚠️ **Requires `pi-telegram`** — this extension does nothing on its own. It was developed and tested specifically against `llblab/pi-telegram`. Forks may work but are not guaranteed.

## How it works

- **Hybrid live progress** — sends one compact Telegram message per tool for the first 10 tool calls.
- After 10 tools, switches to one overflow summary message that is edited in-place as more tools run.
- Ordinary agent replies are sent separately and never mixed with progress messages.
- After `agent_end`, progress messages stay in chat for review.
- If the agent answers without tools, **no message is sent at all**.
- Only activates for **Telegram-originated turns** — console work is not mirrored.

## Demo

```
🛠 1. 📖 read — …/telegram/tool-status.ts
🛠 2. 📖 read — …/telegram/status.ts
🛠 3. ✏️ edit — …/telegram/tool-status.ts
🛠 4. 💻 bash — docker compose exec backend python manage.py migra…

🛠 More tools used:

11. ✏️ edit — …/telegram/tool-status.ts
12. ⚙️ mcp — gitlab-platform-2/list_merge…
```

## Install

> Make sure `pi-telegram` is installed and connected first.

### From npm

```bash
pi install npm:pi-telegram-tool-status
```

### From git

```bash
pi install git:github.com/Timur00Kh/pi-telegram-tool-status
```

### Manual (global)

Copy `index.ts` to `~/.pi/agent/extensions/pi-telegram-tool-status.ts`.

## Requirements

- **Required:** [`pi-telegram`](https://github.com/llblab/pi-telegram) `>=0.12.0` must be installed, configured (`/telegram-setup`), and connected (`/telegram-connect`).
  - This extension was developed and tested with `llblab/pi-telegram`. Compatibility with forks is not guaranteed.
- The extension activates **only** when:
  1. The current pi session owns the Telegram lock (`locks.json`).
  2. The current turn originated from Telegram (prompt prefixed with `[telegram]`).

## Features

| Feature | Description |
|---------|-------------|
| **Lazy creation** | Progress appears only when the first tool is actually called. No empty messages for text-only replies. |
| **Telegram-only** | Does nothing for local console prompts. Only mirrors tool usage for Telegram-originated turns. |
| **Hybrid visibility** | First 10 tools are sent as individual messages for obvious live progress; later tools share one edited overflow summary to avoid spam. |
| **Emoji icons** | 📖 read, 📝 write, ✏️ edit, 💻 bash, ⚙️ everything else. |
| **Smart truncation** | Paths truncated from the start (filename preserved), bash from the end (command start preserved), others minimal 50 chars. |
| **Bash path compression** | Long file paths inside bash commands are middle-truncated to keep both root and filename visible. |
| **Secret masking** | `Authorization`, `Bearer`, `token=`, env vars with `TOKEN`/`KEY`/`SECRET` are hidden. |
| **Hidden overflow** | After the first 10 individual tool messages, the overflow summary shows the last 15 overflow tools + `… N more actions hidden`. |
| **Auto-deactivation** | Extension does nothing if Telegram is not connected, the lock belongs to another process, or the turn is local. |

## Known Issues / Notes

- **Settings menu appears after first message** — The `🛠 Tool Status` row in the Telegram Settings submenu (`/start` → ⚙️ Settings) registers lazily on the first agent turn. If you just installed or reloaded the extension, send any message to the bot (or run any console command) and then open Settings — the row will be there.

## License

MIT
