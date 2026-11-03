# Deployment

The site must run continuously (bots trade server-side for every user), and Deriv's OAuth needs a
public **HTTPS** address. Use a VPS: 1 vCPU / 2 GB RAM is fine for a few dozen users; each signed-in
user with running bots holds one Deriv WebSocket connection. Use PostgreSQL beyond ~20 active users.

Checklist: domain → DNS A record to the VPS → TLS proxy → `.env` (MASTER_KEY, DERIV_APP_ID,
BRAND_NAME, ADMIN_EMAILS) → register the redirect URL `https://your.domain/` on api.deriv.com.

## Docker (recommended)
```bash
git clone <your repo> deriv-ai-terminal && cd deriv-ai-terminal
cp .env.example .env && python3 -c "import secrets;print(secrets.token_urlsafe(48))"   # -> MASTER_KEY
docker compose up -d --build
docker compose logs -f terminal
```
The container binds to `127.0.0.1:8000`. For remote access put Caddy or Nginx with TLS in front,
e.g. Caddy: `trade.example.com { reverse_proxy 127.0.0.1:8000 }` (WebSockets work out of the box).
Never expose port 8000 directly to the internet.

## Without Docker (systemd)
```ini
# /etc/systemd/system/deriv-terminal.service
[Service]
WorkingDirectory=/opt/deriv-ai-terminal
EnvironmentFile=/opt/deriv-ai-terminal/.env
ExecStart=/opt/deriv-ai-terminal/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=always
User=trader
[Install]
WantedBy=multi-user.target
```
Build the dashboard once with `cd frontend && npm ci && npm run build`; the backend serves `frontend/dist`.
**Always one worker**: the process owns the Deriv connection and the order ledger.

## PostgreSQL
`docker compose --profile postgres up -d` and set
`DATABASE_URL=postgresql+psycopg://trader:change-me@db:5432/terminal`. Tables are created on start.
Back up with `pg_dump`.

## Backups
SQLite is backed up online every `BACKUP_INTERVAL_HOURS` to `data/backups/` (last 20 kept), and on
demand from the Admin page or `python -m backend.cli backup`. Copy `data/` off the server regularly.
Keep `MASTER_KEY` somewhere safe — without it stored tokens can't be decrypted (users would just log in again).

## Crash / outage recovery (automatic)
After a restart the platform reconnects every user who had bots enabled or open positions. On every (re)connect:
1. re-authorizes and restores all market and contract subscriptions,
2. reconciles PENDING/SENT/UNKNOWN orders against Deriv's portfolio and profit table
   (matched → recorded as BOUGHT; no match after 2 min → FAILED; **never re-sent**),
3. adopts open contracts it doesn't know as `external` (they count toward exposure),
4. polls every open trade until settled,
5. restarts bots that were enabled (unless that user's emergency stop is active).

Risk state (daily P/L, drawdown peak, streaks, suspension) lives in the database, so restarting
the process does not reset any limit.

## Updating
`git pull && docker compose up -d --build`. Bot versions, trades and settings are in `data/`.
