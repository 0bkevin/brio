ifneq (,$(wildcard .env))
include .env
export
endif

BRIO_ADDR ?= 127.0.0.1:8787
BRIO_RELAY_ADDR ?= 127.0.0.1:8082
BRIO_RELAY_URL ?= http://127.0.0.1:8082
BRIO_AGENT_ID ?= local-brio
HERMES_API_BASE ?= http://127.0.0.1:8642
WEB_EXPORT_DIR ?= /tmp/brio-web-export

GO_PACKAGES := ./apps/companion/... ./apps/relay/...
MOBILE_DIR := apps/mobile

.PHONY: help setup check test-go lint-mobile typecheck-mobile export-mobile dev-mobile dev-companion dev-relay dev-companion-relay tidy

help:
	@printf "Brio setup commands:\n"
	@printf "  make setup                Install dependencies for all apps\n"
	@printf "  make check                Run Go tests and mobile validation\n"
	@printf "  make dev-companion        Start the local companion on %s\n" "$(BRIO_ADDR)"
	@printf "  make dev-mobile           Start Expo web locally\n"
	@printf "  make dev-relay            Start the relay on %s\n" "$(BRIO_RELAY_ADDR)"
	@printf "  make dev-companion-relay  Start companion connected to %s\n" "$(BRIO_RELAY_URL)"

setup:
	go work sync
	cd apps/companion && go mod download
	cd apps/relay && go mod download
	cd $(MOBILE_DIR) && npm ci

check: test-go lint-mobile typecheck-mobile export-mobile

test-go:
	go test $(GO_PACKAGES)

lint-mobile:
	cd $(MOBILE_DIR) && npm run lint

typecheck-mobile:
	cd $(MOBILE_DIR) && npm run typecheck

export-mobile:
	rm -rf "$(WEB_EXPORT_DIR)"
	cd $(MOBILE_DIR) && npm run export:web -- --output-dir "$(WEB_EXPORT_DIR)"

dev-mobile:
	cd $(MOBILE_DIR) && npm run web -- --localhost

dev-companion:
	cd apps/companion && go run . companion run --addr "$(BRIO_ADDR)" --hermes-url "$(HERMES_API_BASE)"

dev-relay:
	cd apps/relay && go run . serve --addr "$(BRIO_RELAY_ADDR)"

dev-companion-relay:
	cd apps/companion && go run . companion run --addr "$(BRIO_ADDR)" --hermes-url "$(HERMES_API_BASE)" --relay-url "$(BRIO_RELAY_URL)" --agent-id "$(BRIO_AGENT_ID)"

tidy:
	cd apps/companion && go mod tidy
	cd apps/relay && go mod tidy
