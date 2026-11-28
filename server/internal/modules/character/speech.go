package character

import (
	"fmt"
	"strings"
	"unicode"

	"server/internal/model"
)

func normalizeSpeech(speech *model.CharacterSpeech) error {
	if speech == nil {
		return nil
	}
	switch speech.Mode {
	case "inherit":
		return nil
	case "browser", "api":
		speech.LocalTTS = nil
		speech.Voice = strings.TrimSpace(speech.Voice)
		if len(speech.Voice) > 512 || strings.ContainsFunc(speech.Voice, unicode.IsControl) {
			return fmt.Errorf("角色音色无效")
		}
		return nil
	case "local":
		speech.Voice = ""
		if speech.LocalTTS == nil {
			return fmt.Errorf("请选择角色的本地 TTS 模型和音色")
		}
		return speech.LocalTTS.Validate()
	default:
		return fmt.Errorf("不支持的角色朗读方式")
	}
}
