/**
 * The default theme, plus two slots.
 *
 * VitePress's home layout exposes named slots around the hero and the feature cards, and both
 * components here use them for the same reason: the markdown body of a home page renders inside
 * `.vp-doc`, which restyles every heading, list and link it contains, so anything placed there
 * would spend its stylesheet undoing document typography rather than describing itself.
 *
 * `home-hero-before` carries the landing hero. The page's frontmatter declares no `hero` or
 * `features` block, so VitePress renders neither and the slot is the whole top of the page.
 * `home-features-after` carries the "works with" grid, below it.
 */
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import type { Theme } from 'vitepress';
import Landing from './Landing.vue';
import WorksWith from './WorksWith.vue';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-before': () => h(Landing),
      'home-features-after': () => h(WorksWith),
    });
  },
} satisfies Theme;
