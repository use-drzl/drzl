---
---

Four dead declarations removed from the verify harness and one test, each read before it was
deleted. No published package changes: three of the four live in `scripts/verify`, which ships
nowhere, and the fourth is an unused destructure in a test file that is not part of any tarball.
This changeset is empty on purpose, so the check that every changed package is accounted for can
see that this one was.
