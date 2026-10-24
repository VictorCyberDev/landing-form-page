/**
 * Optional shared passcode. If ACCESS_CODE is set in the environment, the
 * translate endpoint (the only one that spends API credit) requires it.
 */
export function checkAccess(req: Request): string | null {
  const code = process.env.ACCESS_CODE;
  if (!code) return null;
  return req.headers.get('x-access-code') === code ? null : 'access-code-required';
}
