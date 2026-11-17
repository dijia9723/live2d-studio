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

// Run 解析启动参数并完成配置加载、服务装配与监听，随后进入桌面或 headless 模式运行。
//
// 启动顺序：解析 -config/-headless → 定位配置文件 → 加载配置 → 装配服务 →
// 监听端口 → 桌面模式交给 Wails 事件循环，headless 模式阻塞等待中断信号。
// 退出时先以 5 秒超时关闭 HTTP 服务，再由延迟调用关闭数据库连接。
func Run() {
	// -config 显式指定 YAML 配置；-headless 跳过 Wails 窗口，便于脚本或容器运行。
	configPath := flag.String("config", "", "YAML 配置文件路径")
	headless := flag.Bool("headless", false, "只启动 Gin HTTP 服务")
	flag.Parse()
	// 先解析配置路径：相对 DataDir 以配置文件位置为基准，与工作目录无关。
	resolvedConfig, err := resolveConfigPath(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	cfg, err := config.Load(resolvedConfig)
	if err != nil {
		log.Fatal(err)
	}
	// New 内部完成数据目录准备、SQLite 打开、迁移与路由装配。
	app, err := bootstrap.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer app.Close()
	server, listener, err := app.Listen()
	if err != nil {
		log.Fatal(err)
	}
	// 优雅关闭 HTTP 服务，给正在进行的 SSE 响应留出收尾时间。
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
