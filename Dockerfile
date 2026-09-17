FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-fund --no-audit
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/src ./src
COPY web/public ./public
RUN npm run build

FROM golang:1.27.1@sha256:f44f6e88636cfb311f9ebace870ded69d943f227bb3cb27d32ffd84ea18c43ea AS build
ARG VERSION=development
ARG REVISION=unknown
ARG BUILT_AT=unknown
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY pkg ./pkg
COPY contracts/embed.go ./contracts/embed.go
COPY contracts/schemas ./contracts/schemas
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X github.com/JavaWeh/ACCP/internal/buildinfo.Version=$VERSION -X github.com/JavaWeh/ACCP/internal/buildinfo.Revision=$REVISION -X github.com/JavaWeh/ACCP/internal/buildinfo.BuiltAt=$BUILT_AT" -o /out/accp ./cmd/accp
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X github.com/JavaWeh/ACCP/internal/buildinfo.Version=$VERSION -X github.com/JavaWeh/ACCP/internal/buildinfo.Revision=$REVISION -X github.com/JavaWeh/ACCP/internal/buildinfo.BuiltAt=$BUILT_AT" -o /out/accp-bridge ./cmd/accp-bridge

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/accp /accp
COPY --from=build /out/accp-bridge /accp-bridge
COPY --from=web /web/dist /web
ENV ACCP_WEB_DIR=/web
COPY LICENSE /LICENSE
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/accp"]
CMD ["serve"]
