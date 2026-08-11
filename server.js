// Jarvis — assistente pessoal de voz do Wylle
// Peças: whisper-cli (ouvido) + claude CLI (cérebro) + say/Luciana (boca) + interface web (rosto)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORTA = 3080;
const HOME = os.homedir();
const TMP = path.join(__dirname, 'tmp');
const PUBLIC = path.join(__dirname, 'public');
const MODELO_WHISPER = path.join(HOME, '.cache/whisper-cpp/ggml-large-v3-turbo.bin');
const VOZ = 'Luciana';
const MODELO_CLAUDE = 'sonnet';

const PERSONA = [
  'Você é o Jarvis, assistente pessoal de voz do Wylle.',
  'Suas respostas serão faladas em voz alta, então escreva como quem fala:',
  'frases curtas, tom natural e simpático, português do Brasil.',
  'NUNCA use markdown, listas com marcadores, títulos, emojis ou símbolos.',
  'Responda em no máximo 4 frases, a menos que o Wylle peça detalhes.',
  'Se precisar executar algo demorado, avise que vai fazer e resuma o resultado ao final.'
].join(' ');

fs.mkdirSync(TMP, { recursive: true });

let sessaoClaude = null; // session_id do claude para manter o contexto da conversa

function rodar(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50, timeout: opts.timeout || 120000, cwd: opts.cwd || HOME, env: { ...process.env, CLAUDECODE: '' } },
      (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
  });
}

async function transcrever(arquivoAudio) {
  const wav = path.join(TMP, 'entrada.wav');
  await rodar('/opt/homebrew/bin/ffmpeg', ['-y', '-loglevel', 'error', '-i', arquivoAudio, '-ar', '16000', '-ac', '1', wav]);
  const texto = await rodar('/opt/homebrew/bin/whisper-cli', ['-m', MODELO_WHISPER, '-l', 'pt', '-f', wav, '-np', '-nt'], { timeout: 180000 });
  return texto.trim();
}

async function pensar(texto) {
  const args = ['-p', texto, '--output-format', 'json', '--model', MODELO_CLAUDE, '--append-system-prompt', PERSONA, '--permission-mode', 'acceptEdits'];
  if (sessaoClaude) args.push('--resume', sessaoClaude);
  const claudeBin = path.join(HOME, '.local/bin/claude');
  let saida;
  try {
    saida = await rodar(claudeBin, args, { timeout: 300000 });
  } catch (e) {
    if (sessaoClaude) { // sessão antiga pode ter expirado: tenta uma conversa nova
      sessaoClaude = null;
      saida = await rodar(claudeBin, args.slice(0, -2), { timeout: 300000 });
    } else throw e;
  }
  const json = JSON.parse(saida);
  if (json.session_id) sessaoClaude = json.session_id;
  return json.result || 'Não consegui pensar em uma resposta agora.';
}

function limparParaFala(texto) {
  return texto
    .replace(/```[\s\S]*?```/g, ' trecho de código omitido ')
    .replace(/[*_#`>|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'um link')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function falar(texto) {
  const aiff = path.join(TMP, 'resposta.aiff');
  const m4a = path.join(TMP, 'resposta.m4a');
  await rodar('/usr/bin/say', ['-v', VOZ, '-o', aiff, limparParaFala(texto)]);
  await rodar('/opt/homebrew/bin/ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-c:a', 'aac', '-b:a', '96k', m4a]);
  return fs.readFileSync(m4a).toString('base64');
}

function lerCorpo(req) {
  return new Promise((resolve) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => resolve(Buffer.concat(partes)));
  });
}

function responderJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const servidor = http.createServer(async (req, res) => {
  try {
    const caminho = req.url.split('?')[0];
    if (req.method === 'GET' && (caminho === '/' || caminho === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(PUBLIC, 'index.html')));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/conversar') {
      const corpo = await lerCorpo(req);
      const tipo = req.headers['x-audio-type'] || 'webm';
      const ext = tipo.includes('mp4') ? 'mp4' : 'webm';
      const arquivo = path.join(TMP, 'entrada.' + ext);
      fs.writeFileSync(arquivo, corpo);

      const pergunta = await transcrever(arquivo);
      if (!pergunta || pergunta.length < 2) {
        return responderJson(res, 200, { erro: 'Não entendi o áudio. Tenta falar de novo mais perto do microfone.' });
      }
      const resposta = await pensar(pergunta);
      const audio = await falar(resposta);
      return responderJson(res, 200, { pergunta, resposta, audio });
    }

    if (req.method === 'POST' && req.url === '/api/texto') {
      const corpo = await lerCorpo(req);
      const { texto } = JSON.parse(corpo.toString('utf8'));
      if (!texto) return responderJson(res, 400, { erro: 'Texto vazio.' });
      const resposta = await pensar(texto);
      const audio = await falar(resposta);
      return responderJson(res, 200, { pergunta: texto, resposta, audio });
    }

    if (req.method === 'POST' && req.url === '/api/nova') {
      sessaoClaude = null;
      return responderJson(res, 200, { ok: true });
    }

    res.writeHead(404); res.end('Não encontrado');
  } catch (e) {
    console.error('[Jarvis] erro:', e.message);
    responderJson(res, 500, { erro: 'Deu um problema aqui: ' + e.message.slice(0, 200) });
  }
});

servidor.listen(PORTA, () => console.log('Jarvis no ar em http://localhost:' + PORTA));
