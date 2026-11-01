# pi-extensions

The lab's own pi extensions, one npm package each, published to the forge's npm
registry so that every one is installed and removed on its own:

```bash
pi install npm:@developer/pi-web
pi remove  npm:@developer/pi-web
pi update  --extensions          # moves every unpinned package to its latest version
```

| Package                                       | What it does                                                                                            | Config             | Scope                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------- |
| [`pi-web`](packages/pi-web)                   | Crawl4AI as `web_peek`, `web_read`, `web_screenshot`, `web_pdf`; `/web` shows what the model is offered | `web.json`         | global                    |
| [`pi-image`](packages/pi-image)               | qwen-image as `generate_image`; `/image test`                                                           | `image.json`       | global                    |
| [`pi-speak`](packages/pi-speak)               | one spoken Russian sentence at the end of a turn, through piper; `/speak`                               | `tts.json`         | global                    |
| [`next-prompt`](packages/next-prompt)         | the next message guessed as grey ghost text; `/suggest`                                                 | `next-prompt.json` | global                    |
| [`rewrite-compact`](packages/rewrite-compact) | a compaction summary rewritten, not appended to                                                         | —                  | global                    |
| [`remote-gate`](packages/remote-gate)         | a yes/no before a bash call changes a remote host or the network                                        | —                  | global, **not installed** |
| [`read-window`](packages/read-window)         | refuses an unbounded `read` of a large file                                                             | —                  | project: `gw-router`      |

Configs live in `~/.pi/agent/`, every key is optional, and each package carries a
`*.example` of its shape. Secrets stay in the config or in a file it names, never in
this repository.

## Documentation

[`docs/pi-extensions-ru.md`](docs/pi-extensions-ru.md) is a Russian translation of
pi's extensions guide (<https://pi.dev/docs/latest/extensions>), kept in the
repository so the Russian-side terms stay searchable.

## Setting up a machine

npm needs to know where the `@developer` scope lives, and — unless the `developer`
account is public — a token that may read its packages: _Settings → Applications_,
scope `read:package`. pi installs with npm, and npm reads `~/.npmrc`:

```ini
@developer:registry=https://git.rezolver-zero.com/api/packages/developer/npm/
//git.rezolver-zero.com/api/packages/developer/npm/:_authToken=<read:package token>
```

Then `pi install npm:@developer/<name>` for each package wanted, and
`pi install -l npm:@developer/read-window` inside `gw-router`. A project package
loads only after pi has been told the project is trusted.

## Changing a package

1. Edit `packages/<name>/index.ts`. Try it without installing:
   `pi --no-extensions -e ./packages/<name>`.
2. `npm install && npm run check` — types against the pi release pinned in the root
   `package.json`, then Biome (format, lint, import order) and fallow (package boundaries,
   dead code). pi loads TypeScript without checking it, so nothing is visible until this
   runs. `npm run report` adds duplication and complexity as advice, never as a failure.
3. Bump `version` in `packages/<name>/package.json`, commit, and tag
   `<name>@<version>` (`git tag pi-web@1.1.0`). Pushing the tag runs the same check and
   publishes that one package; a tag whose version differs from the manifest fails.
4. `pi update npm:@developer/<name>` on each machine.

Publishing needs the secret `REGISTRY_TOKEN` (scope `write:package`) on this
repository or its owner — the same token `srv02/k3s` pushes images with. A version
cannot be published twice: the registry refuses it, so a fix is always a new version.

When pi itself moves to a new release, raise the pinned versions in the root
`package.json` and run the check before anything else.
