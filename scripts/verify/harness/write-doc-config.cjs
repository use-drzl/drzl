/**
 * Write one documented config out of the extractor's JSON so it can be run as a real project.
 *
 * argv[2] is the index into /tmp/doc-configs.json, argv[3] the file to write. CommonJS because
 * that is what it was as a `node -e` argument, and `require` of a .json file is what reads the
 * extracted configs.
 */
const fs = require('fs');
const c = require('/tmp/doc-configs.json')[Number(process.argv[2])];
let body = c.config;
// Docs elide the import on short snippets. That is a snippet convention rather than a
// defect in the configuration, and the point here is whether the config works, so it is
// supplied when missing.
if (body.includes('defineConfig') && !/from '@drzl\/cli\/config'/.test(body)) {
  body = "import { defineConfig } from '@drzl/cli/config';\n" + body;
}
fs.writeFileSync(process.argv[3], body);
