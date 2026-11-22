package piplugins

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"server/internal/pkg"

	"github.com/Masterminds/semver/v3"
	"github.com/gin-gonic/gin"
)

const (
	officialCatalog = "https://plugins.aiuo.net/catalog.json"
	githubMirror    = "https://raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main/catalog.json"
	cnbMirror       = "https://cnb.cool/aixk/pi-desktop-plugins/-/git/raw/main/catalog.json"
	maxCatalogSize  = 12 << 20
)

type marketCatalog struct {
	SchemaVersion int           `json:"schemaVersion"`
	ArtifactBase  string        `json:"artifactBaseUrl"`
	Plugins       []marketEntry `json:"plugins"`
	source        string
	updatedAt     time.Time
}

type marketCache struct {
	Source  string          `json:"source"`
	Fetched time.Time       `json:"fetched"`
	Catalog json.RawMessage `json:"catalog"`
}

type marketEntry struct {
	ID          string                       `json:"id"`
	Name        string                       `json:"name"`
	Description string                       `json:"description"`
	Author      string                       `json:"author"`
	I18n        map[string]pluginTranslation `json:"i18n"`
	Homepage    string                       `json:"homepage"`
	Repository  string                       `json:"repository"`
	SafetyNotes string                       `json:"safetyNotes"`
	Readme      string                       `json:"readmeMarkdown"`
	Categories  []string                     `json:"categories"`
	Verified    bool                         `json:"verified"`
	Versions    []marketVersion              `json:"versions"`
}

type marketVersion struct {
	Version     string   `json:"version"`
	SHA256      string   `json:"shasum"`
	URL         string   `json:"url"`
	Size        int64    `json:"sizeBytes"`
	Permissions []string `json:"permissions"`
	Yanked      bool     `json:"yanked"`
}

type marketplacePlugin struct {
	Plugin
	Versions   []string `json:"versions"`
	Categories []string `json:"categories"`
	Verified   bool     `json:"verified"`
	Readme     string   `json:"readme_markdown,omitempty"`
}

func marketURLAllowed(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "plugins.aiuo.net", "github.com", "raw.githubusercontent.com", "objects.githubusercontent.com",
		"release-assets.githubusercontent.com", "codeload.github.com", "cnb.cool":
		return true
	default:
		return false
	}
}

func marketClient() *http.Client {
	return &http.Client{
		Timeout: 22 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 5 || !marketURLAllowed(req.URL) {
				return errors.New("插件市场下载重定向不受信任")
			}
			return nil
		},
	}
}

func (m *Module) fetchMarket(ctx context.Context, destination *url.URL, limit int64) ([]byte, error) {
	if !marketURLAllowed(destination) {
		return nil, errors.New("插件市场地址不受信任")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, destination.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.ContentLength > limit {
		return nil, errors.New("插件市场未返回可用数据")
	}
	return readLimited(resp.Body, limit)
}

func parseCatalog(data []byte, source string, updatedAt time.Time) (*marketCatalog, error) {
	out := &marketCatalog{source: source, updatedAt: updatedAt}
	if err := json.Unmarshal(data, out); err != nil || (out.SchemaVersion != 1 && out.SchemaVersion != 2) ||
		len(out.Plugins) == 0 || len(out.Plugins) > 2500 {
		return nil, errors.New("插件市场目录格式无效")
	}
	return out, nil
}

func (m *Module) market(ctx context.Context, refresh bool) (*marketCatalog, error) {
	m.marketMu.Lock()
	defer m.marketMu.Unlock()
	if m.catalog == nil {
		m.catalog = m.readCachedMarket()
	}
	if m.catalog != nil && !refresh && time.Since(m.catalog.updatedAt) < 5*time.Minute {
		return m.catalog, nil
	}
	for _, source := range []string{officialCatalog, githubMirror, cnbMirror} {
		if ctx.Err() != nil {
			break
		}
		location, _ := url.Parse(source)
		request, cancel := context.WithTimeout(ctx, 12*time.Second)
		data, err := m.fetchMarket(request, location, maxCatalogSize)
		cancel()
		if err != nil {
			continue
		}
		now := time.Now().UTC()
		catalog, err := parseCatalog(data, source, now)
		if err == nil {
			m.catalog = catalog
			cached, err := json.Marshal(marketCache{Source: source, Fetched: now, Catalog: data})
			if err == nil {
				_ = atomicWrite(m.root, "market.json", cached)
			}
			return catalog, nil
		}
	}
	if m.catalog != nil {
		return m.catalog, nil
	}
	return nil, errors.New("无法连接 PI-Desktop 官方插件市场")
}

func (m *Module) readCachedMarket() *marketCatalog {
	file, err := os.Open(filepath.Join(m.root, "market.json"))
	if err != nil {
		return nil
	}
	defer file.Close()
	raw, err := readLimited(file, maxCatalogSize+(1<<20))
	if err != nil {
		return nil
	}
	var cache marketCache
	if json.Unmarshal(raw, &cache) != nil ||
		(cache.Source != officialCatalog && cache.Source != githubMirror && cache.Source != cnbMirror) {
		return nil
	}
	catalog, _ := parseCatalog(cache.Catalog, cache.Source, cache.Fetched)
	return catalog
}

func (entry marketEntry) releases() []marketVersion {
	type parsedRelease struct {
		value   marketVersion
		version *semver.Version
	}
	parsed := make([]parsedRelease, 0, len(entry.Versions))
	for _, version := range entry.Versions {
		number, err := semver.StrictNewVersion(version.Version)
		if err == nil && !version.Yanked {
			parsed = append(parsed, parsedRelease{value: version, version: number})
		}
	}
	slices.SortStableFunc(parsed, func(a, b parsedRelease) int { return b.version.Compare(a.version) })
	versions := make([]marketVersion, 0, len(parsed))
	seen := make(map[string]bool)
	for _, version := range parsed {
		if !seen[version.value.Version] {
			versions = append(versions, version.value)
			seen[version.value.Version] = true
		}
	}
	return versions
}

func (v marketVersion) installable() bool {
	hash, err := hex.DecodeString(v.SHA256)
	return err == nil && len(hash) == sha256.Size && v.URL != "" && v.Size > 0 && v.Size <= maxPackageSize
}

func (catalog *marketCatalog) packageURLs(version marketVersion) []*url.URL {
	location, _ := url.Parse(catalog.source)
	base := location
	if catalog.ArtifactBase != "" {
		base = referenceURL(location, strings.TrimRight(catalog.ArtifactBase, "/")+"/")
	}
	result := make([]*url.URL, 0, 3)
	if base != nil {
		result = append(result, referenceURL(base, version.URL))
	}
	relative, err := url.Parse(version.URL)
	if err == nil && !relative.IsAbs() && relative.Host == "" &&
		strings.HasPrefix(strings.TrimLeft(relative.Path, "/"), "packages/") {
		for _, source := range []string{cnbMirror, githubMirror} {
			if source != catalog.source {
				mirror, _ := url.Parse(source)
				result = append(result, referenceURL(mirror, strings.TrimLeft(version.URL, "/")))
			}
		}
	}
	return result
}

func (m *Module) marketplace(c *gin.Context) {
	catalog, err := m.market(c.Request.Context(), c.Query("refresh") == "true")
	if err != nil {
		pkg.Fail(c, 502, err.Error())
		return
	}
	out := make([]marketplacePlugin, 0, len(catalog.Plugins))
	for _, entry := range catalog.Plugins {
		if !validPluginID(entry.ID) {
			continue
		}
		name, description, safety := localize(entry.Name, entry.Description, entry.SafetyNotes, entry.I18n)
		item := marketplacePlugin{
			Plugin: Plugin{ID: entry.ID, Name: name, Description: description, SafetyNotes: safety,
				Author: entry.Author, Homepage: safeDisplayURL(entry.Homepage), Repository: safeDisplayURL(entry.Repository),
				Permissions: []string{}, Contributions: []string{}, Supported: []string{}, Source: "marketplace"},
			Versions: []string{}, Categories: append([]string{}, entry.Categories...), Verified: entry.Verified, Readme: entry.Readme,
		}
		for _, version := range entry.releases() {
			if item.Version == "" {
				item.Version = version.Version
				item.Permissions = append(item.Permissions, version.Permissions...)
			}
			if version.installable() && slices.ContainsFunc(catalog.packageURLs(version), marketURLAllowed) {
				item.Versions = append(item.Versions, version.Version)
			}
		}
		out = append(out, item)
	}
	pkg.OK(c, out)
}

func (m *Module) installMarket(c *gin.Context) {
	id := c.Param("id")
	body := struct {
		Version string `json:"version"`
	}{}
	if !validPluginID(id) || (c.ShouldBindJSON(&body) != nil && c.Request.ContentLength != 0) {
		pkg.Fail(c, 400, "请选择有效的插件与版本")
		return
	}
	if _, builtin := bundledPlugin(id); builtin {
		pkg.Fail(c, 409, "内置插件随 Live2D Studio 更新")
		return
	}
	ctx := c.Request.Context()
	catalog, err := m.market(ctx, false)
	if err != nil {
		pkg.Fail(c, 502, err.Error())
		return
	}
	var chosen marketVersion
	for _, entry := range catalog.Plugins {
		if entry.ID != id {
			continue
		}
		for _, release := range entry.releases() {
			if (body.Version == "" || body.Version == release.Version) && release.installable() {
				chosen = release
				break
			}
		}
		break
	}
	if chosen.Version == "" {
		pkg.Fail(c, 404, "所选插件版本没有可验证的安装包")
		return
	}
	var contents []byte
	for _, target := range catalog.packageURLs(chosen) {
		contents, err = m.fetchMarket(ctx, target, chosen.Size)
		if err != nil {
			continue
		}
		hash := sha256.Sum256(contents)
		if int64(len(contents)) == chosen.Size && strings.EqualFold(hex.EncodeToString(hash[:]), chosen.SHA256) {
			plugin, err := m.install(contents, "marketplace", id, chosen.Version)
			if err != nil {
				pkg.Fail(c, 400, err.Error())
				return
			}
			pkg.OK(c, plugin)
			return
		}
	}
	pkg.Fail(c, 502, "插件下载失败或与市场校验信息不符")
}
