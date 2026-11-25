.PHONY: setup check test backend-test web-install web-check web-build web-dev api-dev dev smoke-browser

ROOT := $(CURDIR)

setup:
	pnpm install

web-install:
	pnpm --dir web install

backend-test:
	pnpm test

web-check:
	pnpm --dir web typecheck && pnpm --dir web build

web-build:
	pnpm --dir web build

test: backend-test

check:
	pnpm check

api-dev:
	pnpm dev:api

web-dev:
	pnpm --dir web dev

dev:
	pnpm dev

smoke-browser:
	pnpm smoke:browser
