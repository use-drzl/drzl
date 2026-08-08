import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The example is built in CI, where a failed typecheck has to fail the build rather than be
  // reported and ignored. This is Next's default; it is written down because the usual reason an
  // example builds green is that somebody turned it off.
  //
  // There is no `eslint` key here on purpose: Next 16 removed it, and warns that the config is no
  // longer supported. The example is linted by the repository's own `pnpm lint`.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
