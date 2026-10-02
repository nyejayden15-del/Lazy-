#!/usr/bin/env bash
# Install MoneyPrinterTurbo (https://github.com/harry0703/MoneyPrinterTurbo) next to this repo.
# Requires: python3 (3.11+), ffmpeg, git.
set -euo pipefail
DIR="${1:-$HOME/MoneyPrinterTurbo}"
[ -d "$DIR" ] || git clone --depth 1 https://github.com/harry0703/MoneyPrinterTurbo.git "$DIR"
cd "$DIR"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
[ -f config.toml ] || cp config.example.toml config.toml
# Behind a TLS-intercepting proxy (e.g. Claude Code cloud sessions), Edge TTS needs the proxy CA,
# because edge_tts only trusts certifi's bundle.
if [ -f /root/.ccr/ca-bundle.crt ]; then
  CERTIFI="$(.venv/bin/python -c 'import certifi;print(certifi.where())')"
  grep -q "$(sed -n 2p /root/.ccr/ca-bundle.crt)" "$CERTIFI" || cat /root/.ccr/ca-bundle.crt >> "$CERTIFI"
fi
echo "Installed in $DIR. Edit config.toml to add LLM + Pexels keys."
