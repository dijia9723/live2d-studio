// Package tts 负责发现本地 TTS 模型，并在独立的 Python 进程中完成离线语音合成。
package tts

import "fmt"

// MaxTextLength 是单次合成允许的最大文本长度，防止超长文本拖垮本地推理。
const MaxTextLength = 1000

// Options 选择内置模型、音色编号与合成语速。
type Options struct {
	Model   string  `json:"model" yaml:"model"`
	Speaker int     `json:"speaker" yaml:"speaker"`
	Speed   float64 `json:"speed" yaml:"speed"`
}

// model 描述一个内置 TTS 模型及其磁盘布局；
// dir/weights/rules 等私有字段用于定位安装文件，不对外输出。
type model struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Tier           string         `json:"tier"`
	Language       string         `json:"language"`
	SpeakerMin     int            `json:"speaker_min"`
	SpeakerMax     int            `json:"speaker_max"`
	DefaultSpeaker int            `json:"default_speaker"`
	SpeakerNames   map[int]string `json:"speaker_names,omitempty"`
	Installed      bool           `json:"installed"`
	dir            string
	weights        string
	rules          []string
	kokoro         bool
}

// models 是内置支持的模型清单，按质量从低到高排列。
var models = []model{
	{
		ID: "aishell3", Name: "AISHELL-3", Tier: "low", Language: "普通话",
		SpeakerMax: 173, DefaultSpeaker: 33,
		dir: "vits-icefall-zh-aishell3", weights: "model.onnx",
		rules: []string{"phone.fst", "date.fst", "number.fst"},
	},
	{
		ID: "fanchen", Name: "Fanchen-C", Tier: "medium", Language: "普通话",
		SpeakerMax: 186, DefaultSpeaker: 14,
		dir: "vits-zh-hf-fanchen-C", weights: "vits-zh-hf-fanchen-C.onnx",
		rules: []string{"phone.fst", "number.fst"},
	},
	{
		ID: "kokoro", Name: "Kokoro v1.0", Tier: "high", Language: "普通话 / 英语",
		SpeakerMin: 45, SpeakerMax: 52, DefaultSpeaker: 45,
		SpeakerNames: map[int]string{45: "小北", 46: "小妮", 47: "小晓", 48: "小伊", 49: "云健", 50: "云希", 51: "云夏", 52: "云扬"},
		dir:          "kokoro-multi-lang-v1_0", weights: "model.onnx", kokoro: true,
		rules: []string{"date-zh.fst", "phone-zh.fst", "number-zh.fst"},
	},
}

// Validate 校验模型、音色编号与语速是否在允许范围内。
func (o Options) Validate() error {
	_, err := o.resolve()
	return err
}

// resolve 查找模型并校验参数；音色编号和语速越界时返回可直接展示给用户的中文错误。
func (o Options) resolve() (model, error) {
	for _, m := range models {
		if m.ID != o.Model {
			continue
		}
		if o.Speaker < m.SpeakerMin || o.Speaker > m.SpeakerMax {
			return model{}, fmt.Errorf("音色编号必须在 %d–%d 之间", m.SpeakerMin, m.SpeakerMax)
		}
		if !(o.Speed >= 0.5 && o.Speed <= 2) {
			return model{}, fmt.Errorf("语速必须在 0.5–2 倍之间")
		}
		return m, nil
	}
	return model{}, fmt.Errorf("请选择内置 TTS 模型")
}
