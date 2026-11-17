.PHONY: run dev build test vet migrate swag
run:
	cd .. && go run .
dev:
	cd .. && go run -tags headless . -headless
build:
	cd ../frontend && npm ci && npm run build
	cd .. && go build -trimpath -o ../bin/live2d-studio .
test:
	go test -tags headless ./...
vet:
	go vet -tags headless ./...
migrate:
	@echo "SQLite schema migrations run automatically during bootstrap."
swag:
	@echo "API contract: docs/openapi.yaml"
