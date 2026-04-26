import { Hono } from 'hono';
import type { AppVariables, Env } from '../env';
import { fetchSchwabAccounts } from '../brokers/schwab';

export const accountsRoute = new Hono<{ Bindings: Env; Variables: AppVariables }>();

accountsRoute.get('/schwab', async (c) => {
  const identity = c.get('identity');
  try {
    const accounts = await fetchSchwabAccounts(c.env, identity.sub);
    return c.json({ accounts });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
