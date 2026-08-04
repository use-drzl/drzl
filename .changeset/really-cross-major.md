---
---

Test-only. Makes the cross-major analyzer diff actually compare two majors, and changes no source:
`git diff master..HEAD -- 'packages/*/src'` is empty.

The stage was added on 2026-08-02 and had been green ever since for the reason a diff of a file
against itself is green: `$OLD` pinned `drizzle-orm@0.45.2` while the tree it compared against
installed `drizzle-orm` unpinned, and npm's `latest` tag is 0.45.2. It compared 20 columns of
0.45.2 with 20 columns of 0.45.2, and its empty allowlist was read as "the analyzer is version
independent".

It now compares 100 columns and 10 tables of 0.45.2 against 1.0.0-rc.4, asserts the two trees
report different versions before comparing anything, and fails when a field is empty on both sides
rather than counting it as agreement.

Fifty-four analyzer defects on the 0.4x path are filed rather than fixed, since fixing one means
changing what the analyzer emits for the major nearly every user runs, and the gate that would show
such a change is right does not exist yet.
