import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"DRZL","description":"","frontmatter":{"layout":"home","title":"DRZL","hero":{"text":"Developer tooling for Drizzle ORM","tagline":"Analyze schemas. Generate services, routers (adapter-based), and validation.","image":{"light":"/brand/logo.png","dark":"/brand/logo-dark.png","alt":"DRZL logo"},"actions":[{"theme":"brand","text":"Get Started","link":"/guide/getting-started"},{"theme":"alt","text":"CLI","link":"/cli"}]},"features":[{"title":"Schema Analyzer","details":"Normalize Drizzle schemas into a portable Analysis for generators."},{"title":"Generators","details":"Routers (adapter-based; currently oRPC), typed services (with serverless-friendly database injection), and validation schemas (Zod, Valibot, ArkType)."},{"title":"Templates","details":"Adapter templates for quick scaffolding or service wiring. Request custom templates as a paid service."}]},"headers":[],"relativePath":"index.md","filePath":"index.md"}');
const _sfc_main = { name: "index.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h2 id="funded-features" tabindex="-1">Funded Features <a class="header-anchor" href="#funded-features" aria-label="Permalink to &quot;Funded Features&quot;">​</a></h2><ul><li><em>None yet. Be the first!</em> Need a template, generator, or adapter that doesn’t exist yet? DM me on X (<a href="https://x.com/omardulaimidev" target="_blank" rel="noreferrer">https://x.com/omardulaimidev</a>) to fund it. All funded work ships back into DRZL under Apache‑2.0.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("index.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const index = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  index as default
};
