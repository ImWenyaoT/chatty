.PHONY: setup check test backend-test web-install web-check web-build web-dev api-dev dev

ROOT := $(CURDIR)

setup: web-install
	cd backend && go mod download

web-install:
	cd web && pnpm install

backend-test:
	cd backend && go test ./...

web-check:
	cd web && pnpm run typecheck && pnpm run build

web-build:
	cd web && pnpm run build

test: backend-test

check: backend-test web-check

api-dev:
	cd backend && CHATTY_ROOT=$(ROOT) go run ./cmd/chatty

web-dev:
	cd web && pnpm dev

# 同时起 API 与 Vite；Ctrl+C 结束当前 shell 内的子进程。
dev:
	@bash -c 'set -e; \
	  trap "kill 0" EXIT INT TERM; \
	  CHATTY_ROOT="$(ROOT)" go run ./backend/cmd/chatty & \
	  (cd web && pnpm dev) & \
	  wait'
