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
  return c.json({ linked: !!tokens, expiresAt: tokens?.expiresAt ?? null });
});
