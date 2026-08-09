import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/schema.ts',
  outDir: 'src/gen',
  generators: [{ kind: 'zod', path: 'src/gen/zod' }],
});
