# pi-fetch

Efficient web fetch tool for [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

Adds a `fetch` tool that retrieves a URL and returns the page content, truncated to 50KB / 2000 lines.

## What it does

- Fetches `http(s)` URLs.
- Always asks for HTML (`Accept: text/html, application/xhtml+xml, */*`). Only some sites support returning `text/markdown`, and converting HTML generally does a better job cleaning up real-world pages.
- Converts HTML pages to clean, LLM-friendly text.
- If the response isn’t HTML, it returns textual content as-is; binary content is saved to a temp file.

## Install

This repo is a Pi package (see `package.json#pi.extensions`). Once installed, Pi auto-discovers and loads the extension.

Global install (writes to `~/.pi/agent/settings.json`):

- From GitHub:
  - `pi install git:github.com/kotarac/pi-fetch`
- From npm:
  - `pi install npm:pi-fetch`

Project-local install (writes to `.pi/settings.json` in your project):

- From GitHub:
  - `pi install -l git:github.com/kotarac/pi-fetch`
- From npm:
  - `pi install -l npm:pi-fetch`

## Try without installing

Try the package for a single run:

- From GitHub:
  - `pi -e git:github.com/kotarac/pi-fetch`
- From npm:
  - `pi -e npm:pi-fetch`

## Notes

- Requires `curl` installed and available in `PATH`.
- Output is truncated to keep LLM context usage predictable.
- The implementation is intentionally pragmatic and may look a bit ugly. It was largely generated with an LLM and optimized for “works reliably” over elegance.
- The tool prioritizes efficiency and keeping output compact/predictable for LLM context, even if that means it won’t choose the best possible representation for every site.
- Extensions execute with full system permissions. Only install code you trust.

## Development

- `pnpm run fmt`
- `pnpm run tsc`

## License

GPL-2.0-only
