import { publicUrlSchema } from './schemas.js';

export function resolvePublicOrigin(environment: NodeJS.ProcessEnv): string | undefined {
  const explicit = environment.PUBLIC_ORIGIN || undefined;
  const renderWeb = environment.RENDER === 'true' && environment.RENDER_SERVICE_TYPE === 'web';
  const value = explicit ?? (renderWeb ? environment.RENDER_EXTERNAL_URL || undefined : undefined);
  if (!value) return undefined;
  const parsed = new URL(publicUrlSchema.parse(value));
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Hosted origin must not contain a path or query.');
  if (!explicit && (!parsed.hostname.endsWith('.onrender.com') || parsed.port)) {
    throw new Error('Automatic Render origin must use its managed HTTPS hostname.');
  }
  return parsed.origin;
}
