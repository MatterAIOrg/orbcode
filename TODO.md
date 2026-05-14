# OSS Release — Pending Items

Tracking work to make this repo open-source-ready for the `/plugin marketplace add` flow.

## Done

- [x] `LICENSE` (MIT)
- [x] `.gitignore`
- [x] `CONTRIBUTING.md`
- [x] Marketplace name aligned in `.claude-plugin/marketplace.json` and `README.md` (`matterai-marketplace`)

## Pending

- [ ] `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1
- [ ] `SECURITY.md` — vulnerability disclosure policy + contact (`support@matterai.so`)
- [ ] `CHANGELOG.md` — Keep-a-Changelog format, seeded with `0.1.0`
- [ ] `.github/ISSUE_TEMPLATE/bug_report.yml`
- [ ] `.github/ISSUE_TEMPLATE/feature_request.yml`
- [ ] `.github/ISSUE_TEMPLATE/config.yml` — disable blank issues, link to discussions/support
- [ ] `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] `.github/workflows/ci.yml` — Node lint + smoke (syntax check on `scripts/*.js`)
- [ ] `.github/FUNDING.yml` — optional, skip unless wanted
- [ ] `package.json` — flesh out: `name`, `version`, `description`, `repository`, `bugs`, `homepage`, `license`, `author`, `engines.node`, `keywords`
- [ ] `README.md` — add badges (license, Node version, marketplace install), Contributing/Security/License sections, link to CHANGELOG
- [ ] Create the GitHub repo at `MatterAIOrg/orbcode` and push

## Optional polish

- [ ] `.editorconfig`
- [ ] `.nvmrc` pinning Node 20
- [ ] Repo topics on GitHub: `claude-code`, `claude-code-plugin`, `anthropic`, `mcp`
- [ ] GitHub repo "About" description + homepage URL
- [ ] Release `v0.1.0` tag + GitHub Release notes

## Pre-push verification

- [ ] Confirm `scripts/orb-mcp.js` runs (`node scripts/orb-mcp.js`)
- [ ] Confirm every command referenced in `README.md` has a matching `skills/<name>/` entry
- [ ] Confirm no secrets, tokens, or `.claude/settings.local.json` content is staged
