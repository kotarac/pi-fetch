# AGENTS.md

- After every change, run `npm run fmt` and `npm run tsc` and `npm run test`.
- Minimal vertical spacing: avoid extra blank lines within functions.
- No comments: omit comments unless required to explain non-obvious logic.
- Self-documenting: use descriptive names so the logic is clear without annotations.
- Make illegal states unrepresentable: prefer types and input normalization that prevent invalid values from existing.

- Fetch https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/extensions.md to understand how Pi extensions work.
- Fetch https://raw.githubusercontent.com/kreuzberg-dev/html-to-markdown/main/docs/reference/api-typescript.md to understand how html-to-markdown-node works.
