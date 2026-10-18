# Publishing (not yet)

Nothing is published to npm until there is a polished release and the maintainer says so. Until then
installs pin a full git commit (`git+https://github.com/nwcnwc/<repo>.git#<sha>`).

When the go-ahead comes, publishing is one step per package, in this order:

1. gifos-mcp-core: `npm publish` (version `0.1.0` in package.json; `files` lists what ships).
2. gifos-meet-mcp and gifos-broadcast-mcp: set `"gifos-mcp-core": "0.1.0"` (exact) in `dependencies`,
   `npm install --ignore-scripts`, commit, then `npm publish`.
3. In each `.mcp.json`, change the args to `["-y", "<package>@<exact version>"]` and commit.

Check first: `npm pack --dry-run` lists only `src`, `bin`, `assets`, `skills`, `.grok-plugin`, `.mcp.json`,
`README.md`, `LICENSE` (core: `src`, `docs`, `README.md`, `LICENSE`), and no install scripts.
