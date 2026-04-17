export interface Env {
  // bindings
  ASSETS: Fetcher;
  SECRETS_KV: KVNamespace;

  // vars (wrangler.toml [vars])
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALPACA_DATA_BASE: string;
  SCHWAB_REDIRECT_URI: string;
  IBKR_CALLBACK_URI: string;

  // secrets (wrangler secret put / .dev.vars)
  ALPACA_KEY_ID: string;
  ALPACA_SECRET: string;
  IBKR_CONSUMER_KEY: string;
  IBKR_CONSUMER_SECRET: string;
  SCHWAB_CLIENT_ID: string;
  SCHWAB_CLIENT_SECRET: string;

  // local-only: set in .dev.vars to skip Access JWT verification
  ACCESS_DEV_BYPASS?: string;
}

export interface AccessIdentity {
  email: string;
  sub: string;
}

export type AppVariables = {
  identity: AccessIdentity;
};
