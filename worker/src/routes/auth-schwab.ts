import { Hono } from 'hono';
import type { AppVariables, Env } from '../env';
import { putSchwabTokens } from '../kv';

export const authSchwabRoute = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const AUTHORIZE_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';

authSchwabRoute.get('/start', (c) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: c.env.SCHWAB_CLIENT_ID,
    redirect_uri: c.env.SCHWAB_REDIRECT_URI,
  });
  return c.redirect(`${AUTHORIZE_URL}?${params.toString()}`);
});

authSchwabRoute.get('/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) return c.json({ error: 'missing code' }, 400);
  const identity = c.get('identity');

  const basic = btoa(`${c.env.SCHWAB_CLIENT_ID}:${c.env.SCHWAB_CLIENT_SECRET}`);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: c.env.SCHWAB_REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    return c.json({ error: 'schwab token exchange failed', detail: await res.text() }, 502);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  await putSchwabTokens(c.env, identity.sub, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    updatedAt: Date.now(),
  });

  return c.redirect('/');
});
