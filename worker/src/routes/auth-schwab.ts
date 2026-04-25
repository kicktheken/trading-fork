import { Hono } from 'hono';
import type { AppVariables, Env } from '../env';
import { schwabAuthFor } from '../brokers/schwab';
import { loadSchwabTokens } from '../kv';

export const authSchwabRoute = new Hono<{ Bindings: Env; Variables: AppVariables }>();

authSchwabRoute.get('/start', async (c) => {
  const identity = c.get('identity');
  const debug = c.req.query('debug') === '1';

  const missing: string[] = [];
  if (!c.env.SCHWAB_CLIENT_ID) missing.push('SCHWAB_CLIENT_ID');
  if (!c.env.SCHWAB_CLIENT_SECRET) missing.push('SCHWAB_CLIENT_SECRET');
  if (!c.env.SCHWAB_REDIRECT_URI) missing.push('SCHWAB_REDIRECT_URI');
  if (missing.length > 0) {
    return c.json({ error: 'missing schwab config', missing }, 500);
  }

  try {
    const auth = schwabAuthFor(c.env, identity.sub);
    const result = await auth.getAuthorizationUrl();
    if (debug) {
      return c.json({
        authUrl: result.authUrl,
        generatedState: result.generatedState ?? null,
        redirectUri: c.env.SCHWAB_REDIRECT_URI,
        clientIdPresent: !!c.env.SCHWAB_CLIENT_ID,
        clientIdTail: c.env.SCHWAB_CLIENT_ID?.slice(-6) ?? null,
      });
    }
    if (!result.authUrl || !/^https?:\/\//.test(result.authUrl)) {
      return c.json({ error: 'invalid authUrl from SDK', authUrl: result.authUrl }, 500);
    }
    return c.redirect(result.authUrl);
  } catch (e) {
    return c.json({ error: 'getAuthorizationUrl failed', detail: String(e) }, 500);
  }
});

authSchwabRoute.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code) return c.json({ error: 'missing code' }, 400);
  const identity = c.get('identity');

  const auth = schwabAuthFor(c.env, identity.sub);
  try {
    // The SDK encodes the PKCE code_verifier inside `state` during
    // getAuthorizationUrl; it must be passed back here so exchangeCode can
    // recover it (each request gets a fresh auth instance with no memory).
    await auth.exchangeCode(code, state);
  } catch (e) {
    return c.json({ error: 'schwab token exchange failed', detail: String(e) }, 502);
  }
  return c.redirect('/');
});

authSchwabRoute.get('/status', async (c) => {
  const identity = c.get('identity');
  const tokens = await loadSchwabTokens(c.env, identity.sub);
  if (!tokens) return c.json({ linked: false, expiresAt: null, refreshExpired: null });
  // Schwab refresh tokens are hard-capped at 7 days. Without an explicit field
  // we approximate freshness by treating tokens older than 7 days as expired.
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const accessExpired = !tokens.expiresAt || tokens.expiresAt < Date.now();
  // If we know the issuance time (expiresAt - 1800s window for ~30min access token),
  // we can guess refresh-token age. Simpler heuristic: if accessExpired AND
  // tokens.expiresAt < now - 7d, refresh has likely also expired.
  const refreshLikelyExpired = !!tokens.expiresAt && tokens.expiresAt < Date.now() - SEVEN_DAYS_MS;
  return c.json({
    linked: !refreshLikelyExpired,
    expiresAt: tokens.expiresAt ?? null,
    accessExpired,
    refreshLikelyExpired,
  });
});
