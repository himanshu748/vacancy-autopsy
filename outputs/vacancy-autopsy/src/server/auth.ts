import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const REVIEW_PERMISSION = 'review:reports';
export interface ReviewPrincipal { issuer: string; subjectHash: string; permission: typeof REVIEW_PERMISSION }
export interface AccessTokenVerifier { verify(authorization: string | undefined): Promise<ReviewPrincipal> }
export class ReviewAuthorizationError extends Error {
  constructor(readonly statusCode: 401 | 403 | 503, message: string) { super(message); }
}
export interface Auth0Config { issuer: string; audience: string }

/** Configured server-side issuer only. JWT headers cannot supply a key URL. */
export function createAuth0Verifier(config: Auth0Config, dependencies: { keyResolver?: JWTVerifyGetKey } = {}): AccessTokenVerifier {
  const issuer = new URL(config.issuer);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.port ||
      issuer.pathname !== '/' || issuer.search || issuer.hash || !issuer.hostname.includes('.') ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(issuer.hostname) || /^[\d.]+$/.test(issuer.hostname)) {
    throw new Error('AUTH0_ISSUER_BASE_URL must be a public HTTPS issuer origin with a trailing slash.');
  }
  if (config.issuer !== issuer.href || !config.audience.trim() || config.audience.length > 2048) {
    throw new Error('Configure an exact Auth0 issuer URL and API audience.');
  }
  const keys = dependencies.keyResolver ?? createRemoteJWKSet(new URL('.well-known/jwks.json', issuer), {
    timeoutDuration: 5000, cacheMaxAge: 600_000, cooldownDuration: 30_000,
  });
  return {
    async verify(authorization) {
      const match = authorization && authorization.length <= 16_000
        ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization) : null;
      if (!match) throw new ReviewAuthorizationError(401, 'A valid reviewer access token is required.');
      let payload;
      try {
        ({ payload } = await jwtVerify(match[1], keys, {
          issuer: issuer.href, audience: config.audience, algorithms: ['RS256'],
          requiredClaims: ['exp', 'iat', 'sub'], clockTolerance: 5, maxTokenAge: '24h',
        }));
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (error instanceof TypeError || ['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC'].includes(code)) {
          throw new ReviewAuthorizationError(503, 'Reviewer authentication is temporarily unavailable.');
        }
        throw new ReviewAuthorizationError(401, 'The reviewer access token is invalid or expired.');
      }
      // Auth0 machine identities must never stand in for the human review gate.
      if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 512 ||
          payload.sub.endsWith('@clients') || payload.gty === 'client-credentials') {
        throw new ReviewAuthorizationError(403, 'A human reviewer identity is required.');
      }
      if (!Array.isArray(payload.permissions) || !payload.permissions.every((value) => typeof value === 'string') ||
          !payload.permissions.includes(REVIEW_PERMISSION)) {
        throw new ReviewAuthorizationError(403, 'The reviewer does not have permission to approve evidence.');
      }
      return { issuer: issuer.href, permission: REVIEW_PERMISSION,
        subjectHash: createHash('sha256').update(`${issuer.href}\0${payload.sub}`).digest('hex') };
    },
  };
}
