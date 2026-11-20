import json
import sys
import wave
from array import array

import sherpa_onnx


def main():
    request = json.load(sys.stdin.buffer)
    model = sherpa_onnx.OfflineTtsModelConfig(num_threads=2, provider="cpu")
    if request["kokoro"]:
        model.kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=request["weights"], tokens="tokens.txt", voices="voices.bin",
            data_dir="espeak-ng-data", lexicon="lexicon-us-en.txt,lexicon-zh.txt",
        )
    else:
        model.vits = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=request["weights"], tokens="tokens.txt", lexicon="lexicon.txt",
        )
    config = sherpa_onnx.OfflineTtsConfig(model=model, rule_fsts=request["rules"])
    if not config.validate():
        raise ValueError("Invalid TTS model configuration")
    tts = sherpa_onnx.OfflineTts(config)
    generation = sherpa_onnx.GenerationConfig()
    generation.sid = request["speaker"]
    generation.speed = request["speed"]
    audio = tts.generate(request["text"], generation)
    samples = audio.samples
    if not samples:
        raise ValueError("The model produced no audio")

    pcm = array("h", (int(max(-1.0, min(sample, 1.0)) * 32767) for sample in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    with wave.open(request["output"], "wb") as output:
        output.setparams((1, 2, audio.sample_rate, 0, "NONE", "not compressed"))
        output.writeframes(pcm.tobytes())


main()
