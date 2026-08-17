## Package Manager

For this repo we're using nub to manage packages.

```bash
nub script.ts            # run a TypeScript file
nub install              # install dependencies (pnpm-compatible)
nub run dev              # run a package.json script
nubx prisma generate     # run a CLI from node_modules/.bin
```

### Example nub commands

| Nub                | Instead of                                 |
| ------------------ | ------------------------------------------ |
| `nub <file>`       | `node`, `tsx`, `ts-node`, `dotenv-cli`     |
| `nub run <script>` | `npm run`, `pnpm run`, `yarn run`          |
| `nubx`             | `npx`, `pnpm dlx`, `pnpm exec`, `yarn dlx` |
| `nub install`      | `npm`, `pnpm`, `yarn`                      |
| `nub watch`        | `nodemon`, `node --watch`, `tsx watch`     |
| `nub node`         | `nvm`, `fnm`, `n`, `volta`                 |
| `nub pm`           | `corepack`                                 |

## TypeScript conventions

- Treat every ESLint and Oxlint rule as a hard constraint. Never add disable comments, ignored files, or configuration exceptions; change the implementation to comply.
- Give every module a descriptive filename and import it directly. Never create or use `index` files, including barrel files.

## Where to next [#where-to-next]

- Quick answers: the [FAQ](/docs/faq).

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context layout: `CONTEXT.md` and `docs/adr/` live at the repository root. See `docs/agents/domain.md`.
