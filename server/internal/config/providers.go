// 本文件定义各模型服务尚未保存时使用的初始配置。
package config

// LLMProviderDefaults 只在服务尚未保存时提供预设，所有服务的生成参数均由后端统一定义。
func LLMProviderDefaults(provider string) (LLM, bool) {
	v := Defaults().LLM
	v.Provider = provider
	switch provider {
	case "openai":
	case "deepseek":
		v.BaseURL, v.Model = "https://api.deepseek.com/v1", "deepseek-chat"
	case "ollama":
		v.BaseURL, v.Model = "http://127.0.0.1:11434", ""
	case "lmstudio":
		v.BaseURL, v.Model = "http://localhost:1234/v1", "local-model"
	default:
		return LLM{}, false
	}
	return v, true
}
