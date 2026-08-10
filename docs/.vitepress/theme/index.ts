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
import './theme.css';
import { h } from 'vue';
import type { Theme } from 'vitepress';
import Landing from './Landing.vue';
import WorksWith from './WorksWith.vue';

/**
 * How many pages each collapsed section holds.
 *
 * The sidebar is progressive: every group is collapsed and VitePress opens the one holding the
 * current page, so nine of the ten sections are a single row most of the time. A row that says only
 * "Reference" tells you nothing about whether opening it is worth the click; a row that says
 * "Reference 6" does. The badge is therefore shown on collapsed groups and hidden on the open one,
 * where the pages are already visible and counting them would be noise.
 *
 * Counted from the rendered sidebar rather than written into the config, so it cannot fall out of
 * step with the items the way a hardcoded number would. It runs after mount and after every route
 * change, because VitePress rebuilds the sidebar when the section changes.
 */
function countSidebarSections() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.VPSidebarItem.level-0').forEach((group) => {
    // The attribute goes on the row that carries the ::after, not on the group. CSS attr() only
    // reads the attribute of the element the pseudo-element belongs to, so setting it on the
    // ancestor renders an empty string and a badge that is present, sized and invisible.
    const row = group.querySelector(':scope > .item');
    if (!row) return;
    const links = group.querySelectorAll('.VPSidebarItem .link').length;
    // A group of one is the standalone link, which is not a section and gets no badge.
    if (group.classList.contains('collapsible') && links > 0) {
      row.setAttribute('data-drzl-count', String(links));
    } else {
      row.removeAttribute('data-drzl-count');
    }
  });
}

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window === 'undefined') return;
    const run = () => requestAnimationFrame(countSidebarSections);
    const previous = router.onAfterRouteChange;
    router.onAfterRouteChange = (href: string) => {
      previous?.(href);
      run();
    };
    window.addEventListener('load', run);
    run();
  },
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-before': () => h(Landing),
      'home-features-after': () => h(WorksWith),
    });
  },
} satisfies Theme;
