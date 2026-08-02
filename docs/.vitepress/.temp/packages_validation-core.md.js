import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Validation Core","description":"","frontmatter":{},"headers":[],"relativePath":"packages/validation-core.md","filePath":"packages/validation-core.md"}');
const _sfc_main = { name: "packages/validation-core.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="validation-core" tabindex="-1">Validation Core <a class="header-anchor" href="#validation-core" aria-label="Permalink to &quot;Validation Core&quot;">​</a></h1><p>Shared interfaces and helpers for validation schema codegen across libraries.</p><p>See the <a href="https://github.com/use-drzl/drzl/blob/master/packages/validation-core/README.md" target="_blank" rel="noreferrer">package README</a> for APIs and utilities.</p></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("packages/validation-core.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const validationCore = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  validationCore as default
};
