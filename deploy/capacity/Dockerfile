FROM golang:1.27.1@sha256:f44f6e88636cfb311f9ebace870ded69d943f227bb3cb27d32ffd84ea18c43ea AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY contracts ./contracts
COPY internal ./internal
COPY pkg ./pkg
COPY cmd/accp-bench ./cmd/accp-bench
RUN CGO_ENABLED=0 go build -trimpath -o /bench ./cmd/accp-bench
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
COPY --from=build /bench /bench
COPY deploy/capacity/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
