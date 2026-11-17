//go:build headless

// 本文件为 headless 构建提供 runDesktop 桩实现，此时只允许以 -headless 方式运行。

package app

import (
	"fmt"
	"server/internal/bootstrap"
)

// runDesktop 在 headless 构建中不可用，被调用即返回错误提示。
func runDesktop(_ *bootstrap.App, _ string) error {
	return fmt.Errorf("此程序使用 headless 构建，请加上 -headless 参数")
}
