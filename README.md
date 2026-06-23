# LUERevival

LueRevival is a modern, Docker-ready revival of **[acjordan2/AlpacaBoards](https://github.com/acjordan2/AlpacaBoards)**. The goal is not to make a generic modern forum. The goal is to preserve the nostalgic gray/blue, small-font, table-heavy board feel while replacing the outdated PHP 5/MySQL/Sphinx backend with a maintainable Node/Postgres stack.

## Source material callout

This repo intentionally calls back to the original project:

- Upstream repo: <https://github.com/acjordan2/AlpacaBoards>
- Upstream commit inspected locally: `7d2cfe1`
- Original requirements included PHP 5.3.7+, MySQL, Sphinx Search, php5-mcrypt, and a mail server.
- Original schema concepts preserved: `Users`, `Topics`, `Messages`, `Links`, `InviteTree`, `Inventory`, `ShopItems`, `StaffPermissions`, `DisciplineHistory`, `TopicalTags`, `UploadedImages`, and `ImageMap`.
- Original visual base preserved: `www/templates/default/css/nblue.css` is copied into `src/public/css/nblue.css` and lightly extended.
- Upstream reference files are bundled under `docs/UPSTREAM_*`.

## Modern backend

- Node.js 22 + Express + EJS
- Postgres 16 with full-text search indexes, replacing MySQL + Sphinx
- bcrypt password hashing
- Postgres-backed server-side sessions
- CSRF protection on forms with a session-bound token
- Helmet security headers
- Rate limiting
- Docker Compose deployment
- GitHub Actions CI

## Features

Core AlpacaBoards parity targets included in this revision:

- Users: register/login/logout, profile, status, karma, good/bad tokens, old-school user information pages
- User control: suspend/ban/pending/active, staff position, access level, discipline history
- Boards: list, create/update from admin, topic lists
- Topics: create, reply, lock/unlock, pin, soft-delete, read history
- Messages: revisions, edit, soft-delete
- Tags: public/private/moderator-ish tags, topic/link tagging, full reference-style tag editor with access/participation/restrictions/interactions/moderator/admin fields
- Links: submit, comment, vote, favorite, report
- Invites: shop item -> inventory -> invite code -> invite-only registration
- Shop/inventory: Invite and Pin Topic item model preserved
- Images: upload registry and gallery, plus schema for image maps
- Search: Postgres full-text topic/link search
- Admin: site options, boards, tags, users, audit log, report resolution
- Source page: `/source` documents how AlpacaBoards maps to LueRevival
- Pre-login TF4-style landing page and post-login EOTI-style front page based on supplied visual references

## Quick start with Docker

```bash
git clone https://github.com/Nrglobal/LueRevival.git
cd LueRevival
cp .env.example .env
```

Edit `.env` before starting. Minimum required changes:

```env
POSTGRES_PASSWORD=<long random database password>
SESSION_SECRET=<openssl rand -base64 48>
ADMIN_PASSWORD=<long first-admin password>
BASE_URL=https://your.domain.example
COOKIE_SECURE=true
```

Then run:

```bash
docker compose up --build -d
docker compose logs -f app
```

Open:

```text
http://localhost:3000
```

First admin login is seeded from:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<your ADMIN_PASSWORD>
```

The seed admin is only created when the users table is empty.

## Local development without Docker

Requires Node 22 and a reachable Postgres database.

```bash
npm install
cp .env.example .env
# edit POSTGRES_HOST/POSTGRES_PASSWORD/etc for your local Postgres
npm run migrate
npm run dev
```

Verification:

```bash
npm run verify
```

## Production deploy notes

1. Use strong secrets in `.env`.
2. Keep `COOKIE_SECURE=true` behind HTTPS.
3. Put the app behind Caddy/Nginx/Traefik for TLS.
4. Back up the `postgres_data` Docker volume and `./uploads` directory.
5. Do not expose Postgres publicly.
6. Run `docker compose pull && docker compose up -d --build` for updates.

### Caddy integration

If deploying on a VPS with the existing containerized Caddy stack, use the optional override:

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy-example.yml up -d --build
```

Then add a Caddyfile block like:

```caddyfile
lue.[YOURSITEHERE].com {
  reverse_proxy luerevival-app:3000
}
```

Important: because Caddy is containerized, do **not** reverse proxy to `127.0.0.1:3000` from inside Caddy unless the app is in the same container. Use the service/container name over the shared Docker network.

## License

MIT for this modernization. The bundled upstream reference material keeps the original AlpacaBoards copyright/license notices.
