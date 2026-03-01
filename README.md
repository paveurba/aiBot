# aiBot

Telegram bot that routes chat requests to `codex` or `claude` CLI.

## Features

- Task dispatcher routing:
  - task-like requests are assigned to one free worker (`worker-2..worker-10`)
  - one worker per request (no multi-worker split per request)
  - if all workers are busy, requests are queued and dispatched automatically
- Agent switching per chat: `/agent codex` or `/agent claude`.
- Manager mode:
  - `/manager` runs as an independent manager conversation
  - diagnostics are global by default (workers, locks, queue, runtime)
- Attachments:
  - photo/document passed to agent as local file path
  - voice/audio transcription via OpenAI STT or local script/Whisper
- Optional Redis + BullMQ worker mode.
- Local-file or Redis-backed session/state storage.

## Dependencies

Declared in `package.json`:

- `node-telegram-bot-api`
- `dotenv`
- `bullmq`
- `ioredis`

## Requirements

- Node.js 18+
- npm
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- At least one CLI in `PATH`:
  - `codex` (default)
  - `claude` (optional)

## Install

```bash
git clone https://github.com/paveurba/aiBot.git
cd aiBot
npm install
cp .env.example .env
```

Set at minimum:

```dotenv
TELEGRAM_BOT_TOKEN=your_token
```

Start:

```bash
npm run start
```

## Commands

- `/help`
- `/reset`
- `/agent`
- `/agent codex`
- `/agent claude`
- `/agent default`
- `/voice status|on|off`
- `/voice <prompt>`
- `/manager [question]`

Note: `/model ...` is intentionally disabled and points users to `/agent`.

## Architecture

- `bot.js`: thin bootstrap (loads env + config and starts app).
- `lib/telegram_bot_app.js`: app lifecycle, Telegram polling, auth/filtering, queueing by chat lane.
- `lib/command_service.js`: command handling + single-worker task dispatch routing.
- `lib/attachment_service.js`: photo/document/voice/audio handling + transcription pipeline.
- `lib/runtime_orchestrator.js`: queue orchestration, single-worker dispatcher, worker locks, queue fallback.
- `agent_runner.js`: codex/claude process execution abstraction.

## Worker Mode (Redis/BullMQ)

If queue mode is enabled, keep workers running:

```bash
npm run start:worker:agent
npm run start:worker:stt
npm run start:worker:notify
```

Or helper scripts:

```bash
./scripts/start-agent-worker.sh
./scripts/start-stt-worker.sh
./scripts/start-notify-worker.sh
./scripts/start-all-workers.sh
```

Voice/TTS helpers:

```bash
# build Telegram-compatible OGG/Opus voice file from text
./scripts/tts_to_telegram_voice.sh --text "hello world" --output /tmp/voice.ogg --lang en

# synthesize and send to Telegram chat (chat id defaults to TELEGRAM_ALLOWLIST first entry)
./scripts/send_voice.sh "hello world" [chat_id] [lang]
```

Voice delivery monitoring:

- Voice send retries and outcomes are written as JSON lines to `VOICE_SEND_LOG_FILE` (default: `logs/voice-send.log`).
- Retry behavior handles Telegram throttling/transient errors (`429`, `502`, `503`, `504`) with backoff.
- Voice format is validated before sending (`.ogg`/`.opus`, non-empty file, OGG container header).

## Key Environment Variables

- `TELEGRAM_BOT_TOKEN` required
- `BOT_WORKDIR`
- `CODEX_BIN`, `CLAUDE_BIN`
- `DEFAULT_MODEL`
- `REQUEST_TIMEOUT_MS`
- `REUSE_SESSIONS`
- `CODEX_BYPASS_SANDBOX`
- `TELEGRAM_ALLOWLIST`
- `ALLOW_GROUPS`

Queue/Redis:

- `REDIS_URL`
- `USE_BULLMQ`
- `REDIS_PREFIX`
- `AGENT_QUEUE_NAME`, `STT_QUEUE_NAME`, `NOTIFY_QUEUE_NAME`, `DEAD_LETTER_QUEUE_NAME`
- `AGENT_WORKER_CONCURRENCY`, `STT_WORKER_CONCURRENCY`, `NOTIFY_WORKER_CONCURRENCY`
- `AGENT_QUEUE_WAIT_FOR_RESULT_MS`, `STT_QUEUE_WAIT_FOR_RESULT_MS`
- `AGENT_ASYNC_ACK`
- `JOB_ATTEMPTS`, `JOB_BACKOFF_MS`
- `TELEGRAM_MIN_SEND_INTERVAL_MS` (default `200`)
- `TELEGRAM_SEND_MAX_ATTEMPTS` (default `4`)
- `TELEGRAM_SEND_RETRY_BASE_MS` (default `1200`)

Runtime safety:

- `BOT_SINGLETON_LOCK` (default `/tmp/aibot-telegram-polling.lock`) prevents multiple polling bot processes.

STT:

- `OPENAI_API_KEY`, `OPENAI_TRANSCRIBE_MODEL`
- `LOCAL_STT_SCRIPT`
- `WHISPER_BIN`, `WHISPER_MODEL`, `WHISPER_LANG`, `WHISPER_THREADS`

Voice delivery:

- `TTS_LANG`
- `TTS_VENV_DIR`
- `VOICE_SEND_MAX_ATTEMPTS`
- `VOICE_SEND_RETRY_BASE_MS`
- `VOICE_SEND_TIMEOUT_MS`
- `VOICE_SEND_LOG_FILE`

## Voice Setup Requirements

- `ffmpeg` must be installed and available in `PATH`.
- `python3` + `venv` support are required for TTS helper environment bootstrap.
- `gTTS` is auto-installed in `TTS_VENV_DIR` on first `send_voice.sh` / `tts_to_telegram_voice.sh` run.
- `TELEGRAM_BOT_TOKEN` and a valid chat id (`TELEGRAM_ALLOWLIST` or explicit `chat_id`) are required for delivery.

## Service Scripts

macOS LaunchAgent scripts:

```bash
./scripts/install-service.sh
./scripts/status-service.sh
./scripts/uninstall-service.sh
```

Raspberry/Linux systemd scripts:

```bash
./scripts/install-systemd.sh
./scripts/status-systemd.sh
./scripts/uninstall-systemd.sh
```

## Notes

- `.env` and `logs/` should not be committed.
- Rotate bot token if it was ever exposed.
