# MoneyPrinterTurbo

Generates short videos automatically: script → voiceover → subtitles → stock footage → final MP4.

## Install
```bash
./moneyprinter/setup.sh            # installs to ~/MoneyPrinterTurbo
```

## Use

**Fully automatic (needs API keys):** in `~/MoneyPrinterTurbo/config.toml` set
`llm_provider` + its key (e.g. `llm_provider = "openai"`, `openai_api_key = "..."`) and
`pexels_api_keys = ["..."]` (free at https://www.pexels.com/api/). Then:
```bash
cd ~/MoneyPrinterTurbo
.venv/bin/python cli.py --video-subject "5 tips to save money" --video-language en-US \
  --voice-name en-US-AriaNeural-Female
```

**No keys:** write your own script and use your own clips/images (Edge TTS voice is free):
```bash
.venv/bin/python cli.py --video-script "Your script here..." --video-language en-US \
  --voice-name en-US-AriaNeural-Female --video-source local \
  --video-materials clip1.mp4,clip2.mp4,photo.jpg --bgm-type none
```

**Web UI:** `.venv/bin/streamlit run webui/Main.py` → http://localhost:8501
**API:** `.venv/bin/python main.py` → http://127.0.0.1:8080/docs

Output lands in `storage/tasks/<task_id>/final-1.mp4`. `demo-output.mp4` here is a sample
made with the no-keys command (placeholder colour clips, real AI voice + subtitles).
