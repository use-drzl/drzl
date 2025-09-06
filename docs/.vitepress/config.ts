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
    ],
    sidebar: [
      {
        text: 'Guide',
        collapsed: false,
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
        ],
      },
      {
        text: 'CLI',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/cli' },
          { text: 'Init', link: '/cli/init' },
          { text: 'Analyze', link: '/cli/analyze' },
          { text: 'Generate', link: '/cli/generate' },
          { text: 'Generate (oRPC)', link: '/cli/generate-orpc' },
          { text: 'Watch', link: '/cli/watch' },
        ],
      },
      {
        text: 'Generators',
        collapsed: false,
        items: [
          { text: 'oRPC', link: '/generators/orpc' },
          { text: 'Service', link: '/generators/service' },
          { text: 'Zod', link: '/generators/zod' },
          { text: 'Valibot', link: '/generators/valibot' },
          { text: 'ArkType', link: '/generators/arktype' },
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
  },
};
