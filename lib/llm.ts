import Anthropic from '@anthropic-ai/sdk';
import { getVercelOidcToken } from '@vercel/oidc';

export type LLM = { client: Anthropic; model: string; via: 'anthropic' | 'gateway' };

/**
 * Picks how to reach Claude:
 *  1. ANTHROPIC_API_KEY  -> Anthropic directly
 *  2. AI_GATEWAY_API_KEY, or running on Vercel -> Vercel AI Gateway (OIDC token, no key to manage)
 */
export async function getLLM(opts: { timeout?: number; maxRetries?: number } = {}): Promise<LLM | null> {
  const { timeout = 55_000, maxRetries = 3 } = opts;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return {
      client: new Anthropic({ timeout, maxRetries }),
      model: process.env.TRANSLATION_MODEL || 'claude-sonnet-5-5',
      via: 'anthropic',
    };
  }
  const gatewayKey = process.env.AI_GATEWAY_API_KEY;
  if (gatewayKey || process.env.VERCEL) {
    try {
      const apiKey = gatewayKey || (await getVercelOidcToken());
      return {
        client: new Anthropic({ apiKey, baseURL: 'https://ai-gateway.vercel.sh', timeout, maxRetries }),
        model: process.env.TRANSLATION_MODEL || 'anthropic/claude-sonnet-5',
        via: 'gateway',
      };
    } catch {
      return null;
    }
  }
  return null;
}
