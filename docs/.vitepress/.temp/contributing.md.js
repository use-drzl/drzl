import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Contributing","description":"","frontmatter":{},"headers":[],"relativePath":"contributing.md","filePath":"contributing.md"}');
const _sfc_main = { name: "contributing.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="contributing" tabindex="-1">Contributing <a class="header-anchor" href="#contributing" aria-label="Permalink to &quot;Contributing&quot;">​</a></h1><p>Thanks for your interest in DRZL! Please read the full guide in <a href="https://github.com/omar-dulaimi/drzl/blob/master/CONTRIBUTING.md" target="_blank" rel="noreferrer">CONTRIBUTING.md</a>.</p><p>Quick checklist:</p><ul><li>Fork and create a feature branch</li><li>Keep changes focused; follow existing patterns</li><li>Run tests: <code>pnpm -r test</code> and lint: <code>pnpm lint</code></li><li>Open a PR with a clear description and rationale</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("contributing.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const contributing = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  contributing as default
};
