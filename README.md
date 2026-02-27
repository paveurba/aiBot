# aiBot

Telegram bot that forwards messages to `codex` or `claude` CLI and returns responses in chat.

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

## Environment Variables

Required:

- `TELEGRAM_BOT_TOKEN` - Telegram bot token.

Optional:

- `CODEX_WORKDIR` - working directory for CLI runs (default: current directory).
- `CODEX_BIN` - codex executable name/path (default: `codex`).
- `CLAUDE_BIN` - claude executable name/path (default: `claude`).
- `DEFAULT_MODEL` - default agent/model (for example `codex` or `claude`).
- `REQUEST_TIMEOUT_MS` - request timeout in milliseconds (default: `180000`).
- `REUSE_SESSIONS` - `1` to reuse CLI sessions, `0` to disable (default: `1`).
- `MULTI_AGENT_MODE` - `1` enables multi-worker orchestration, `0` single-agent mode (default: `1`).
- `MAX_WORKER_TASKS` - maximum worker count (default: `10`).
- `MIN_WORKER_TASKS` - minimum worker count when task is split (default: `2`).
- `TELEGRAM_ALLOWLIST` - comma-separated Telegram user IDs allowed to use the bot.
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

## Notes

- `.env` and `logs/` are ignored by git.
- Never commit real secrets.
