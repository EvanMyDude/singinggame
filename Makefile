.DEFAULT_GOAL := help
.PHONY: help install dev build preview test typecheck check clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

dev: ## Run the dev server (open http://localhost:5173)
	npm run dev

build: ## Type-check and build static files into dist/
	npm run build

preview: ## Serve the production build locally
	npm run preview

test: ## Run unit tests
	npm test

typecheck: ## Type-check without emitting
	npm run typecheck

check: typecheck test ## Type-check and run tests

clean: ## Remove build output
	rm -rf dist
