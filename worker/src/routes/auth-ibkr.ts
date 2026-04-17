import { Hono } from 'hono';
import type { AppVariables, Env } from '../env';
import { putIbkrTokens } from '../kv';

export const authIbkrRoute = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// IBKR Web API uses OAuth 1.0a. The full request-token / authorize / access-token
// dance is nontrivial and best implemented through @quentinadam/ibkr helpers.
// These routes are the integration surface; the flow below is a stub that
// records manually-provided tokens so the rest of the app can be exercised.

authIbkrRoute.get('/start', (c) => {
  // TODO(oauth): kick off the IBKR OAuth 1.0a flow via @quentinadam/ibkr and
  // redirect the user to IBKR. For now we return instructions.
  return c.json({
    todo: 'implement IBKR OAuth 1.0a via @quentinadam/ibkr',
    callback: c.env.IBKR_CALLBACK_URI,
  });
});

authIbkrRoute.get('/callback', async (c) => {
  // TODO(oauth): exchange the verifier for access token + secret.
  const accessToken = c.req.query('oauth_token');
  const accessTokenSecret = c.req.query('oauth_token_secret');
  const identity = c.get('identity');

  if (!accessToken || !accessTokenSecret) {
    return c.json({ error: 'missing oauth_token / oauth_token_secret' }, 400);
  }

  await putIbkrTokens(c.env, identity.sub, {
    accessToken,
    accessTokenSecret,
    updatedAt: Date.now(),
  });

  return c.redirect('/');
});
