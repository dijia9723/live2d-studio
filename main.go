// Live2D Studio 的唯一程序入口。业务实现位于 server/ 模块，app.Run 负责装配
// Gin 服务与 Wails 桌面窗口；使用 -tags headless 可构建无窗口版本。
package main

import "server/app"

func main() {
	app.Run()
}
