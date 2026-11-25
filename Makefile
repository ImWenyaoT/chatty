.PHONY: setup check test api-dev dev smoke-browser

setup:
	pnpm install

test:
	pnpm test

check:
	pnpm check

api-dev:
	pnpm dev:api

dev:
	pnpm dev

smoke-browser:
	pnpm smoke:browser
