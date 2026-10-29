# AGENTS.md

Repo for pi extensions: one npm package each, published to the forge's npm registry.
[`README.md`](./README.md) is the map; the header comment of each `packages/<name>/index.ts`
carries its design, its measurements and its failure modes, and is the thing to read
before touching that package.

## Rules

1. **A branch and a worktree per change.** No feature and no bugfix is worked on in the
   `main` checkout. Branch `feat/<thing>` or `fix/<thing>`, worktree beside the repository:

   ```bash
   git worktree add ../pi-extensions-fix-token-error -b fix/token-error
   cd ../pi-extensions-fix-token-error && npm ci    # types live in the root node_modules
   ```

   A worktree starts without `node_modules`, so `npm run check` there fails until `npm ci`
   has run. Remove the worktree when the change is merged:
   `git worktree remove ../pi-extensions-fix-token-error`.

2. **Nothing is committed, pushed, tagged or installed without the user's approval for
   that specific action.** Preparing a change, showing the diff, naming the exact command
   — fine. `git commit`, `git push`, `git tag`, and `pi install`/`pi remove`/`pi update` on
   any machine — only on request. Publishing happens by pushing a tag, so a push is not a
   private act here: it can put a version in the registry that every machine then pulls.

3. **English throughout the repository.** Code, comments, doc comments, commit messages,
   branch names, tool descriptions, README and error strings — English. This is the
   operator's second language and the only language a published package's description is
   read in. Russian belongs to the chat and to session notes, never to a file here.

4. **`main` is protected — only a merged pull request changes it.** Direct pushes are refused
   by the server, not by convention — measured with the account this machine pushes with:
   pushing to `main` ends in
   `Forgejo: Not allowed to push to protected branch main` and `pre-receive hook declined`.
   Work happens on the branch and arrives by pull request; merging is an action of its own,
   so it needs its own approval under rule 2.

   **Opening a pull request is the user's click; the agent's part ends with a link and a
   description.** After the push, hand over the compare URL the push itself prints, plus the
   text to paste — the title is one line about what changes, the body is the reason, which is
   already written in the commit message:

   ```text
   https://git.rezolver-zero.com/developer/pi-extensions/compare/main...<branch>
   ```

   Do not spend a push rediscovering the two ways that do not work here. Forgejo 14.0.5
   ignores `merge_request.create` — bare and `=true` alike, a push of a new branch answers
   with nothing but that compare URL — and the tokens held here are scoped to packages, so
   the API refuses even a read:

   ```text
   token does not have at least one of required scope(s): [read:repository]
   ```

   `POST /repos/developer/pi-extensions/pulls` does work, given a token scoped for the
   repository (_Settings → Applications_, not the one `~/.npmrc` uses for packages); ask for
   one rather than assuming it is there.

## Before proposing a change

```bash
npm run check    # tsc -p . — the only gate in the repository
```

pi loads TypeScript without type-checking it, so a type error is invisible in every run
until this command runs. It is also why the root `package.json` pins the pi release: the
check means nothing if the pinned version drifts from the pi the packages are meant for.

There are no tests and no linter. A change to a package is verified by loading it:

```bash
pi --no-extensions -e ./packages/<name>
```

## A release is part of the change

A commit that changes `packages/<name>/index.ts` raises `version` in that package's
`package.json` in the same commit — the registry refuses a version that was published once,
so a fix is always a new version. Shipping
is a tag whose name is the package and the version it holds:

```bash
git tag pi-web@1.1.0 && git push origin pi-web@1.1.0
```

The tag pushes through the `publish` job, which type-checks first and fails if the version
in the tag is not the version in the manifest. Never run `npm publish` by hand.

When pi itself moves, raise the pinned versions in the root `package.json` and run
`npm run check` before anything else is changed.

## A new package looks like the other six

Copy a neighbouring `package.json` rather than writing one: `@developer/<name>`, the
`pi-package` keyword, `license: UNLICENSED`, a `files` list naming exactly `index.ts`,
`README.md` and the config example, `pi.extensions: ["./index.ts"]`, the three
`peerDependencies` at `"*"` (the packages come from the pi that loads this one, so nothing
here may install a second copy), and `publishConfig.registry`. `tsconfig.json` picks the
directory up by glob; the root `package.json` needs nothing.

`README.md` stays a shop window — what it is, install and remove, a pointer to the config
example. The command named after the package (`/web`, `/image`, `/speak`, `/suggest`) is
where a package says what is in force, and where a path can be proved without a model call.

## The why lives in the file header

Design, the alternatives rejected, the measurements and the failure modes go in the header
comment of `index.ts`, not in `README.md` and not in a document beside it: `files` ships
`index.ts`, so the reasoning travels with the code and cannot drift from it. A change that
makes the header wrong is not finished. New measurements belong there too, with the numbers
that produced them and the machine they were taken on.

## Config and secrets

A package reads `~/.pi/agent/<name>.json`, every key optional, the defaults being the
working ones, and ships `<name>.json.example` of its shape. The config is read on each use,
not once at load, and the slash command carries `reload` — so an edit needs no restart.

A token never lives in the config, in argv, or in the environment: on this OS every process
of the same user reads them, and a config gets pasted into a chat. A token lives in a file
at `0600` which the config names, and is read when it is needed. Secrets stay out of this
repository: no token, no token file, and no endpoint beyond the public hosts the defaults
already name.
