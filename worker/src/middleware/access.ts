import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '../env';

// Cache the JWKS across requests within a Worker isolate.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
  let set = jwksCache.get(url.toString());
  if (!set) {
    set = createRemoteJWKSet(url);
    jwksCache.set(url.toString(), set);
  }
  return set;
}

export const accessAuth: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (
  c,
  next,
) => {
  const env = c.env;

  if (env.ACCESS_DEV_BYPASS === '1') {
    c.set('identity', { email: 'dev@local', sub: 'dev' });
    return next();
  }

  const token =
    c.req.header('Cf-Access-Jwt-Assertion') ??
    c.req.header('cf-access-jwt-assertion') ??
    getCookie(c.req.raw, 'CF_Authorization');

  if (!token) {
    return c.json({ error: 'missing access token' }, 401);
  }

  try {
    const { payload } = await jwtVerify(token, jwks(env.ACCESS_TEAM_DOMAIN), {
      audience: env.ACCESS_AUD,
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    });
    const email = typeof payload.email === 'string' ? payload.email : '';
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!email || !sub) return c.json({ error: 'invalid access token' }, 401);
    c.set('identity', { email, sub });
    return next();
  } catch (e) {
    // Decode without verifying so we can surface the actual aud/iss in the response.
    let actualAud: unknown;
    let actualIss: unknown;
    try {
      const payloadB64 = token.split('.')[1] ?? '';
      const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
      const decoded = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
      actualAud = decoded.aud;
      actualIss = decoded.iss;
    } catch {
      // ignore
    }
    return c.json(
      {
        error: 'invalid access token',
        detail: String(e),
        expectedAud: env.ACCESS_AUD,
        expectedIss: `https://${env.ACCESS_TEAM_DOMAIN}`,
        actualAud,
        actualIss,
      },
      401,
    );
  }
};

function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}
