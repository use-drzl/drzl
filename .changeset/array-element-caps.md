---
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
---

Cap array elements again in the ArkType and TypeBox generators

Moving `varchar(n)` caps off the UTF-16 keywords dropped them for array columns: `varchar(50).array()`
emitted a bare `string[]` and `Type.Array(Type.String())`. The cap describes the element, not the
list, so it now goes on the element, with `.array()` wrapping it in ArkType.

For TypeBox that also fixed an emitted module that threw on import. The check deciding whether to
emit the registry preamble still excluded array columns while the expression no longer did, so a
file used `[Kind]` without importing it. Both now read one shared predicate.

Found by regenerating the documentation examples, which is the only reason anything looked at a
capped array.
