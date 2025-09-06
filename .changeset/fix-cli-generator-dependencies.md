---
"@drzl/cli": patch
---

Fix missing generator dependencies and improve error messages

- Add all generator packages (@drzl/generator-zod, @drzl/generator-service, @drzl/generator-valibot, @drzl/generator-arktype) as dependencies in CLI package.json
- Update error handling to provide clearer installation instructions when generators are missing
- Separate error details for better readability

This resolves the "Cannot find package" errors when using generators other than ORPC.