# smterm — task runner
# Run `make` or `make help` to see available targets.

.ONESHELL:
SHELL := /bin/bash
.DEFAULT_GOAL := help

## ─────────────────────────────── Setup ───────────────────────────────

.PHONY: install
install: ## Install deps, rebuild native modules, activate git hooks
	npm install
	npx electron-rebuild -f -o node-pty
	npx lefthook install || echo "run 'npm i -D lefthook' to enable git hooks"

## ─────────────────────────────── Run ─────────────────────────────────

.PHONY: run
run: ## Run the app in dev mode, dev profile (SMTERM_PROFILE=<name> for another)
	npm run dev

.PHONY: dev
dev: run ## Alias for `run`

.PHONY: build
build: ## Build the app (electron-vite)
	npm run build

.PHONY: dist
dist: ## Package installable artifacts for this OS (ad-hoc signed; .dmg/.zip on mac)
	npm run dist

.PHONY: release
release: ## Cut a release: bump version + tag + push (BUMP=patch|minor|major, default patch)
	npm version $(or $(BUMP),patch) -m "release: v%s"
	git push --follow-tags
	@echo "Pushed tag — the Release workflow will build + publish installers."

## ─────────────────────────────── Lint ────────────────────────────────

.PHONY: lint
lint: ## Lint: tsc (renderer + electron) + eslint + prettier check
	npm run typecheck
	npm run lint
	npm run format:check

## ─────────────────────────────── Format ──────────────────────────────

.PHONY: fmt
fmt: ## Auto-format (eslint --fix + prettier)
	npm run lint:fix
	npm run format

## ─────────────────────────────── Test ────────────────────────────────

.PHONY: test
test: ## Run tests (Vitest)
	npm run test

.PHONY: coverage
coverage: ## Coverage report
	npm run test:coverage

## ─────────────────────────────── Gates ───────────────────────────────

.PHONY: check
check: lint test ## Do all: lint + test (the pre-merge gate)

.PHONY: ci
ci: check build ## Full local CI: lint + test + build

.PHONY: audit
audit: ## Security audit of dependencies
	npm audit --omit=dev || true

## ─────────────────────────────── Misc ────────────────────────────────

.PHONY: hooks
hooks: ## Install/refresh git hooks (lefthook)
	npx lefthook install

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf out dist coverage

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
