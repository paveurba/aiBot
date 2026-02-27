# aiBot

Telegram bot that forwards messages to `codex` or `claude` CLI and returns responses in chat.

## Node.js Libraries Used

- `node-telegram-bot-api` (`^0.67.0`) - Telegram Bot API client used to receive and send Telegram messages.
- `dotenv` (`^17.3.1`) - Loads environment variables from `.env` into `process.env`.

## Requirements

- Node.js 18+ (recommended)
- npm
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- At least one CLI available in `PATH`:
  - `codex` (default)
  - `claude` (optional)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/paveurba/aiBot.git
cd aiBot
```

2. Install dependencies:

```bash
npm install
```

3. Create `.env` file:

```bash
cp .env.example .env
```

4. Set required variables in `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
```

5. Start the bot:

```bash
node bot.js
```

## Make It Private (Your Telegram ID Only)

If you want this bot to reply only to you, set your Telegram user ID in `.env`.

Example:

```dotenv
TELEGRAM_ALLOWLIST=123456789
ALLOW_GROUPS=0
```

What this does:

- Only user `123456789` can use the bot.
- Group chats are blocked.
- Other users will get: `Not allowed.`

How to find your Telegram user ID:

- In Telegram, message `@userinfobot` and copy your numeric `Id`.
- Put that number into `TELEGRAM_ALLOWLIST`.

## Environment Variables

Required:

- `TELEGRAM_BOT_TOKEN` - Telegram bot token.

Optional:

- `BOT_WORKDIR` - working directory for CLI runs used by both `codex` and `claude` (default: current directory).
- `CODEX_BIN` - codex executable name/path (default: `codex`).
- `CLAUDE_BIN` - claude executable name/path (default: `claude`).
- `DEFAULT_MODEL` - default agent/model (for example `codex` or `claude`).
- `REQUEST_TIMEOUT_MS` - request timeout in milliseconds (default: `180000`).
- `REUSE_SESSIONS` - `1` to reuse CLI sessions, `0` to disable (default: `1`).
- `MULTI_AGENT_MODE` - `1` enables multi-worker orchestration, `0` single-agent mode (default: `0`).
- `MAX_WORKER_TASKS` - maximum worker count (default: `10`).
- `MIN_WORKER_TASKS` - minimum worker count when task is split (default: `2`).
- `TELEGRAM_ALLOWLIST` - comma-separated Telegram user IDs allowed to use the bot. If empty, anyone can use the bot.
- `ALLOW_GROUPS` - `1` to allow group chats, `0` private chats only (default: `0`).

## How It Works

- Bot receives a Telegram message.
- It routes work to selected agent (`codex` or `claude`).
- In multi-agent mode, it can split one request into several worker tasks and return each worker result.
- Chat-specific settings and session IDs are stored in:
  - `settings.json`
  - `sessions.json`

## Telegram Commands

- `/help` - show help
- `/reset` - clear chat settings and sessions
- `/agent` - show current agent
- `/agent codex` - switch to codex
- `/agent claude` - switch to claude
- `/agent default` - reset to default agent
- `/worker list` - list worker IDs
- `/worker <id> <message>` - run message on a specific worker

## Run as macOS LaunchAgent

Use helper scripts in `scripts/`:

```bash
./scripts/install-service.sh
./scripts/status-service.sh
./scripts/uninstall-service.sh
```

Logs are written to:

- `logs/bot.out.log`
- `logs/bot.err.log`

### macOS Service Status

Verified on February 27, 2026 with `./scripts/status-service.sh`:

- LaunchAgent plist exists: `~/Library/LaunchAgents/com.pavels.telegram.bot.plist`
- Service state: `running`
- Program: `/opt/homebrew/bin/node`
- PID was present (`24045` at check time)
- Log paths are configured:
  - `logs/bot.out.log`
  - `logs/bot.err.log`

This confirms the macOS service is created and currently running.

## Notes

- `.env` and `logs/` are ignored by git.
- Never commit real secrets.
