# Speech Dataset Review

**A human review workflow for speech-recognition datasets, built with Telegram, a web dashboard, and object storage.**

Reviewers listen to recordings, inspect or edit transcripts, and accept or reject samples. The system tracks review state in PostgreSQL and organizes accepted audio and metadata in an S3-compatible bucket.

[Original Uzbek notes](docs/README.uz.md) · [Configuration](src/config.ts) · [Storage workflow](src/services/s3.ts)

## Workflow

```text
S3 audio + transcript metadata
        ↓
PostgreSQL review queue
        ↓
Telegram reviewer / web review interface
        ↓
Accept, correct, or reject
        ↓
Organized dataset + review statistics
```

## Capabilities

- Telegram review and administrator commands, built with grammY.
- A web dashboard for reviewer management, review activity, and statistics.
- S3-compatible audio storage and signed audio URLs.
- PostgreSQL-backed users, review queues, and review logs.
- Optional Google Speech-to-Text integration.
- Configuration checks, session-based web access, and graceful shutdown handling.

## Stack

**TypeScript · Node.js · grammY · Express · PostgreSQL · AWS S3 SDK · EJS**

## Run locally

Use a current Node.js LTS release, a PostgreSQL database, a Telegram bot, and a test S3-compatible bucket.

```bash
git clone https://github.com/ZiyoVer/for-CV.git
cd for-CV
npm ci
cp .env.example .env
```

Configure `.env` using your own values:

| Configuration | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN`, `ADMIN_IDS` | Bot authentication and administrator IDs |
| `DATABASE_URL` | PostgreSQL connection |
| `WASABI_ACCESS_KEY`, `WASABI_SECRET_KEY` | S3-compatible storage credentials |
| `WASABI_BUCKET`, `WASABI_REGION`, `WASABI_ENDPOINT` | Storage location |
| `ADMIN_PASSWORD`, `SESSION_SECRET` | Web administrator access and sessions |
| `GOOGLE_SPEECH_API_KEY` | Optional speech-recognition integration |

```bash
npm run build
npm start
```

The web interface defaults to `http://localhost:3000`. Telegram commands include `/start`, `/menu`, `/admin`, and `/add_user ID NAME`.

## Data behavior

The storage adapter scans WAV files under `stt/` and looks for a matching JSON metadata file. Accepted samples are organized under `saralangan/YYYY/MM/DD/`.

**Use a test bucket first:** the current `copyToSorted` implementation can delete the source objects after copying them. The sync code also has a fixed start-date filter; review `SYNC_START_DATE` in [the storage adapter](src/services/s3.ts) before importing a different dataset.

## Project status

An application repository for speech-data operations. It requires configured external services and your own dataset; a standalone hosted demo is not supplied. The package currently has no automated test suite.

**Author:** [O'ktam Ziyodullayev](https://github.com/ZiyoVer)
