// Jarvis — a voz do terminal do Wylle
// O terminal trabalha, o Jarvis fala: um hook do Claude Code manda cada resposta
// pra cá, o servidor fala no alto-falante (say/Luciana) e anima o painel via SSE.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { execFile, spawn } = require('child_process');

const PORTA = 3080;
const HOME = os.homedir();
const TMP = path.join(__dirname, 'tmp');
const PUBLIC = path.join(__dirname, 'public');
const MODELO_WHISPER = path.join(HOME, '.cache/whisper-cpp/ggml-large-v3-turbo.bin');
const EDGE_TTS = path.join(__dirname, 'tts/bin/edge-tts');
const VOZ_EDGE = 'pt-BR-AntonioNeural'; // brasileiro nativo (precisa de internet); Wylle rejeitou vozes multilingual por sotaque gringo
const PIPER = path.join(__dirname, 'tts/bin/piper');
const VOZ_PIPER = path.join(__dirname, 'vozes/pt_BR-faber-medium.onnx'); // reserva offline
const VOZ_RESERVA = 'Eddy (Português (Brasil))'; // último recurso se tudo falhar
const MPV = '/opt/homebrew/bin/mpv';
const MPV_SOCK = path.join(TMP, 'mpv.sock');
const LIMITE_FALA = 2000; // caracteres; acima disso corta na frase e avisa que o resto está na tela
const MODELO_CLAUDE = 'sonnet';

const PERSONA = [
  'Você é o Jarvis, assistente pessoal de voz do Wylle.',
  'Suas respostas serão faladas em voz alta, então escreva como quem fala:',
  'frases curtas, tom natural e simpático, português do Brasil.',
  'NUNCA use markdown, listas com marcadores, títulos, emojis ou símbolos.',
  'Responda em no máximo 4 frases, a menos que o Wylle peça detalhes.'
].join(' ');

fs.mkdirSync(TMP, { recursive: true });

const ARQUIVO_CONFIG = path.join(__dirname, 'config.json');
let config = { velocidade: 1.0 };
try { config = { ...config, ...JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, 'utf8')) }; } catch {}
function salvarConfig() {
  try { fs.writeFileSync(ARQUIVO_CONFIG, JSON.stringify(config)); } catch {}
}

let sessaoClaude = null;          // contexto da conversa direta com o painel
let filaFalas = [];               // anúncios aguardando a vez
let falaAtual = null;             // processo say em andamento
let processandoFila = false;
let ultimaFalaPorOrigem = new Map(); // evita repetir a mesma resposta (resume/clear disparam o hook de novo)
const clientesSse = new Set();

function rodar(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50, timeout: opts.timeout || 120000, cwd: opts.cwd || HOME, env: { ...process.env, CLAUDECODE: '' } },
      (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
  });
}

function transmitir(evento) {
  const linha = 'data: ' + JSON.stringify(evento) + '\n\n';
  for (const cliente of clientesSse) cliente.write(linha);
}

function limparParaFala(texto) {
  return texto
    .replace(/```[\s\S]*?```/g, ' trecho de código na tela ')
    .replace(/\|[^\n]*\|/g, ' ')
    .replace(/[*_#`>~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'um link')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function encurtar(texto) {
  if (texto.length <= LIMITE_FALA) return texto;
  const corte = texto.slice(0, LIMITE_FALA);
  const fimFrase = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('! '), corte.lastIndexOf('? '));
  const base = fimFrase > LIMITE_FALA * 0.4 ? corte.slice(0, fimFrase + 1) : corte;
  return base + ' O resto da resposta está na tela.';
}

function enfileirarFala(texto, origem) {
  const fala = encurtar(limparParaFala(texto));
  if (!fala) return;
  filaFalas.push({ texto, fala, origem: origem || '' });
  processarFila();
}

async function processarFila() {
  if (processandoFila) return;
  processandoFila = true;
  while (filaFalas.length > 0) {
    const item = filaFalas.shift();
    transmitir({ tipo: 'falando', texto: item.texto, origem: item.origem });
    const arquivo = await gerarAudio(item.fala);
    await new Promise((fim) => {
      // mpv com canal de comando: a velocidade muda AO VIVO no meio da fala
      falaAtual = arquivo
        ? spawn(MPV, ['--no-video', '--really-quiet', '--input-ipc-server=' + MPV_SOCK,
            '--speed=' + config.velocidade, arquivo])
        : spawn('/usr/bin/say', ['-v', VOZ_RESERVA, item.fala]);
      falaAtual.on('exit', () => { falaAtual = null; fim(); });
      falaAtual.on('error', () => { falaAtual = null; fim(); });
    });
    transmitir({ tipo: 'parado' });
  }
  processandoFila = false;
}

// Manda o novo valor pro mpv que estiver tocando agora, sem interromper a fala
function ajustarVelocidadeAoVivo(valor) {
  if (!falaAtual) return;
  try {
    const canal = net.connect(MPV_SOCK, () => {
      canal.write(JSON.stringify({ command: ['set_property', 'speed', valor] }) + '\n');
      canal.end();
    });
    canal.on('error', () => {});
  } catch {}
}

function rodarComPrazo(cmd, args, prazoMs, entradaStdin) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    const timer = setTimeout(() => { proc.kill(); resolve(false); }, prazoMs);
    if (entradaStdin !== undefined) proc.stdin.end(entradaStdin);
    proc.on('exit', (cod) => { clearTimeout(timer); resolve(cod === 0); });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// Tenta a voz escolhida pelo Wylle (Brian, online); sem internet cai pro Piper offline
async function gerarAudio(fala) {
  const mp3 = path.join(TMP, 'fala.mp3');
  const wav = path.join(TMP, 'fala.wav');
  if (await rodarComPrazo(EDGE_TTS, ['--voice', VOZ_EDGE, '--text', fala, '--write-media', mp3], 15000)) {
    if (fs.existsSync(mp3) && fs.statSync(mp3).size > 1000) return mp3;
  }
  console.error('[Jarvis] voz online indisponível, usando a reserva offline');
  if (await rodarComPrazo(PIPER, ['-m', VOZ_PIPER, '--length-scale', '0.92', '-f', wav], 60000, fala)) {
    if (fs.existsSync(wav) && fs.statSync(wav).size > 1000) return wav;
  }
  return null;
}

async function transcrever(arquivoAudio) {
  const wav = path.join(TMP, 'entrada.wav');
  await rodar('/opt/homebrew/bin/ffmpeg', ['-y', '-loglevel', 'error', '-i', arquivoAudio, '-ar', '16000', '-ac', '1', wav]);
  const texto = await rodar('/opt/homebrew/bin/whisper-cli', ['-m', MODELO_WHISPER, '-l', 'pt', '-f', wav, '-np', '-nt'], { timeout: 180000 });
  return texto.trim();
}

async function pensar(texto) {
  // desligar os hooks aqui evita eco: sem isso a própria resposta do painel dispararia o hook do Jarvis
  const args = ['-p', texto, '--output-format', 'json', '--model', MODELO_CLAUDE,
    '--append-system-prompt', PERSONA, '--permission-mode', 'acceptEdits',
    '--settings', '{"disableAllHooks": true}'];
  if (sessaoClaude) args.push('--resume', sessaoClaude);
  const claudeBin = path.join(HOME, '.local/bin/claude');
  let saida;
  try {
    saida = await rodar(claudeBin, args, { timeout: 300000 });
  } catch (e) {
    if (sessaoClaude) {
      sessaoClaude = null;
      saida = await rodar(claudeBin, args.slice(0, -2), { timeout: 300000 });
    } else throw e;
  }
  const json = JSON.parse(saida);
  if (json.session_id) sessaoClaude = json.session_id;
  return json.result || 'Não consegui pensar em uma resposta agora.';
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

    if (req.method === 'POST' && caminho === '/api/velocidade') {
      const corpo = await lerCorpo(req);
      const { valor } = JSON.parse(corpo.toString('utf8'));
      const v = Number(valor);
      if (!Number.isFinite(v) || v < 1 || v > 3) return responderJson(res, 400, { erro: 'Velocidade deve ficar entre 1.0 e 3.0.' });
      config.velocidade = Math.round(v * 10) / 10;
      salvarConfig();
      ajustarVelocidadeAoVivo(config.velocidade);
      return responderJson(res, 200, { ok: true, velocidade: config.velocidade });
    }

    if (req.method === 'GET' && caminho === '/api/eventos') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ tipo: 'conectado', velocidade: config.velocidade }) + '\n\n');
      clientesSse.add(res);
      req.on('close', () => clientesSse.delete(res));
      return;
    }

    // o hook do Claude Code manda a resposta de qualquer sessão do terminal pra cá
    if (req.method === 'POST' && caminho === '/api/anunciar') {
      const corpo = await lerCorpo(req);
      const { texto, origem } = JSON.parse(corpo.toString('utf8'));
      if (!texto) return responderJson(res, 400, { erro: 'Texto vazio.' });
      if (ultimaFalaPorOrigem.get(origem || '') === texto) return responderJson(res, 200, { ok: true, repetida: true });
      ultimaFalaPorOrigem.set(origem || '', texto);
      enfileirarFala(texto, origem);
      return responderJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && caminho === '/api/parar') {
      filaFalas = [];
      if (falaAtual) falaAtual.kill();
      transmitir({ tipo: 'parado' });
      return responderJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && caminho === '/api/texto') {
      const corpo = await lerCorpo(req);
      const { texto } = JSON.parse(corpo.toString('utf8'));
      if (!texto) return responderJson(res, 400, { erro: 'Texto vazio.' });
      transmitir({ tipo: 'pensando' });
      const resposta = await pensar(texto);
      enfileirarFala(resposta, 'painel');
      return responderJson(res, 200, { pergunta: texto, resposta });
    }

    if (req.method === 'POST' && caminho === '/api/conversar') {
      const corpo = await lerCorpo(req);
      const tipo = req.headers['x-audio-type'] || 'webm';
      const ext = tipo.includes('mp4') ? 'mp4' : 'webm';
      const arquivo = path.join(TMP, 'entrada.' + ext);
      fs.writeFileSync(arquivo, corpo);
      const pergunta = await transcrever(arquivo);
      if (!pergunta || pergunta.length < 2) {
        return responderJson(res, 200, { erro: 'Não entendi o áudio. Tenta falar de novo mais perto do microfone.' });
      }
      transmitir({ tipo: 'pensando' });
      const resposta = await pensar(pergunta);
      enfileirarFala(resposta, 'painel');
      return responderJson(res, 200, { pergunta, resposta });
    }

    if (req.method === 'POST' && caminho === '/api/nova') {
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
