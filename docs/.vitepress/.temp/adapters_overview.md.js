import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Adapters (Overview)","description":"","frontmatter":{},"headers":[],"relativePath":"adapters/overview.md","filePath":"adapters/overview.md"}');
const _sfc_main = { name: "adapters/overview.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="adapters-overview" tabindex="-1">Adapters (Overview) <a class="header-anchor" href="#adapters-overview" aria-label="Permalink to &quot;Adapters (Overview)&quot;">​</a></h1><p>DRZL is adapter‑agnostic. Router generation is driven by adapter templates so you can target different stacks.</p><p>Current support:</p><ul><li>oRPC adapter (via generator-orpc and related templates)</li></ul><p>Planned/possible adapters (community interest welcome):</p><ul><li>tRPC, Express, NestJS, Next.js, Prisma, and more</li></ul><p>How it works:</p><ul><li>Adapters define a small template interface (hooks) that tell the generator how to name files, export router identifiers, inject imports/prelude, and render procedure code.</li><li>You can write custom templates to adapt to your runtime or conventions.</li></ul><p>See also:</p><ul><li><a href="/drzl/adapters/router.html">Router Adapters</a></li><li><a href="/drzl/templates/custom.html">Custom Templates</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("adapters/overview.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const overview = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  overview as default
};
