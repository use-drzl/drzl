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
    nav: [
      { text: 'Roadmap', link: '/roadmap/premium-templates' },
      { text: 'Sponsor', link: '/sponsor' },
      {
        text: 'Request Template',
        link: 'https://x.com/omardulaimidev',
        target: '_blank',
        rel: 'noreferrer',
      },
    ],
    sidebar: [
      {
        text: 'Guide',
        collapsed: false,
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Benchmarks', link: '/guide/benchmarks' },
        ],
      },
      {
        text: 'CLI',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/cli' },
          { text: 'Init', link: '/cli/init' },
          { text: 'Analyze', link: '/cli/analyze' },
          { text: 'Doctor', link: '/cli/doctor' },
          { text: 'Generate', link: '/cli/generate' },
          { text: 'Generate (oRPC)', link: '/cli/generate-orpc' },
          { text: 'Generate (tRPC)', link: '/cli/generate-trpc' },
          { text: 'Watch', link: '/cli/watch' },
        ],
      },
      {
        text: 'Generators',
        collapsed: false,
        items: [
          { text: 'oRPC', link: '/generators/orpc' },
          { text: 'tRPC', link: '/generators/trpc' },
          { text: 'Hono', link: '/generators/hono' },
          { text: 'Express', link: '/generators/express' },
          { text: 'Service', link: '/generators/service' },
          { text: 'Zod', link: '/generators/zod' },
          { text: 'Valibot', link: '/generators/valibot' },
          { text: 'ArkType', link: '/generators/arktype' },
          { text: 'TypeBox', link: '/generators/typebox' },
          { text: 'Effect', link: '/generators/effect' },
          { text: 'JSON Schema', link: '/generators/json-schema' },
          { text: 'OpenAPI Document', link: '/generators/openapi' },
          { text: 'Nested Relations', link: '/generators/nested-relations' },
          { text: 'Branded Keys', link: '/generators/branded-keys' },
          { text: 'Constraint Data', link: '/generators/constraints' },
          { text: 'Adapters (Overview)', link: '/adapters/overview' },
          { text: 'Router Adapters', link: '/adapters/router' },
        ],
      },
      {
        text: 'Templates',
        collapsed: false,
        items: [
          { text: 'oRPC + Service', link: '/templates/orpc-service' },
          { text: 'Standard', link: '/templates/standard' },
          { text: 'Custom', link: '/templates/custom' },
        ],
      },
      {
        text: 'Packages',
        collapsed: false,
        items: [
          { text: 'Analyzer', link: '/packages/analyzer' },
          { text: 'Validation Core', link: '/packages/validation-core' },
        ],
      },
      {
        text: 'Examples',
        collapsed: false,
        items: [
          { text: 'Relations', link: '/examples/relations' },
          { text: 'Validation Mix', link: '/examples/validation-mix' },
          { text: 'Next.js Server Actions', link: '/examples/nextjs-server-actions' },
        ],
      },
      {
        text: 'Roadmap',
        collapsed: false,
        items: [{ text: 'Premium Templates', link: '/roadmap/premium-templates' }],
      },
      {
        text: 'Sponsor',
        collapsed: false,
        items: [{ text: 'Sponsor DRZL', link: '/sponsor' }],
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
