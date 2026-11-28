// git.go 负责读取项目的 Git 变更状态与差异，并限制仓库自定义过滤器。
package coding

import (
	"context"
	"io"
	"os/exec"
	"strings"
	"time"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

// gitOutput 在固定超时内执行只读 Git 命令并截取输出，避免仓库过大或钩子卡住请求。
func gitOutput(ctx context.Context, dir string, args ...string) (string, bool, bool) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	base := []string{"--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"}
	cmd := exec.CommandContext(ctx, "git", append(base, args...)...)
	cmd.Dir = dir
	hideWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return "", false, false
	}
	const maxOutput = 256 << 10
	data, err := io.ReadAll(io.LimitReader(stdout, maxOutput+1))
	if len(data) > maxOutput {
		cancel()
		_ = cmd.Wait()
		return string(data[:maxOutput]) + "\n… 输出已截取", true, true
	}
	waitErr := cmd.Wait()
	return string(data), err == nil && waitErr == nil, false
}

// gitReadOptions 关闭仓库自定义的 clean/process 过滤器，防止比较差异时执行项目配置的任意命令。
func gitReadOptions(ctx context.Context, dir string) ([]string, bool) {
	keys, ok, truncated := gitOutput(ctx, dir, "config", "--null", "--name-only", "--list", "--includes")
	if !ok || truncated {
		return nil, false
	}
	flags := []string{"-c", "submodule.recurse=false"}
	filters := make(map[string]struct{})
	for key := range strings.SplitSeq(keys, "\x00") {
		if !strings.HasPrefix(key, "filter.") {
			continue
		}
		end := strings.LastIndexByte(key, '.')
		if end <= len("filter.") || (key[end+1:] != "clean" && key[end+1:] != "process") {
			continue
		}
		name := key[:end]
		if _, exists := filters[name]; !exists {
			filters[name] = struct{}{}
			flags = append(flags, "-c", name+".clean=", "-c", name+".process=", "-c", name+".required=false")
		}
	}
	return flags, true
}

func (m *Module) changes(c *gin.Context) {
	project, ok := m.project(c, c.Param("project"))
	if !ok {
		return
	}
	ctx := c.Request.Context()
	flags, ok := gitReadOptions(ctx, project.Path)
	if !ok {
		pkg.OK(c, gin.H{"available": false, "status": "", "diff": ""})
		return
	}
	status, available, _ := gitOutput(ctx, project.Path, append(flags, "status", "--short", "--untracked-files=all", "--ignore-submodules=all", "--", ".")...)
	changes := gin.H{"available": available, "status": status, "diff": ""}
	if available {
		diffFlags := append(flags, "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all")
		diff, ok, _ := gitOutput(ctx, project.Path, append(diffFlags, "HEAD", "--", ".")...)
		if !ok {
			diff, _, _ = gitOutput(ctx, project.Path, append(diffFlags, "--cached", "--", ".")...)
		}
		changes["diff"] = diff
	}
	pkg.OK(c, changes)
}
