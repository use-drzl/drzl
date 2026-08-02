import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Standard Template","description":"","frontmatter":{},"headers":[],"relativePath":"templates/standard.md","filePath":"templates/standard.md"}');
const _sfc_main = { name: "templates/standard.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="standard-template" tabindex="-1">Standard Template <a class="header-anchor" href="#standard-template" aria-label="Permalink to &quot;Standard Template&quot;">​</a></h1><p>Minimal oRPC router template for quick scaffolding without service wiring.</p><p>See the <a href="https://github.com/use-drzl/drzl/blob/master/packages/template-standard/README.md" target="_blank" rel="noreferrer">package README</a> for hooks and notes.</p><div class="tip custom-block"><p class="custom-block-title">Need something else?</p><p>If this template doesn&#39;t cover what you need, DM me on X (<a href="https://x.com/omardulaimidev" target="_blank" rel="noreferrer">https://x.com/omardulaimidev</a>) and we can scope it together.</p></div></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("templates/standard.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const standard = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  standard as default
};
