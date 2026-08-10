export default {
  title: 'DRZL',
  description: 'Developer tooling for Drizzle ORM',
  base: '/drzl/',
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icon-192.png' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '512x512', href: '/icon-512.png' }],
    ['meta', { property: 'og:image', content: '/social-card.png' }],
  ],
  themeConfig: {
    logo: { light: '/brand/logo.png', dark: '/brand/logo-dark.png' },
    docFooter: {
      prev: '← Previous',
      next: 'Next →',
    },
    outline: {
      level: [2, 3],
      label: 'On this page',
    },
    // MiniSearch, built into VitePress, indexing at build time and running in the browser. No
    // service, no account, no API key, and nothing to keep in sync with the deployed site: the
    // index ships with the site that produced it.
    search: {
      provider: 'local',
    },
    // The header carries product destinations. Roadmap, Sponsor and Request Template are project
    // meta rather than documentation, so they move into one Project menu: before this, a reader on
    // any page saw three links out of the product and none into it.
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '^/(guide|quickstarts)/' },
      { text: 'CLI', link: '/cli', activeMatch: '^/cli' },
      {
        text: 'Generators',
        activeMatch: '^/(generators|adapters|templates)/',
        items: [
          { text: 'Validators and schemas', link: '/generators/zod' },
          { text: 'APIs and routers', link: '/generators/orpc' },
          { text: 'Data access', link: '/generators/service' },
        ],
      },
      { text: 'Recipes', link: '/examples/recipes', activeMatch: '^/examples/' },
      {
        text: 'Project',
        items: [
          { text: 'Roadmap', link: '/roadmap/premium-templates' },
          { text: 'Sponsor', link: '/sponsor' },
          {
            text: 'Contributing',
            link: 'https://github.com/use-drzl/drzl/blob/master/CONTRIBUTING.md',
            target: '_blank',
            rel: 'noreferrer',
          },
          {
            text: 'Request a template',
            link: 'https://x.com/omardulaimidev',
            target: '_blank',
            rel: 'noreferrer',
          },
        ],
      },
    ],
    // Grouped by what a reader is trying to do, not by the directory a page happens to live in and
    // not by the order the features were built. The previous shape was the latter: this file had 30
    // commits, 155 insertions and zero deletions, while the site went from 26 pages to 58, so every
    // page ever added was appended to whichever section already existed.
    //
    // Nothing moves on disk. All 56 routes are unchanged, so the three blocks the gate compares
    // literally, the hand-written hrefs in WorksWith.vue that the dead-link checker cannot see, and
    // every cross-link in the prose all keep working.
    //
    // Collapsed groups are safe: the bundled theme opens a group when the active page is inside it
    // (`(isActiveLink || hasActiveLink) && (collapsed = false)` in its sidebar composable), so a
    // reader never has to open a section to find where they already are.
    sidebar: [
      // Progressive: every group is collapsed, and VitePress opens the one holding the current
      // page. The sidebar is therefore the length of one section plus nine headers, whatever the
      // site grows to, and nothing has to be closed by hand.
      //
      // One level only. The previous shape nested four sub-groups inside Generators and expanded
      // them all, which put fifty-four links on screen at once and made the deepest thing on the
      // page a group inside a group. Those four are promoted here, and the one that held a single
      // page is a plain link, because a group of one is a heading pretending to be structure.
      {
        text: 'Getting started',
        collapsed: true,
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Supabase and Neon (Postgres)', link: '/quickstarts/supabase-neon' },
          { text: 'PlanetScale (MySQL)', link: '/quickstarts/planetscale' },
          { text: 'Cloudflare D1 (SQLite)', link: '/quickstarts/cloudflare-d1' },
        ],
      },
      {
        text: 'CLI',
        collapsed: true,
        items: [
          { text: 'Overview', link: '/cli' },
          { text: 'init', link: '/cli/init' },
          { text: 'generate', link: '/cli/generate' },
          { text: 'watch', link: '/cli/watch' },
          { text: 'analyze', link: '/cli/analyze' },
          { text: 'explain', link: '/cli/explain' },
          { text: 'doctor', link: '/cli/doctor' },
          { text: 'generate:orpc', link: '/cli/generate-orpc' },
          { text: 'generate:trpc', link: '/cli/generate-trpc' },
          { text: 'Output and exit codes', link: '/cli/output' },
        ],
      },
      {
        text: 'Validators and schemas',
        collapsed: true,
        items: [
          { text: 'Zod', link: '/generators/zod' },
          { text: 'Valibot', link: '/generators/valibot' },
          { text: 'ArkType', link: '/generators/arktype' },
          { text: 'TypeBox', link: '/generators/typebox' },
          { text: 'Effect Schema', link: '/generators/effect' },
          { text: 'JSON Schema', link: '/generators/json-schema' },
          { text: 'OpenAPI Document', link: '/generators/openapi' },
        ],
      },
      {
        text: 'APIs and routers',
        collapsed: true,
        items: [
          { text: 'oRPC', link: '/generators/orpc' },
          { text: 'tRPC', link: '/generators/trpc' },
          { text: 'Hono', link: '/generators/hono' },
          { text: 'Express', link: '/generators/express' },
          { text: 'Fastify', link: '/generators/fastify' },
          { text: 'NestJS', link: '/generators/nestjs' },
          { text: 'GraphQL', link: '/generators/graphql' },
        ],
      },
      { text: 'Service classes', link: '/generators/service' },
      {
        text: 'Across generators',
        collapsed: true,
        items: [
          { text: 'Nested Relations', link: '/generators/nested-relations' },
          { text: 'Branded Keys', link: '/generators/branded-keys' },
          { text: 'Constraint Data', link: '/generators/constraints' },
        ],
      },
      {
        text: 'Templates and adapters',
        collapsed: true,
        items: [
          { text: 'Adapters overview', link: '/adapters/overview' },
          { text: 'Standard template', link: '/templates/standard' },
          { text: 'oRPC + Service template', link: '/templates/orpc-service' },
          { text: 'Custom templates', link: '/templates/custom' },
          { text: 'Router adapter hooks', link: '/adapters/router' },
        ],
      },
      {
        text: 'Recipes and integrations',
        collapsed: true,
        items: [
          { text: 'Recipes', link: '/examples/recipes' },
          { text: 'Relations', link: '/examples/relations' },
          { text: 'Validation mix', link: '/examples/validation-mix' },
          { text: 'Seeding and bulk inserts', link: '/examples/seed' },
          { text: 'Next.js server actions', link: '/examples/nextjs-server-actions' },
          { text: 'React Hook Form', link: '/examples/react-hook-form' },
          { text: 'TanStack Form', link: '/examples/tanstack-form' },
        ],
      },
      {
        text: 'Reference',
        collapsed: true,
        items: [
          { text: 'Troubleshooting', link: '/guide/troubleshooting' },
          { text: 'Upgrade notes', link: '/guide/upgrading' },
          { text: 'drizzle-orm 0.4x and v1', link: '/guide/drizzle-majors' },
          { text: 'Bun and Deno', link: '/guide/runtimes' },
          { text: 'Analyzer package', link: '/packages/analyzer' },
          { text: 'Validation Core package', link: '/packages/validation-core' },
        ],
      },
      {
        text: 'How DRZL is verified',
        collapsed: true,
        items: [
          { text: 'How it is verified', link: '/guide/verification' },
          { text: 'Compared with the first-party validators', link: '/guide/comparison' },
          { text: 'Benchmarks', link: '/guide/benchmarks' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/use-drzl/drzl' },
      { icon: 'discord', link: 'https://github.com/use-drzl/drzl/discussions' },
    ],
    footer: {
      message: 'Need a custom template or integration? DM @omardulaimidev on X.',
      copyright: 'Copyright © 2025 Omar Dulaimi · DRZL is Apache-2.0',
    },
  },
};
