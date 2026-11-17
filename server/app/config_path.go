// 本文件负责定位配置文件：显式 -config 优先，否则依次在可执行文件旁、
// 工作目录及其 server 子目录中查找 configs 目录。解析结果同时决定数据目录，
// 因此与进程工作目录无关。

package app

import (
	"fmt"
	"os"
	"path/filepath"
)

// resolveConfigPath 把命令行参数与运行位置转换为绝对配置路径。
// 可执行文件与工作目录只读取一次，目录探测函数注入给 configPathFor 便于测试。
func resolveConfigPath(explicit string) (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("读取程序位置: %w", err)
	}
	workingDir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("读取工作目录: %w", err)
	}
	return configPathFor(explicit, executable, workingDir, func(dir string) bool {
		info, err := os.Stat(dir)
		return err == nil && info.IsDir()
	}), nil
}

// configPathFor 让发布后的可执行文件拥有稳定的配置/数据根目录。
//
// 查找优先级：显式 -config（相对路径基于工作目录）→ 可执行文件旁 configs →
// 工作目录 configs → 工作目录 server/configs → 兜底返回可执行文件旁路径。
// Wails 开发构建会把可执行文件放在 .wails/dev 下，因此开发时仍需回退到
// server/ 源码目录。判定依据是 configs 目录是否存在而非 config.yaml，
// 因为首次启动还没有配置文件，但数据目录应落在可执行文件旁边。
// 所有返回值均为绝对路径；可执行文件、工作目录与目录探测函数都可注入，便于测试。
func configPathFor(explicit, executable, workingDir string, directoryExists func(string) bool) string {
	if explicit != "" {
		if filepath.IsAbs(explicit) {
			return filepath.Clean(explicit)
		}
		return filepath.Join(workingDir, explicit)
	}
	packaged := filepath.Join(filepath.Dir(executable), "configs", "config.yaml")
	for _, candidate := range []string{
		packaged,
		filepath.Join(workingDir, "configs", "config.yaml"),
		filepath.Join(workingDir, "server", "configs", "config.yaml"),
	} {
		if directoryExists(filepath.Dir(candidate)) {
			return candidate
		}
	}
	return packaged
}
