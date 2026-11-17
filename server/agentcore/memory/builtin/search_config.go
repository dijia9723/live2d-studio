package builtin

import (
	builtinsearch "agentp/memory/builtin/search"

	"github.com/cloudwego/eino/components/embedding"
)

type HybridConfig = builtinsearch.HybridConfig

type SearchConfig struct {
	Mode        builtinsearch.SearchMode
	Embedder    embedding.Embedder
	VectorStore builtinsearch.VectorStore
	Hybrid      HybridConfig
	AsyncIndex  bool
}
