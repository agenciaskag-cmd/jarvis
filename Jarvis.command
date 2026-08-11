#!/bin/bash
# Jarvis — duplo clique para ligar
cd "$(dirname "$0")"
# Encerra instância anterior se existir
lsof -tiTCP:3080 -sTCP:LISTEN | xargs kill 2>/dev/null
sleep 1
nohup /opt/homebrew/bin/node server.js > jarvis.log 2>&1 &
sleep 1
open "http://localhost:3080"
echo "Jarvis ligado. Pode fechar esta janela."
