FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /src
COPY go.mod go.sum ./
COPY server/go.mod server/go.sum ./server/
RUN go mod download
COPY main.go ./
COPY server/ ./server/
COPY --from=frontend /src/server/internal/webui/dist ./server/internal/webui/dist
RUN CGO_ENABLED=0 go build -tags headless -trimpath -ldflags='-s -w' -o /studio .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 studio
WORKDIR /app
COPY --from=backend /studio /app/studio
COPY server/configs/config.example.yaml /app/configs/config.example.yaml
RUN mkdir /app/data && chown -R studio:studio /app
USER studio
ENV STUDIO_HOST=127.0.0.1 TZ=Asia/Shanghai
VOLUME ["/app/data"]
ENTRYPOINT ["/app/studio", "-headless"]
