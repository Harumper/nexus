# Stage 1: Build
FROM golang:1.23-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /build

COPY go.mod go.sum* ./
COPY . .

# Version injected at build. The CI passes 0.1.0+<short-sha>; otherwise defaults to "dev".
ARG AGENT_VERSION=0.1.0+dev

# Deterministic deps: download against the committed go.sum, never mutate go.mod
# (unlike `go mod tidy`). `-mod=readonly` fails the build if go.mod is stale.
RUN go mod download
# Same reproducible flags as the CI release-build so `docker build` yields the
# same binary bytes: -trimpath (no absolute paths) + -mod=readonly.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -mod=readonly \
    -ldflags="-w -s -X main.Version=${AGENT_VERSION}" \
    -o nexus-agent \
    ./cmd/nexus-agent/

# Stage 2: Minimal runtime
FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY --from=builder /build/nexus-agent /usr/local/bin/nexus-agent

RUN adduser -D nexus
USER nexus

ENTRYPOINT ["/usr/local/bin/nexus-agent"]
