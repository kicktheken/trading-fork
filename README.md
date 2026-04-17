# trading-fork

Mobile web app for executing trades against **Interactive Brokers** and **Schwab**, with **KlineCharts** wired to **Alpaca** daily bars. Backend is a single Cloudflare Worker that serves the SPA and exposes `/api/*`. Auth is **Cloudflare Access**.

## Layout

```
web/      React + Vite SPA (KlineCharts, mobile-first)
worker/   Cloudflare Worker (Hono) — serves API + static assets
```

## First-time setup

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in Alpaca + broker creds
```

Create the KV namespace and paste the id into `wrangler.toml`:

```bash
pnpm --filter worker exec wrangler kv namespace create SECRETS_KV
```

## Dev

Two terminals:

```bash
pnpm dev:web       # Vite at http://localhost:5173
pnpm dev:worker    # wrangler dev at http://localhost:8787
```

The Vite dev server proxies `/api/*` to the Worker. For a unified single-origin test, build the web app then run wrangler against the built assets:

```bash
pnpm build
pnpm dev:worker
```

## Deploy

```bash
pnpm deploy
```

## Cloudflare Access

Protect the Worker with a Self-Hosted Access app restricted to `@gmail.com` users (or a specific email). Copy the **Application Audience (AUD) Tag** into `wrangler.toml` as `ACCESS_AUD`, and your team domain into `ACCESS_TEAM_DOMAIN`. The Worker verifies `Cf-Access-Jwt-Assertion` against `${teamDomain}/cdn-cgi/access/certs`.

For local dev, leave `ACCESS_DEV_BYPASS=1` in `.dev.vars` to skip verification.

## Broker OAuth

- **IBKR** uses OAuth 1.0a via `@quentinadam/ibkr`. Flow starts at `GET /api/auth/ibkr/start`, callback at `/api/auth/ibkr/callback`. Tokens persist in `SECRETS_KV`.
- **Schwab** uses OAuth 2.0 via `@sudowealth/schwab-api`. Flow starts at `GET /api/auth/schwab/start`, callback at `/api/auth/schwab/callback`. Tokens persist in `SECRETS_KV`.

Live order placement is **not wired** in this scaffold — adapters expose `placeOrder` stubs that throw. See `worker/src/brokers/*.ts`.
