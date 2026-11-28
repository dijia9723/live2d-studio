module server

go 1.26.4

require (
	agentp v0.3.3
	github.com/cloudwego/eino v0.9.22
	github.com/cloudwego/eino-ext/components/model/agenticopenai v0.2.2
	github.com/cloudwego/eino-ext/components/model/openai v0.1.13
	github.com/coder/websocket v1.8.14
	github.com/creack/pty v1.1.24
	github.com/gin-gonic/gin v1.11.0
	github.com/glebarez/sqlite v1.11.0
	github.com/google/uuid v1.6.0
	github.com/jwwsjlm/douyinLive/v2 v2.0.25
	github.com/jwwsjlm/douyinlive-proto v0.1.2
	github.com/kbinani/screenshot v0.0.0-20250624051815-089614a94018
	github.com/lxn/win v0.0.0-20210218163916-a377121e959e
	github.com/meguminnnnnnnnn/go-openai v0.1.2
	github.com/wailsapp/wails/v3 v3.1.0
	golang.org/x/sys v0.48.0
	google.golang.org/protobuf v1.36.11
	gopkg.in/yaml.v3 v3.0.1
	gorm.io/gorm v1.31.1
)

replace agentp => ./agentcore

require (
	github.com/Azure/azure-sdk-for-go/sdk/azcore v1.17.0 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/internal v1.10.0 // indirect
	github.com/Danny-Dasilva/CycleTLS/cycletls v1.0.30 // indirect
	github.com/Danny-Dasilva/fhttp v0.0.0-20260106165651-41258808b131 // indirect
	github.com/Masterminds/semver/v3 v3.5.0 // indirect
	github.com/andybalholm/brotli v1.2.2 // indirect
	github.com/bahlo/generic-list-go v0.2.0 // indirect
	github.com/buger/jsonparser v1.1.1 // indirect
	github.com/bytedance/gopkg v0.1.3 // indirect
	github.com/bytedance/sonic v1.15.0 // indirect
	github.com/bytedance/sonic/loader v0.5.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/cloudwego/base64x v0.1.6 // indirect
	github.com/cloudwego/eino-ext/libs/acl/openai v0.1.18-0.20260527084435-846f52bd97c6 // indirect
	github.com/codeGROOVE-dev/retry v1.3.1 // indirect
	github.com/dgraph-io/ristretto/v2 v2.4.2 // indirect
	github.com/dlclark/regexp2/v2 v2.2.2 // indirect
	github.com/dop251/goja v0.0.0-20260701091749-b07b74453ea9 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/ebitengine/purego v0.11.1 // indirect
	github.com/eino-contrib/jsonschema v1.0.3 // indirect
	github.com/elliotchance/orderedmap v1.8.0 // indirect
	github.com/evanphx/json-patch v4.12.0+incompatible // indirect
	github.com/gabriel-vasile/mimetype v1.4.8 // indirect
	github.com/gaukas/clienthellod v0.4.2 // indirect
	github.com/gaukas/godicttls v0.0.4 // indirect
	github.com/gen2brain/shm v0.1.0 // indirect
	github.com/gin-contrib/sse v1.1.0 // indirect
	github.com/glebarez/go-sqlite v1.21.2 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/go-playground/locales v0.14.1 // indirect
	github.com/go-playground/universal-translator v0.18.1 // indirect
	github.com/go-playground/validator/v10 v10.27.0 // indirect
	github.com/go-sourcemap/sourcemap v2.1.4+incompatible // indirect
	github.com/go-task/slim-sprig/v3 v3.0.0 // indirect
	github.com/go-viper/mapstructure/v2 v2.5.0 // indirect
	github.com/goccy/go-json v0.10.2 // indirect
	github.com/goccy/go-yaml v1.19.2 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/google/go-querystring v1.2.0 // indirect
	github.com/google/gopacket v1.1.19 // indirect
	github.com/google/pprof v0.0.0-20260604005048-7023385849c0 // indirect
	github.com/gookit/color v1.6.0 // indirect
	github.com/gookit/goutil v0.7.1 // indirect
	github.com/gookit/gsr v0.1.1 // indirect
	github.com/gookit/slog v0.6.0 // indirect
	github.com/goph/emperror v0.17.2 // indirect
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/icholy/digest v1.1.0 // indirect
	github.com/jezek/xgb v1.1.1 // indirect
	github.com/jinzhu/inflection v1.0.0 // indirect
	github.com/jinzhu/now v1.1.5 // indirect
	github.com/json-iterator/go v1.1.12 // indirect
	github.com/jwwsjlm/Tikhub v0.2.3 // indirect
	github.com/jwwsjlm/req/v3 v3.58.4 // indirect
	github.com/klauspost/compress v1.19.0 // indirect
	github.com/klauspost/cpuid/v2 v2.3.0 // indirect
	github.com/leodido/go-urn v1.4.0 // indirect
	github.com/mailru/easyjson v0.9.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd // indirect
	github.com/modern-go/reflect2 v1.0.2 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/nikolalohinski/gonja v1.5.3 // indirect
	github.com/oklog/ulid/v2 v2.1.1 // indirect
	github.com/onsi/ginkgo/v2 v2.32.0 // indirect
	github.com/openai/openai-go/v3 v3.35.0 // indirect
	github.com/pelletier/go-toml/v2 v2.4.3 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/quic-go/qpack v0.6.0 // indirect
	github.com/quic-go/quic-go v0.60.0 // indirect
	github.com/refraction-networking/uquic v0.0.6 // indirect
	github.com/refraction-networking/utls v1.8.2 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/sirupsen/logrus v1.9.3 // indirect
	github.com/slongfield/pyfmt v0.0.0-20220222012616-ea85ff4c361f // indirect
	github.com/tidwall/gjson v1.19.0 // indirect
	github.com/tidwall/match v1.2.0 // indirect
	github.com/tidwall/pretty v1.2.1 // indirect
	github.com/tidwall/sjson v1.2.5 // indirect
	github.com/twitchyliquid64/golang-asm v0.15.1 // indirect
	github.com/ugorji/go/codec v1.3.0 // indirect
	github.com/valyala/bytebufferpool v1.0.0 // indirect
	github.com/wk8/go-ordered-map/v2 v2.1.8 // indirect
	github.com/xo/terminfo v0.0.0-20220910002029-abceb7e1c41e // indirect
	github.com/yargevad/filepathx v1.0.0 // indirect
	go.uber.org/mock v0.6.0 // indirect
	golang.org/x/arch v0.20.0 // indirect
	golang.org/x/crypto v0.57.0 // indirect
	golang.org/x/exp v0.0.0-20260611194520-c48552f49976 // indirect
	golang.org/x/mod v0.41.0 // indirect
	golang.org/x/net v0.60.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/term v0.46.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	golang.org/x/tools v0.49.0 // indirect
	h12.io/socks v1.0.3 // indirect
	modernc.org/libc v1.67.6 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
	modernc.org/sqlite v1.44.3 // indirect
)
