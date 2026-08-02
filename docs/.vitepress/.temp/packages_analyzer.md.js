import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Analyzer","description":"","frontmatter":{},"headers":[],"relativePath":"packages/analyzer.md","filePath":"packages/analyzer.md"}');
const _sfc_main = { name: "packages/analyzer.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="analyzer" tabindex="-1">Analyzer <a class="header-anchor" href="#analyzer" aria-label="Permalink to &quot;Analyzer&quot;">​</a></h1><p>Schema analyzer for Drizzle ORM projects. Produces a normalized <code>Analysis</code> used by generators.</p><p>See the <a href="https://github.com/use-drzl/drzl/blob/master/packages/analyzer/README.md" target="_blank" rel="noreferrer">package README</a> for API and output shape.</p></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("packages/analyzer.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const analyzer = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  analyzer as default
};
