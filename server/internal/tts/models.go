package tts

import "fmt"

const MaxTextLength = 1000

// Options selects a built-in model, its speaker, and the playback speed used in synthesis.
type Options struct {
	Model   string  `json:"model" yaml:"model"`
	Speaker int     `json:"speaker" yaml:"speaker"`
	Speed   float64 `json:"speed" yaml:"speed"`
}

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

func (o Options) Validate() error {
	_, err := o.resolve()
	return err
}

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
