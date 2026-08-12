// Hook Stop do Claude Code: pega a última resposta da sessão e manda o Jarvis falar.
// Falha em silêncio se o Jarvis estiver desligado — nunca atrapalha o terminal.
const fs = require('fs');
const http = require('http');

let entrada = '';
process.stdin.on('data', (c) => { entrada += c; });
process.stdin.on('end', () => {
  try {
    const dados = JSON.parse(entrada);
    if (!dados.transcript_path || !fs.existsSync(dados.transcript_path)) process.exit(0);

    const linhas = fs.readFileSync(dados.transcript_path, 'utf8').trim().split('\n');

    // REGRA DO WYLLE: Claude/Claudinho = só escrita; Jarvis = voz.
    // Só fala se o último pedido do Wylle mencionar o Jarvis.
    let pediuJarvis = false;
    for (let i = linhas.length - 1; i >= 0; i--) {
      let registro;
      try { registro = JSON.parse(linhas[i]); } catch { continue; }
      if (registro.type !== 'user' || !registro.message) continue;
      let textoUsuario = '';
      if (typeof registro.message.content === 'string') textoUsuario = registro.message.content;
      else if (Array.isArray(registro.message.content)) {
        textoUsuario = registro.message.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join(' ');
      }
      if (!textoUsuario.trim()) continue; // resultado de ferramenta, não é o pedido do Wylle
      pediuJarvis = /jarvis/i.test(textoUsuario);
      break;
    }
    if (!pediuJarvis) process.exit(0);

    let texto = '';
    for (let i = linhas.length - 1; i >= 0; i--) {
      let registro;
      try { registro = JSON.parse(linhas[i]); } catch { continue; }
      if (registro.type !== 'assistant' || !registro.message || !Array.isArray(registro.message.content)) continue;
      const partes = registro.message.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text);
      if (partes.length === 0) continue;
      texto = partes.join('\n');
      break;
    }
    if (!texto.trim()) process.exit(0);

    const corpo = JSON.stringify({ texto, origem: dados.cwd || '' });
    const req = http.request({
      host: 'localhost', port: 3080, path: '/api/anunciar', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
      timeout: 3000
    }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
    req.on('error', () => process.exit(0));
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.end(corpo);
  } catch {
    process.exit(0);
  }
});
