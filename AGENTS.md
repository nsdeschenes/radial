## Package Manager
For this repo we're using nub to manage packages.

```bash
nub index.ts             # run a TypeScript file
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

## Where to next [#where-to-next]

* Quick answers: the [FAQ](/docs/faq).
