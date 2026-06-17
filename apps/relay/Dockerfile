# Build the Brio relay as a self-contained static binary.
# Build context is apps/relay (set Railway root directory to apps/relay).
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/brio-relay .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/brio-relay /usr/local/bin/brio-relay
# Railway routes external traffic to this port; relay binds it via BRIO_RELAY_ADDR.
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/brio-relay"]
CMD ["serve"]
