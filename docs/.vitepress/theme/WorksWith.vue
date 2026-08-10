<script setup lang="ts">
/**
 * The "works with" grid on the home page.
 *
 * Rules this component is built to, because a grid of logos is the easiest place on a site to
 * make a claim nobody checks:
 *
 *   1. Every entry links to the page that backs it. A generator entry links to its generator
 *      page, a provider links to its quickstart, a runtime links to the measured table. If an
 *      entry has nowhere honest to point, it does not belong here.
 *   2. Marks render in `currentColor` at one size. The set is mixed by necessity: some names have
 *      a mark in simple-icons and four do not, and a single ink colour is what makes that read as
 *      a deliberate house style rather than as whatever was available. It also means dark mode is
 *      correct without a second copy of anything.
 *   3. The SVGs are `aria-hidden`. Each one sits beside the visible name it depicts, so exposing
 *      it would make a screen reader say the name twice; the name is the accessible name, and the
 *      four entries with no mark carry their name as ordinary text instead. This is deliberate,
 *      not an oversight.
 */
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';
import { marks } from './marks';

/**
 * The initial, for the four names simple-icons has no mark for.
 *
 * Deliberately a letterform in a box rather than a drawing: it is obviously a monogram and not a
 * claim to be anyone's logo, which is what lets the grid be visually even without inventing or
 * scraping a mark. All four initials differ, so one character is unambiguous here.
 */
function monogram(name: string): string {
  return name.replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase();
}

interface Entry {
  /** The visible, and accessible, name. */
  name: string;
  /** Key into the vendored marks. Omitted for the four names simple-icons has no mark for. */
  mark?: string;
  /** The page that backs the claim. */
  link: string;
}

interface Group {
  id: string;
  title: string;
  note: string;
  entries: Entry[];
}

const groups: Group[] = [
  {
    id: 'validation',
    title: 'Validation',
    note: 'Six generator kinds, plus the OpenAPI document the JSON Schema generator writes.',
    entries: [
      { name: 'Zod', mark: 'zod', link: '/generators/zod' },
      { name: 'Valibot', link: '/generators/valibot' },
      { name: 'ArkType', link: '/generators/arktype' },
      { name: 'TypeBox', link: '/generators/typebox' },
      { name: 'Effect Schema', mark: 'effect', link: '/generators/effect' },
      { name: 'JSON Schema', mark: 'json', link: '/generators/json-schema' },
      { name: 'OpenAPI', mark: 'openapiinitiative', link: '/generators/openapi' },
    ],
  },
  {
    id: 'routers',
    title: 'Routers and servers',
    note: 'One generator kind each, emitting the router or the app that framework expects.',
    entries: [
      { name: 'oRPC', link: '/generators/orpc' },
      { name: 'tRPC', mark: 'trpc', link: '/generators/trpc' },
      { name: 'Hono', mark: 'hono', link: '/generators/hono' },
      { name: 'Express', mark: 'express', link: '/generators/express' },
      { name: 'Fastify', mark: 'fastify', link: '/generators/fastify' },
      { name: 'NestJS', mark: 'nestjs', link: '/generators/nestjs' },
      { name: 'GraphQL', mark: 'graphql', link: '/generators/graphql' },
    ],
  },
  {
    id: 'databases',
    title: 'Databases',
    note: 'Four dialects the analyzer reads. The first three are asked a real server on every commit; the providers below them have quickstarts.',
    entries: [
      { name: 'Postgres', mark: 'postgresql', link: '/guide/verification#three-real-databases' },
      { name: 'MySQL', mark: 'mysql', link: '/guide/verification#three-real-databases' },
      { name: 'SQLite', mark: 'sqlite', link: '/guide/verification#three-real-databases' },
      {
        name: 'SingleStore',
        mark: 'singlestore',
        link: '/generators/service#mysql-and-singlestore',
      },
      { name: 'Supabase', mark: 'supabase', link: '/quickstarts/supabase-neon' },
      { name: 'Neon', mark: 'neon', link: '/quickstarts/supabase-neon' },
      { name: 'PlanetScale', mark: 'planetscale', link: '/quickstarts/planetscale' },
      { name: 'Cloudflare D1', mark: 'cloudflare', link: '/quickstarts/cloudflare-d1' },
    ],
  },
  {
    id: 'runtimes',
    title: 'Runtimes',
    note: 'The emitted code and the CLI were run on all three, and the generated tree is byte-identical across them.',
    entries: [
      { name: 'Node', mark: 'nodedotjs', link: '/guide/runtimes' },
      { name: 'Bun', mark: 'bun', link: '/guide/runtimes' },
      { name: 'Deno', mark: 'deno', link: '/guide/runtimes' },
    ],
  },
];


// A link written in a component does not go through the markdown transform, so neither the site
// base nor the page extension is added for it. Both are read from the site data rather than
// hardcoded, so turning on `cleanUrls` or moving the site off `/drzl/` cannot leave this grid
// pointing at 25 dead pages while every other link on the site keeps working.
const { site } = useData();
const extension = computed(() => (site.value.cleanUrls ? '' : '.html'));

function href(link: string): string {
  const hash = link.indexOf('#');
  const path = hash === -1 ? link : link.slice(0, hash);
  const fragment = hash === -1 ? '' : link.slice(hash);
  return withBase(path + extension.value + fragment);
}
</script>

<template>
  <section class="DrzlWorksWith" aria-labelledby="drzl-works-with">
    <div class="container">
      <h2 id="drzl-works-with">Works with</h2>
      <p class="lede">
        Everything here is a generator DRZL ships, a provider with a quickstart, or a runtime the
        output is measured on. Each name links to the page that backs it.
      </p>

      <div class="groups">
        <section
          v-for="group in groups"
          :key="group.id"
          class="group"
          :aria-labelledby="`drzl-ww-${group.id}`"
        >
          <h3 :id="`drzl-ww-${group.id}`">{{ group.title }}</h3>
          <p class="note">{{ group.note }}</p>
          <ul class="cells">
            <li v-for="entry in group.entries" :key="entry.name">
              <a class="cell" :href="href(entry.link)">
                <template v-if="entry.mark">
                  <svg class="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path :d="marks[entry.mark]" fill="currentColor" />
                  </svg>
                  <span class="name"
                    >{{ entry.name
                    }}</span
                  >
                </template>
                <template v-else>
                  <svg class="mark mark-mono" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <rect x="1.6" y="1.6" width="20.8" height="20.8" rx="5" fill="none"
                      stroke="currentColor" stroke-width="1.7" />
                    <text x="12" y="12.6" text-anchor="middle" dominant-baseline="middle"
                      font-size="11" font-weight="700" fill="currentColor">{{ monogram(entry.name) }}</text>
                  </svg>
                  <span class="name"
                    >{{ entry.name
                    }}</span
                  >
                </template>
              </a>
            </li>
          </ul>
        </section>
      </div>

      <p class="aside">
        Forms are deliberately not in the grid, because there is no generator to put there. Every
        schema DRZL emits in zod, valibot or arktype spelling carries Standard Schema v1, which
        <a :href="href('/examples/react-hook-form')">React Hook Form</a> and
        <a :href="href('/examples/tanstack-form')">TanStack Form</a> both accept directly, so wiring
        a table's form is one line and needs no <code>@drzl/*</code> package at all.
      </p>
      <p class="footnote">
        Product names and marks belong to their owners, and appear here only to say which software
        DRZL generates code for. No endorsement or affiliation is implied by any of them.
      </p>
    </div>
  </section>
</template>

<style scoped>
.DrzlWorksWith {
  position: relative;
  padding: 64px 24px 0;
}

@media (min-width: 640px) {
  .DrzlWorksWith {
    padding: 80px 48px 0;
  }
}

@media (min-width: 960px) {
  .DrzlWorksWith {
    padding: 96px 64px 0;
  }
}

/* The same 1152px the feature cards above use, so the two blocks share an edge. */
.container {
  margin: 0 auto;
  max-width: 1152px;
}

h2 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 32px;
  color: var(--vp-c-text-1);
}

.lede {
  margin: 8px 0 0;
  max-width: 60ch;
  font-size: 14px;
  line-height: 22px;
  color: var(--vp-c-text-2);
}

.groups {
  display: grid;
  gap: 32px;
  margin-top: 32px;
}

.group h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-1);
}

/* text-2 rather than text-3. At 13px the lighter one measures about 2.6:1 against the page in
   both themes, which is below what WCAG asks of body text, and these lines carry the provenance
   of everything under them. */
.note {
  margin: 4px 0 0;
  max-width: 72ch;
  font-size: 13px;
  line-height: 20px;
  color: var(--vp-c-text-2);
}

.cells {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

@media (min-width: 640px) {
  .cells {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 960px) {
  .cells {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.cell {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100%;
  padding: 12px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background-color: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  text-decoration: none;
  transition:
    border-color 0.25s,
    background-color 0.25s,
    color 0.25s;
}

.cell:hover,
.cell:focus-visible {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.cell:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.mark {
  flex: none;
  width: 20px;
  height: 20px;
  color: var(--vp-c-text-2);
  transition: color 0.25s;
}

.cell:hover .mark,
.cell:focus-visible .mark {
  color: inherit;
}

.name {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* The monogram, for the four names simple-icons has no mark for. It sits on the same 20px box as
   the vendored glyphs, and its stroke is tuned to read at the same weight as their solid fills
   rather than as a lighter outline, so the row does not go ragged where one appears. */
.mark-mono text {
  font-family: var(--vp-font-family-base);
}

.cell:hover .name,
.cell:focus-visible .name {
  color: inherit;
}

.aside {
  margin: 32px 0 0;
  max-width: 78ch;
  font-size: 14px;
  line-height: 22px;
  color: var(--vp-c-text-2);
}

.aside a {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.aside code {
  padding: 2px 5px;
  border-radius: 4px;
  background-color: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
}

.footnote {
  margin: 24px 0 0;
  max-width: 78ch;
  font-size: 13px;
  line-height: 21px;
  color: var(--vp-c-text-2);
}

.footnote + .footnote {
  margin-top: 12px;
}

.footnote code {
  padding: 2px 5px;
  border-radius: 4px;
  background-color: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
}
</style>
