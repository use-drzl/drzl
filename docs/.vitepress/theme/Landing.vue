<script setup lang="ts">
/**
 * The home page hero.
 *
 * The shape is one claim: a Drizzle schema goes in on the left, and the files DRZL writes come out
 * on the right, with a curve drawn between the schema and each one. Opening a row shows the real
 * file it writes and the path it lands at, so the page demonstrates the product rather than
 * describing it.
 *
 * Things this is built to, because each was a bug first:
 *
 *   1. The curves are measured from where the rows actually are, not from hardcoded coordinates.
 *      A row grows when it opens, the type loads late, the viewport changes; each of those moves a
 *      row, and a hardcoded endpoint detaches. `draw()` reads the live rects and redraws on resize,
 *      on `fonts.ready` and on any layout change the observer sees.
 *   2. `draw()` bails and retries when the container has no box yet. Measuring before layout
 *      returns zeros, and a zero-size viewBox renders curves that are technically present and
 *      visibly absent.
 *   3. Rows are selected by a scoped class rather than by a short one. An earlier version matched
 *      `.o`, which also matched a button elsewhere on the page; that element had no summary, the
 *      map threw, and the whole fan silently vanished.
 *   4. Colours come from VitePress tokens wherever text sits on a surface, so the light and dark
 *      themes are both correct without a second copy, and the accents that are not in the token
 *      set are declared once and flipped under `.dark`.
 *
 * The fan is decorative and marked `aria-hidden`. The relationship it draws is already carried by
 * the markup: each row names its output, and its open state names the file and shows its contents.
 */
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { withBase } from 'vitepress';

interface Output {
  /** The library or target this row is about. */
  name: string;
  /** One real line from the emitted file, short enough to read at a glance. */
  line: string;
  /** Where the file lands, relative to the project root. */
  path: string;
  /** The emitted file, trimmed to what fits without scrolling. */
  code: string;
}

const outputs: Output[] = [
  {
    name: 'Zod',
    line: "usersInsert = z.object({ id, email, age, ... })",
    path: 'src/gen/users.zod.ts',
    code: `import { z } from 'zod';

export const usersInsertSchema = z.object({
  id:    z.number().int(),
  email: z.string().max(255),
  age:   z.number().int().gte(18),
  tier:  z.string(),
});
// plus usersSelectSchema, same shape`,
  },
  {
    name: 'Valibot',
    line: 'v.object({ id: v.pipe(v.number(), v.integer()) ... })',
    path: 'src/gen/users.valibot.ts',
    code: `import * as v from 'valibot';

export const usersInsertSchema = v.object({
  id:    v.pipe(v.number(), v.integer()),
  email: v.pipe(v.string(), v.maxLength(255)),
  age:   v.pipe(v.number(), v.minValue(18)),
});`,
  },
  {
    name: 'JSON Schema',
    line: '{ "type": "object", "required": ["email", ...] }',
    path: 'src/gen/users.schema.json',
    code: `{
  "type": "object",
  "required": ["email", "age"],
  "properties": {
    "email": { "type": "string", "maxLength": 255 },
    "age":   { "type": "integer", "minimum": 18 }
  }
}`,
  },
  {
    name: 'tRPC',
    line: 'usersRouter.create.input(usersInsert)',
    path: 'src/api/users.router.ts',
    code: `import { usersInsertSchema } from '../gen';

export const usersRouter = router({
  create: publicProcedure
    .input(usersInsertSchema)
    .mutation(({ input }) => UsersService.create(input)),
});`,
  },
  {
    name: 'Hono',
    line: "app.post('/users', sValidator('json', usersInsert))",
    path: 'src/api/users.routes.ts',
    code: `app.post('/users',
  sValidator('json', usersInsertSchema),
  async (c) => c.json(
    await UsersService.create(c.req.valid('json')), 201));`,
  },
  {
    name: 'NestJS',
    line: 'class CreateUserDto { ... }',
    path: 'src/api/dto/create-user.dto.ts',
    code: `export class CreateUserDto {
  @IsString() @MaxLength(255) email: string;
  @IsInt() @Min(18) age: number;
}`,
  },
  {
    name: 'GraphQL',
    line: 'type User { id: Int! email: String! ... }',
    path: 'src/api/schema.graphql',
    code: `type User {
  id: Int!
  email: String!
  age: Int!
}
input CreateUserInput { email: String! age: Int! }`,
  },
  {
    name: 'Services',
    line: 'UsersService.create(input) to db.insert(users)',
    path: 'src/services/users.service.ts',
    code: `export class UsersService {
  static async create(input: UsersInsert) {
    return db.insert(users).values(input).returning();
  }
}`,
  },
];

const schema = `export const users =
  pgTable('users', {
    id:    integer(),
    email: varchar(),
    age:   integer(),
    tier:  text(),
  });`;

const fanEl = ref<HTMLElement | null>(null);
const svgEl = ref<SVGSVGElement | null>(null);
const srcEl = ref<HTMLElement | null>(null);
const rowsEl = ref<HTMLElement | null>(null);
const active = ref(0);

let observer: ResizeObserver | null = null;

function draw() {
  const fan = fanEl.value;
  const svg = svgEl.value;
  const src = srcEl.value;
  const rows = rowsEl.value;
  if (!fan || !svg || !src || !rows) return;

  const wrap = fan.getBoundingClientRect();
  // Before layout has run the rect is all zeros, and a zero viewBox draws nothing visible.
  if (!wrap.width || !wrap.height) {
    requestAnimationFrame(draw);
    return;
  }

  const from = src.getBoundingClientRect();
  const w = wrap.width;
  const h = wrap.height;
  const y0 = from.top + from.height / 2 - wrap.top;

  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = Array.from(rows.querySelectorAll('.drzl-row'))
    .map((row, i) => {
      const head = row.querySelector('summary');
      if (!head) return '';
      const r = head.getBoundingClientRect();
      const y = r.top + r.height / 2 - wrap.top;
      const on = i === active.value ? ' drzl-on' : '';
      return `<path class="drzl-edge${on}" d="M0,${y0} C${w * 0.6},${y0} ${w * 0.4},${y} ${w},${y}"/>`;
    })
    .join('');
}

/** Only one row stays open, so the page never grows into a wall of code. */
function onToggle(event: Event, index: number) {
  const el = event.target as HTMLDetailsElement;
  if (el.open) {
    rowsEl.value?.querySelectorAll<HTMLDetailsElement>('.drzl-row').forEach((other) => {
      if (other !== el) other.open = false;
    });
  }
  active.value = index;
  requestAnimationFrame(draw);
}

function focusRow(index: number) {
  active.value = index;
  draw();
}

onMounted(() => {
  window.addEventListener('resize', draw);
  if (document.fonts?.ready) void document.fonts.ready.then(draw);
  if (window.ResizeObserver && rowsEl.value) {
    observer = new ResizeObserver(draw);
    observer.observe(rowsEl.value);
  }
  requestAnimationFrame(draw);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', draw);
  observer?.disconnect();
});
</script>

<template>
  <section class="drzl-landing">
    <div class="drzl-hero">
      <h1>One schema in.<br />Everything else out.</h1>
      <p class="drzl-say">
        DRZL is a code generator for <strong>Drizzle ORM</strong>. Point it at the schema you already
        wrote and it emits the validation schemas, API routers and typed services to match. Open any
        row below to read the file it writes.
      </p>
      <div class="drzl-cta">
        <a class="drzl-btn" :href="withBase('/guide/getting-started')">Get started</a>
        <a class="drzl-btn drzl-btn-alt" :href="withBase('/cli')">CLI reference</a>
      </div>
    </div>

    <div class="drzl-rig">
      <div class="drzl-src" ref="srcEl">
        <p class="drzl-cap">src/schema.ts</p>
        <pre><code>{{ schema }}</code></pre>
      </div>

      <div class="drzl-fan" ref="fanEl" aria-hidden="true">
        <svg ref="svgEl"></svg>
      </div>

      <div class="drzl-outs" ref="rowsEl">
        <details
          v-for="(out, i) in outputs"
          :key="out.path"
          class="drzl-row"
          @toggle="onToggle($event, i)"
          @mouseenter="focusRow(i)"
        >
          <summary>
            <span class="drzl-name">{{ out.name }}</span>
            <span class="drzl-line">{{ out.line }}</span>
            <span class="drzl-more">view file</span>
          </summary>
          <div class="drzl-file">
            <p class="drzl-path">{{ out.path }}</p>
            <pre><code>{{ out.code }}</code></pre>
          </div>
        </details>
      </div>
    </div>

    <ul class="drzl-facts">
      <li>14 generators</li>
      <li>1 install</li>
      <li>0 runtime dependencies added</li>
      <li>Node, Bun and Deno</li>
      <li>Apache-2.0</li>
    </ul>
  </section>
</template>

<style scoped>
.drzl-landing {
  /* Text and surfaces come from the theme so both appearances are correct without a second copy.
     The two accents below are not in the token set, so they are declared here and flipped in dark. */
  --drzl-edge: #cfcac1;
  --drzl-file-bg: var(--vp-c-bg-alt);
  max-width: 1152px;
  margin: 0 auto;
  padding: 40px 24px 8px;
}

.drzl-hero {
  text-align: center;
  padding: 24px 0 8px;
}
.drzl-hero h1 {
  font-size: clamp(34px, 5.4vw, 58px);
  line-height: 1.06;
  letter-spacing: -0.03em;
  font-weight: 800;
  margin: 0 0 18px;
}
.drzl-say {
  font-size: 19px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  max-width: 60ch;
  margin: 0 auto 26px;
}
.drzl-say strong {
  color: var(--vp-c-text-1);
  font-weight: 600;
}

.drzl-cta {
  display: flex;
  gap: 11px;
  justify-content: center;
  flex-wrap: wrap;
}
.drzl-btn {
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  padding: 12px 24px;
  border-radius: 8px;
  /* The two appearances need different values here and neither token is right for both. In light,
     the theme's button token resolves to #5672cd on white, which is 4.48:1 and misses the threshold,
     so the base is brand-1 at 7.08:1. In dark, brand-1 is a light indigo and white on it measures
     2.02:1, so the dark rule below puts the theme's own token back, which is 5.21:1 there. The
     override is written as `:global(.dark) X` because `:global(html:not(.dark)) X` is dropped
     outright by the scoped-style compiler and emits no rule at all. */
  border: 1px solid transparent;
  background: var(--vp-c-brand-1);
  color: var(--vp-button-brand-text);
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}
.drzl-btn:hover {
  background: var(--vp-c-brand-2);
}
.drzl-btn-alt {
  background: var(--vp-button-alt-bg);
  border-color: var(--vp-button-alt-border);
  /* The theme's own alt-button text measures 3.88:1 on that surface in the dark appearance.
     text-1 is the same family of greys and clears the threshold in both. */
  color: var(--vp-c-text-1);
}
.drzl-btn-alt:hover {
  background: var(--vp-button-alt-hover-bg);
  border-color: var(--vp-button-alt-hover-border);
}

.drzl-rig {
  margin: 44px 0 0;
  display: grid;
  grid-template-columns: 300px 92px minmax(0, 1fr);
  align-items: center;
}
.drzl-rig > * {
  min-width: 0;
}

.drzl-src {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 11px;
  overflow: hidden;
}
.drzl-cap {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
  margin: 0;
  padding: 10px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
}
.drzl-src pre {
  margin: 0;
  padding: 14px;
  overflow-x: auto;
}
.drzl-src code,
.drzl-file code {
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--vp-c-text-1);
  white-space: pre;
}

.drzl-fan {
  position: relative;
  align-self: stretch;
  min-height: 160px;
}
.drzl-fan svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.drzl-landing :deep(.drzl-edge) {
  fill: none;
  stroke: var(--drzl-edge);
  stroke-width: 1.2;
  transition: stroke 0.16s ease;
}
.drzl-landing :deep(.drzl-on) {
  stroke: var(--vp-c-brand-1);
  stroke-width: 2;
}

.drzl-outs {
  display: grid;
  gap: 7px;
}
.drzl-row {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  overflow: hidden;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}
.drzl-row:hover,
.drzl-row[open] {
  border-color: var(--vp-c-brand-1);
}
.drzl-row > summary {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px 14px;
  cursor: pointer;
  list-style: none;
}
.drzl-row > summary::-webkit-details-marker {
  display: none;
}
.drzl-row > summary:focus-visible,
.drzl-btn:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.drzl-name {
  font-weight: 600;
  font-size: 14px;
  letter-spacing: -0.015em;
}
.drzl-line {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drzl-more {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
  white-space: nowrap;
}
.drzl-row[open] .drzl-more {
  color: var(--vp-c-brand-1);
}

.drzl-file {
  border-top: 1px solid var(--vp-c-divider);
  background: var(--drzl-file-bg);
}
.drzl-path {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  color: var(--vp-c-text-2);
  margin: 0;
  padding: 9px 14px 0;
}
.drzl-file pre {
  margin: 0;
  padding: 8px 14px 14px;
  overflow-x: auto;
}

.drzl-facts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  list-style: none;
  margin: 34px 0 0;
  padding: 0;
}
.drzl-facts li {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  padding: 7px 14px;
}

@media (max-width: 900px) {
  .drzl-rig {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .drzl-fan {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .drzl-landing *,
  .drzl-landing *::before,
  .drzl-landing *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
  }
}
</style>

<style>
/*
 * Appearance-dependent rules only.
 *
 * These cannot live in the scoped block above: the scoped-style compiler drops
 * `:global(.dark) X` and `:global(html:not(.dark)) X` outright, emitting no rule at all, so a
 * dark override written there is silently absent from the stylesheet. Every selector here is
 * keyed on `.drzl-landing`, so an unscoped block cannot reach anything else on the site.
 */
.dark .drzl-landing {
  /* The resting curves need a dark-ground grey. The light value is a warm grey that reads as a
     mistake against the dark surface. */
  --drzl-edge: #2c3644;
}
.dark .drzl-landing .drzl-btn:not(.drzl-btn-alt) {
  /* brand-1 is a light indigo in this appearance, and the white button text on it measures
     2.02:1, so the theme's paired button token goes back in here at 5.21:1.
     The `:not()` matters: the secondary button carries both classes, and an unscoped three-class
     selector outranks the scoped `.drzl-btn-alt[data-v-x]` rule, so without it the dark appearance
     paints the secondary button with the primary background and the two stop being told apart. */
  background: var(--vp-button-brand-bg);
}
.dark .drzl-landing .drzl-btn:not(.drzl-btn-alt):hover {
  background: var(--vp-button-brand-hover-bg);
}
</style>
