// Package app 提供 Live2D Studio 的启动入口，供仓库根目录的 main.go 与
// 其他封装程序复用。原生桌面与 headless 的差异通过构建标签隔离。
package app

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"time"

	"server/internal/bootstrap"
	"server/internal/config"
)

func Run() {
	configPath := flag.String("config", "", "YAML 配置文件路径")
	headless := flag.Bool("headless", false, "只启动 Gin HTTP 服务")
	flag.Parse()
	resolvedConfig, err := resolveConfigPath(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	cfg, err := config.Load(resolvedConfig)
	if err != nil {
		log.Fatal(err)
	}
	app, err := bootstrap.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer app.Close()
	server, listener, err := app.Listen()
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	address := "http://" + listener.Addr().String()
	log.Printf("Live2D Studio: %s", address)
	if !*headless {
		if err = runDesktop(app, address); err != nil {
			log.Fatal(err)
		}
		return
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt)
	<-signals
}
