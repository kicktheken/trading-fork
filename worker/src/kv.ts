import type { TokenData } from '@sudowealth/schwab-api';
import type { Env } from './env';

// IBKR (OAuth 1.0a) — still a custom shape since we don't yet have an SDK wiring.
export interface IbkrTokens {
  accessToken: string;
  accessTokenSecret: string;
  updatedAt: number;
}

const schwabKey = (userSub: string) => `tokens:schwab:${userSub}`;
const ibkrKey = (userSub: string) => `tokens:ibkr:${userSub}`;

export async function loadSchwabTokens(env: Env, userSub: string): Promise<TokenData | null> {
  return env.SECRETS_KV.get<TokenData>(schwabKey(userSub), 'json');
}

export async function saveSchwabTokens(env: Env, userSub: string, tokens: TokenData): Promise<void> {
  await env.SECRETS_KV.put(schwabKey(userSub), JSON.stringify(tokens));
}

export async function getIbkrTokens(env: Env, userSub: string): Promise<IbkrTokens | null> {
  return env.SECRETS_KV.get<IbkrTokens>(ibkrKey(userSub), 'json');
}

export async function putIbkrTokens(env: Env, userSub: string, tokens: IbkrTokens): Promise<void> {
  await env.SECRETS_KV.put(ibkrKey(userSub), JSON.stringify(tokens));
}
