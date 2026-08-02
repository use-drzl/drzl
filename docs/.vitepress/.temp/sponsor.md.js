import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Sponsor","description":"","frontmatter":{},"headers":[],"relativePath":"sponsor.md","filePath":"sponsor.md"}');
const _sfc_main = { name: "sponsor.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="sponsor" tabindex="-1">Sponsor <a class="header-anchor" href="#sponsor" aria-label="Permalink to &quot;Sponsor&quot;">​</a></h1><p>If DRZL saves you time, consider sponsoring to help me keep improving it:</p><ul><li>GitHub Sponsors: <a href="https://github.com/sponsors/omar-dulaimi" target="_blank" rel="noreferrer">https://github.com/sponsors/omar-dulaimi</a></li><li>Perks: priority issues, roadmap votes, shout‑outs.</li><li>Premium/custom template requests? DM me directly on X: <a href="https://x.com/omardulaimidev" target="_blank" rel="noreferrer">https://x.com/omardulaimidev</a></li><li>Paid work lands in this repo under Apache‑2.0. Funding buys dev time, not exclusive ownership.</li><li>Want to fund a scoped task? Look for issues labeled <code>sponsor-wanted</code> (or DM me to create one) and we’ll reserve it for you.</li></ul><p>Thank you for your support!</p></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("sponsor.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const sponsor = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  sponsor as default
};
