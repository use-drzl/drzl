import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Premium Templates (Roadmap)","description":"","frontmatter":{},"headers":[],"relativePath":"roadmap/premium-templates.md","filePath":"roadmap/premium-templates.md"}');
const _sfc_main = { name: "roadmap/premium-templates.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="premium-templates-roadmap" tabindex="-1">Premium Templates (Roadmap) <a class="header-anchor" href="#premium-templates-roadmap" aria-label="Permalink to &quot;Premium Templates (Roadmap)&quot;">​</a></h1><p>We plan to offer premium adapter templates and deeper integrations as paid add‑ons.</p><p>Have a specific stack or pattern in mind (e.g., tRPC, Express, Nest, Next.js, Prisma, auth, multi‑tenant)?</p><p><strong>How to request a premium/custom template</strong></p><ul><li>DM me on X: <a href="https://x.com/omardulaimidev" target="_blank" rel="noreferrer">https://x.com/omardulaimidev</a> (mention DRZL + the stack you need)</li></ul><p>Licensing &amp; Access</p><ul><li>Deliverables land in this repo under the same Apache‑2.0 license</li><li>Payments cover build/maintenance time; no exclusive ownership or private licensing</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("roadmap/premium-templates.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const premiumTemplates = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  premiumTemplates as default
};
