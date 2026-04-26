import { Hono } from 'hono';
import type { AppVariables, Env } from './env';
import { accessAuth } from './middleware/access';
import { barsRoute } from './routes/bars';
import { authIbkrRoute } from './routes/auth-ibkr';
import { authSchwabRoute } from './routes/auth-schwab';
import { ordersRoute } from './routes/orders';
import { accountsRoute } from './routes/accounts';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use('/api/*', accessAuth);

app.get('/api/health', (c) => c.json({ ok: true, who: c.get('identity').email }));
app.route('/api/bars', barsRoute);
app.route('/api/auth/ibkr', authIbkrRoute);
app.route('/api/auth/schwab', authSchwabRoute);
app.route('/api/orders', ordersRoute);
app.route('/api/accounts', accountsRoute);

// Fallback to the SPA assets for any non-API route.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
