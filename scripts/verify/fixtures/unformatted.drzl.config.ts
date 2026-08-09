export default {
  schema: './src/db/schema.ts',
  outDir: './src/unformatted/api',
  generators: [
    { kind: 'zod', path: './src/unformatted/zod' },
    { kind: 'service', path: './src/unformatted/services' },
    { kind: 'orpc' },
    { kind: 'trpc', path: './src/unformatted/trpc' },
  ],
};
