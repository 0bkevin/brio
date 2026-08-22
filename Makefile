ifneq (,$(wildcard .env))
include .env
export
endif

BRIO_RELAY_ADDR ?= 127.0.0.1:8082
HERMES_CONTROL_BASE ?= http://127.0.0.1:9119
WEB_EXPORT_DIR ?= /tmp/brio-web-export

GO_PACKAGES := ./apps/connect/... ./apps/relay/...
MOBILE_DIR := apps/mobile

.PHONY: help setup check check-static test-go lint-mobile typecheck-mobile test-mobile export-mobile dev-mobile dev-relay dev-connect tidy

help:
	@printf "Brio setup commands:\n"
	@printf "  make setup        Install dependencies for the connector, relay, and mobile app\n"
	@printf "  make check        Run Go tests and mobile validation\n"
	@printf "  make dev-mobile   Start Expo web locally\n"
	@printf "  make dev-relay    Start the relay on %s\n" "$(BRIO_RELAY_ADDR)"
	@printf "  make dev-connect  Start the brio connector in the foreground\n"

setup:
	go work sync
	cd apps/connect && go mod download
	cd apps/relay && go mod download
	cd $(MOBILE_DIR) && npm ci

check: check-static test-go lint-mobile typecheck-mobile test-mobile export-mobile

check-static:
	sh -n scripts/install.sh
	sh scripts/install_test.sh
	jq empty packages/protocol/agent-connection.schema.json packages/protocol/tunnel-frame.schema.json

test-go:
	go test $(GO_PACKAGES)

lint-mobile:
	cd $(MOBILE_DIR) && npm run lint

typecheck-mobile:
	cd $(MOBILE_DIR) && npm run typecheck

test-mobile:
	cd $(MOBILE_DIR) && npm test

export-mobile:
	rm -rf "$(WEB_EXPORT_DIR)"
	cd $(MOBILE_DIR) && npm run export:web -- --output-dir "$(WEB_EXPORT_DIR)"

dev-mobile:
	cd $(MOBILE_DIR) && npm run web -- --localhost

dev-relay:
	cd apps/relay && go run . serve --addr "$(BRIO_RELAY_ADDR)"

dev-connect:
	cd apps/connect && go run . connect

tidy:
	cd apps/connect && go mod tidy
	cd apps/relay && go mod tidy
