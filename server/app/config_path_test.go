// 本文件覆盖配置路径解析：发布版数据根目录稳定、go run 回退源码目录、
// 显式 -config 优先，以及候选目录全不存在时的兜底路径。

package app

import (
	"path/filepath"
	"testing"
)

// TestPackagedConfigIndependentOfWorkingDirectory 校验发布版无论从哪个工作目录
// 启动，都选中可执行文件旁的 configs。
func TestPackagedConfigIndependentOfWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	bin := filepath.Join(workspace, "bin")
	executable := filepath.Join(bin, "Live2DStudio.exe")
	// 依据目录是否存在而非 config.yaml 来选择数据根：首次启动同样需要在
	// 可执行文件旁创建配置与设置。
	directories := map[string]bool{
		filepath.Join(bin, "configs"):                 true,
		filepath.Join(workspace, "server", "configs"): true,
	}
	exists := func(dir string) bool { return directories[dir] }
	for _, cwd := range []string{workspace, filepath.Join(workspace, "server"), bin, root} {
		got := configPathFor("", executable, cwd, exists)
		if want := filepath.Join(bin, "configs", "config.yaml"); got != want {
			t.Errorf("cwd %s selected %s, want %s", cwd, got, want)
		}
		if dataRoot := filepath.Dir(filepath.Dir(got)); dataRoot != bin {
			t.Errorf("packaged data root changed to %s", dataRoot)
		}
	}
}

// TestGoRunConfigFallsBackToSourceDirectories 校验 go run（可执行文件位于临时
// 构建目录）时回退到 server/configs。
func TestGoRunConfigFallsBackToSourceDirectories(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	executable := filepath.Join(root, "go-build", "exe", "api")
	server := filepath.Join(workspace, "server")
	exists := func(dir string) bool { return dir == filepath.Join(server, "configs") }
	for _, cwd := range []string{workspace, server} {
		got := configPathFor("", executable, cwd, exists)
		if want := filepath.Join(server, "configs", "config.yaml"); got != want {
			t.Errorf("go run from %s selected %s, want %s", cwd, got, want)
		}
	}
}

// TestExplicitConfigWinsOverPackagedConfig 校验显式 -config 完全跳过自动目录
// 探测，相对路径基于工作目录展开。
func TestExplicitConfigWinsOverPackagedConfig(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "working")
	executable := filepath.Join(root, "bin", "Live2DStudio.exe")
	for _, explicit := range []string{filepath.Join(root, "custom", "config.yaml"), filepath.Join("custom", "config.yaml")} {
		got := configPathFor(explicit, executable, cwd, func(string) bool {
			t.Fatal("explicit config must skip automatic directory selection")
			return false
		})
		want := explicit
		if !filepath.IsAbs(explicit) {
			want = filepath.Join(cwd, explicit)
		}
		if got != want {
			t.Errorf("explicit config resolved to %s, want %s", got, want)
		}
	}
}

// TestConfigFallbackAnchoredToExecutable 校验所有候选目录都不存在时，
// 兜底路径仍锚定可执行文件旁。
func TestConfigFallbackAnchoredToExecutable(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "bin", "Live2DStudio.exe")
	got := configPathFor("", executable, filepath.Join(root, "unrelated"), func(string) bool { return false })
	if want := filepath.Join(root, "bin", "configs", "config.yaml"); got != want {
		t.Fatalf("fallback %s, want %s", got, want)
	}
}
