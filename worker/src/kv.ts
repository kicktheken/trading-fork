import type { Env } from './env';

export interface IbkrTokens {
  accessToken: string;
  accessTokenSecret: string;
  updatedAt: number;
}

export interface SchwabTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  updatedAt: number;
}

const key = (broker: 'ibkr' | 'schwab', userSub: string) => `tokens:${broker}:${userSub}`;

export async function getIbkrTokens(env: Env, userSub: string): Promise<IbkrTokens | null> {
  return env.SECRETS_KV.get<IbkrTokens>(key('ibkr', userSub), 'json');
}

export async function putIbkrTokens(env: Env, userSub: string, tokens: IbkrTokens): Promise<void> {
  await env.SECRETS_KV.put(key('ibkr', userSub), JSON.stringify(tokens));
}

export async function getSchwabTokens(env: Env, userSub: string): Promise<SchwabTokens | null> {
  return env.SECRETS_KV.get<SchwabTokens>(key('schwab', userSub), 'json');
}

export async function putSchwabTokens(env: Env, userSub: string, tokens: SchwabTokens): Promise<void> {
  await env.SECRETS_KV.put(key('schwab', userSub), JSON.stringify(tokens));
}
