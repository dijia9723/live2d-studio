// Ollama 模型发现使用原生 /api/tags；生成回复仍复用 agentcore 的流式链路。
package settings

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"server/internal/config"
	"server/internal/pkg"
)

type ollamaModel struct {
	Name       string `json:"name"`
	Model      string `json:"model"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modified_at"`
	Details    struct {
		Family            string `json:"family"`
		ParameterSize     string `json:"parameter_size"`
		QuantizationLevel string `json:"quantization_level"`
	} `json:"details"`
}

func (m *Module) ollamaModels(c *gin.Context) {
	var input struct {
		BaseURL string `json:"base_url"`
	}
	if c.ShouldBindJSON(&input) != nil {
		pkg.Fail(c, 400, "模型列表请求格式无效")
		return
	}
	root, _, err := config.OllamaEndpoints(input.BaseURL)
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, root+"/api/tags", nil)
	if err != nil {
		pkg.Fail(c, 400, "Ollama 服务地址无效")
		return
	}
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		pkg.Fail(c, 502, "无法连接 Ollama，请确认服务已启动（ollama serve）并检查地址和端口")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		pkg.Fail(c, 502, fmt.Sprintf("Ollama 模型列表接口返回 %d，请检查服务地址是否指向 Ollama", response.StatusCode))
		return
	}
	const maxBody = 2 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	var payload struct {
		Models json.RawMessage `json:"models"`
	}
	models := []ollamaModel{}
	if err != nil || len(body) > maxBody || json.Unmarshal(body, &payload) != nil || len(payload.Models) == 0 || json.Unmarshal(payload.Models, &models) != nil {
		pkg.Fail(c, 502, "Ollama 返回的模型列表无效，请确认服务地址和 Ollama 版本")
		return
	}
	seen := map[string]bool{}
	result := make([]ollamaModel, 0, len(models))
	for _, item := range models {
		if item.Name == "" {
			item.Name = item.Model
		}
		if strings.TrimSpace(item.Name) != "" && !seen[item.Name] {
			seen[item.Name] = true
			result = append(result, item)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	pkg.OK(c, gin.H{"models": result})
}
