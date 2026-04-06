# Stage 1: Build
FROM golang:1.23-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /build

COPY go.mod go.sum* ./
COPY . .

RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s -X main.Version=$(date +%Y%m%d)" \
    -o nexus-agent \
    ./cmd/nexus-agent/

# Stage 2: Minimal runtime
FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY --from=builder /build/nexus-agent /usr/local/bin/nexus-agent

RUN adduser -D nexus
USER nexus

ENTRYPOINT ["/usr/local/bin/nexus-agent"]
