FROM golang:1.27.1@sha256:f44f6e88636cfb311f9ebace870ded69d943f227bb3cb27d32ffd84ea18c43ea AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY pkg ./pkg
COPY contracts/embed.go ./contracts/embed.go
COPY contracts/schemas ./contracts/schemas
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/accp ./cmd/accp
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/accp-bridge ./cmd/accp-bridge

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/accp /accp
COPY --from=build /out/accp-bridge /accp-bridge
COPY LICENSE /LICENSE
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/accp"]
CMD ["serve"]
