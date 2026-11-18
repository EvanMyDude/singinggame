.DEFAULT_GOAL := help
.PHONY: help install dev build preview test typecheck check clean extract song-tools prepare-song test-tools parity analysis-fixtures

PY := $(if $(wildcard .venv/bin/python),.venv/bin/python,python3)

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

song-tools: ## Create .venv with the Python packages the song tools need (once)
	python3 -m venv .venv
	.venv/bin/pip install -r tools/requirements.txt

prepare-song: ## Build a song package from its audio: make prepare-song SONG=<id> [ARGS='--title "..." --artist "..."']
	@test -n "$(SONG)" || { echo 'usage: make prepare-song SONG=<folder name under public/songs> [ARGS="--title ... --artist ..."]'; exit 2; }
	$(PY) tools/prepare_song.py public/songs/$(SONG) $(ARGS)

parity: ## Compare the in-browser analysis with a song's committed targets on its own audio: make parity SONG=<id>
	@test -n "$(SONG)" || { echo 'usage: make parity SONG=<folder name under public/songs>'; exit 2; }
	$(PY) tools/decode_song.py public/songs/$(SONG) work/parity/$(SONG)
	PARITY_DIR=work/parity/$(SONG) MELODY_JSON=public/songs/$(SONG)/melody.json npx vitest run tests/browserParity.test.ts

analysis-fixtures: ## Regenerate the fixtures that check the browser analysis against the Python tools (needs make song-tools)
	$(PY) tests/make_analysis_fixtures.py

test-tools: ## Run the Python tool tests (the audio test needs make song-tools)
	$(PY) -m unittest discover -s tests -p 'test_*.py'

extract: ## Old Town Road only: rebuild its melody.json from instrumental + full mix (no isolated vocal)
	npm run extract
