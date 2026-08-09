/**
 * The default theme, plus one slot.
 *
 * VitePress's home layout exposes named slots around the hero and the feature cards.
 * `home-features-after` is the one place the "works with" grid can sit and still line up with the
 * cards above it: the markdown body of a home page renders inside `.vp-doc`, which restyles every
 * heading, list and link it contains, so a grid placed there would spend its stylesheet undoing
 * document typography rather than describing itself.
 */
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import type { Theme } from 'vitepress';
import WorksWith from './WorksWith.vue';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-features-after': () => h(WorksWith),
    });
  },
} satisfies Theme;
