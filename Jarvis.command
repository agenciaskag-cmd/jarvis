#!/bin/bash
# Jarvis — duplo clique abre o painel (o servidor já vive ligado sozinho)
if ! lsof -tiTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/com.wylle.jarvis" 2>/dev/null || \
    (cd "$(dirname "$0")" && nohup /opt/homebrew/bin/node server.js > jarvis.log 2>&1 &)
  sleep 1.5
fi
open -na "Google Chrome" --args --app="http://localhost:3080" --window-size=420,640
