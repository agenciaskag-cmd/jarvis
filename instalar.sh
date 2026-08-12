#!/bin/bash
# Instalador do Jarvis — a voz do seu terminal
# Uso (uma linha no Terminal):
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/agenciaskag-cmd/jarvis/main/instalar.sh)"

DESTINO="$HOME/jarvis"
REPO_TAR="https://github.com/agenciaskag-cmd/jarvis/archive/refs/heads/main.tar.gz"

titulo() { echo; echo "==> $1"; }

echo "======================================"
echo "  JARVIS — a voz do seu terminal"
echo "======================================"

# 1. Homebrew (gerenciador que instala as outras peças)
if ! command -v brew >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/brew ] && [ ! -x /usr/local/bin/brew ]; then
  titulo "Instalando o Homebrew (vai pedir a senha do Mac, é normal)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
[ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"

# 2. Peças: node (motor), mpv (tocador), python (voz)
titulo "Instalando as peças necessárias"
for pacote in node mpv python3; do
  if ! command -v $pacote >/dev/null 2>&1; then brew install $pacote; fi
done

# 3. Baixar o Jarvis
titulo "Baixando o Jarvis"
mkdir -p "$DESTINO"
curl -fsSL "$REPO_TAR" | tar -xz --strip-components=1 -C "$DESTINO"

# 4. A voz (Antonio, brasileiro)
titulo "Instalando a voz do Antonio"
python3 -m venv "$DESTINO/tts"
"$DESTINO/tts/bin/pip" install --quiet edge-tts

# 5. Ligar o Jarvis pra sempre (liga sozinho quando o Mac liga)
titulo "Deixando o Jarvis sempre ligado"
NODE_BIN="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.jarvis.assistente.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<FIM
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jarvis.assistente</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$DESTINO/server.js</string></array>
  <key>WorkingDirectory</key><string>$DESTINO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DESTINO/jarvis.log</string>
  <key>StandardErrorPath</key><string>$DESTINO/jarvis.log</string>
</dict>
</plist>
FIM
launchctl bootout "gui/$(id -u)/com.jarvis.assistente" 2>/dev/null
launchctl bootout "gui/$(id -u)/com.wylle.jarvis" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# 6. Conectar ao Claude Code (o gatilho que faz o Jarvis falar cada resposta)
titulo "Conectando o Jarvis ao Claude Code"
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  echo "AVISO: o Claude Code não está instalado neste Mac."
  echo "Instale primeiro (claude.com/claude-code) e rode este instalador de novo."
else
  "$NODE_BIN" - <<'FIM'
const fs = require('fs'), path = require('path'), os = require('os');
const arquivo = path.join(os.homedir(), '.claude', 'settings.json');
fs.mkdirSync(path.dirname(arquivo), { recursive: true });
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(fs.realpathSync(arquivo), 'utf8')); } catch {}
cfg.hooks = cfg.hooks || {};
cfg.hooks.Stop = cfg.hooks.Stop || [{ hooks: [] }];
const grupo = cfg.hooks.Stop[0];
grupo.hooks = grupo.hooks || [];
const comando = 'node ' + path.join(os.homedir(), 'jarvis', 'hook-falar.js');
if (!grupo.hooks.some((h) => h.command === comando)) {
  grupo.hooks.push({ type: 'command', command: comando, timeout: 10, async: true });
}
let destino = arquivo;
try { destino = fs.realpathSync(arquivo); } catch {}
fs.writeFileSync(destino, JSON.stringify(cfg, null, 2));
console.log('Gatilho instalado no Claude Code.');
FIM
fi

# 7. Abrir o painel
sleep 2
open -na "Google Chrome" --args --app="http://localhost:3080" --window-size=420,640 2>/dev/null || open "http://localhost:3080"

echo
echo "======================================"
echo "  Pronto! O Jarvis está no ar."
echo "  A janelinha azul abriu na sua tela."
echo "  Feche e abra o Claude Code no terminal:"
echo "  a partir de agora, toda resposta dele"
echo "  o Jarvis lê em voz alta."
echo "======================================"
