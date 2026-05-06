# Contributing

## Build from Source

```bash
npm ci --legacy-peer-deps
# or: npm install --legacy-peer-deps
npm run release
```

Produces `second-brain.zip` containing the plugin bundle: **`main.js`** (compiled code), **`manifest.json`** (plugin metadata), **`styles.css`** (styles). Extract into `.obsidian/plugins/second-brain/`.

Before cutting a release build for **second-brain-release**, run **`npm run ci`** locally in this repo (typecheck + tests + production build), then `npm run release` and attach the zip to **second-brain-release** on GitHub. Pushes and PRs to `main` / `master` here run CI; successful runs attach `main.js`, `manifest.json`, and `styles.css` as a workflow artifact for sanity checks.

## GitHub + Gitee (dual remotes)

- **Gitee Go (runs on Gitee):** enable **Gitee Go** for the Gitee repo and point it at **`.workflow/branch-pipeline.yml`**. That pipeline runs the same checks as GitHub CI (`npm ci --legacy-peer-deps`, `typecheck`, `test`, `build`). If `nodeVersion: 18.20.4` is not available in your Gitee tenant, change it in the Gitee UI or edit the YAML to a supported version.
- **Releases on Gitee:** [grinningGrace/second-brain-release → Releases](https://gitee.com/grinningGrace/second-brain-release/releases) hosts the same install zip as GitHub for users in China.
- **Mirror from GitHub (optional):** workflow **`.github/workflows/sync-gitee.yml`** runs after a **successful CI** run triggered by **`push`** to `main` or `master`, or when you run it manually (**Actions → Sync to Gitee → Run workflow**). Configure secrets `GITEE_REPO`, `GITEE_TOKEN`, and `GITEE_USERNAME` on GitHub. The job force-pushes the same branch name to Gitee (`main`→`main`, `master`→`master`); keep default branch names aligned on both hosts or adjust the workflow. If secrets are missing, the job skips the push and still succeeds.
