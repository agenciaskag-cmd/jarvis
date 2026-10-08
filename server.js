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
const ROSTO = path.join(PUBLIC, 'rosto.jpg');
// acha programas tanto em Mac Apple Silicon (/opt/homebrew) quanto Intel (/usr/local)
function acharPrograma(nome) {
  for (const base of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const caminho = path.join(base, nome);
    if (fs.existsSync(caminho)) return caminho;
  }
  return nome;
}

const MODELO_WHISPER = path.join(HOME, '.cache/whisper-cpp/ggml-large-v3-turbo.bin');
const WHISPER = acharPrograma('whisper-cli');
const FFMPEG = acharPrograma('ffmpeg');
const EDGE_TTS = path.join(__dirname, 'tts/bin/edge-tts');
const VOZ_EDGE = 'pt-BR-AntonioNeural'; // brasileiro nativo (precisa de internet); Wylle rejeitou vozes multilingual por sotaque gringo
const MPV = acharPrograma('mpv');
const MPV_SOCK = path.join(TMP, 'mpv.sock');
const LIMITE_FALA = 2000; // caracteres; acima disso corta na frase e avisa que o resto está na tela
const MODELO_CLAUDE = 'haiku'; // o mais rápido: o painel é pra pergunta e resposta ágil

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
let topicosNoAr = [];              // tópicos já mostrados da fala atual (pra painéis que conectam no meio)
let ultimaFala = null;             // guardada pro botão Ouvir de novo
let falaAtual = null;             // processo de áudio em andamento
let estadoFala = null;            // o que está sendo falado agora (pra painéis que conectam no meio)
let cancelarFala = false;         // ligado pelo botão Parar de falar
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

function pronunciar(texto) {
  return texto
    .replace(/wylle/gi, 'Uíli') // o nome escreve-se Wylle mas pronuncia-se U-I-LI
    .replace(/jarvis/gi, 'Járvis') // tônica no A: JÁR-VIZ
    .replace(/evoluwill/gi, 'Evoluiu'); // Agência EvoluWill fala-se "e-vo-lu-iu" (regra do Wylle)
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

// Frase comprida demais pra um balão: corta na vírgula mais perto do meio
function fatiar(frase) {
  frase = frase.trim();
  if (frase.length <= 120) return frase ? [frase] : [];
  const meio = frase.length / 2, marca = /[,;:] /g;
  let melhor = -1, achado;
  while ((achado = marca.exec(frase))) {
    const pos = achado.index + 1;
    if (pos < 25 || frase.length - pos < 25) continue;
    if (melhor < 0 || Math.abs(pos - meio) < Math.abs(melhor - meio)) melhor = pos;
  }
  if (melhor < 0) {
    const e = frase.indexOf(' e ', Math.max(25, Math.floor(meio) - 30));
    if (e > 0 && frase.length - e > 25) melhor = e;
  }
  if (melhor < 0) return [frase];
  return [...fatiar(frase.slice(0, melhor)), ...fatiar(frase.slice(melhor))];
}

// Um balão a cada ~7 segundos de fala: junta frases curtas e corta as compridas, uma ideia por balão
function emBaloes(fala) {
  const frases = fala.match(/[^.!?…]+[.!?…]+\s*|[^.!?…]+$/g) || [fala];
  const baloes = [];
  let atual = '';
  for (const f of frases) {
    if (atual && (atual + f).length > 105) { baloes.push(...fatiar(atual)); atual = f; }
    else atual += f;
  }
  if (atual.trim()) baloes.push(...fatiar(atual));
  return baloes;
}

// Cada parágrafo ou item de lista da resposta vira um tópico: é um cartão no painel e um bloco de fala
function montarTopicos(texto) {
  const semCodigo = texto.replace(/```[\s\S]*?```/g, ' trecho de código na tela ')
    .replace(/^(#{1,6}\s[^\n]*)\n(?!\n)/gm, '$1\n\n'); // título sempre separado do parágrafo dele
  const blocos = semCodigo.split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s+)|\n(?=#{1,6}\s)/);
  const topicos = [];
  let gasto = 0;
  for (const bloco of blocos) {
    const bruto = bloco.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
    let fala = limparParaFala(bruto);
    if (!fala) continue;
    // linha de título sozinha (## Assunto) dá nome ao bloco seguinte
    if (/^#{1,6}\s/.test(bloco.trim()) && !bloco.trim().includes('\n')) { topicos.push({ texto: fala, fala: fala + '.' }); gasto += fala.length; continue; }
    let acabou = false;
    if (gasto + fala.length > LIMITE_FALA) {
      const corte = fala.slice(0, Math.max(0, LIMITE_FALA - gasto));
      const fimFrase = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('! '), corte.lastIndexOf('? '));
      fala = (fimFrase > 40 ? corte.slice(0, fimFrase + 1) + ' ' : '') + 'O resto da resposta está na tela.';
      acabou = true;
    }
    for (const balao of emBaloes(fala)) {
      const texto = balao.replace(/[,;:]+$/, '');
      topicos.push({ texto: texto.charAt(0).toUpperCase() + texto.slice(1), fala: balao });
    }
    gasto += fala.length;
    if (acabou) break;
  }
  return topicos;
}

function enfileirarFala(texto, origem) {
  const topicos = montarTopicos(texto);
  if (topicos.length === 0) return;
  filaFalas.push({ texto, topicos, origem: origem || '' });
  processarFila();
}

// Fatia o texto em pedaços por frase: o primeiro é curto pra fala começar em ~1 segundo,
// os seguintes são gerados em paralelo enquanto o anterior toca
function dividirEmPedacos(texto) {
  const frases = texto.match(/[^.!?…]+[.!?…]+\s*|[^.!?…]+$/g) || [texto];
  const pedacos = [];
  let atual = '';
  for (const f of frases) {
    const limite = pedacos.length === 0 ? 150 : 320;
    if (atual && (atual + f).length > limite) { pedacos.push(atual.trim()); atual = f; }
    else atual += f;
  }
  if (atual.trim()) pedacos.push(atual.trim());
  return pedacos;
}

async function processarFila() {
  if (processandoFila) return;
  processandoFila = true;
  while (filaFalas.length > 0) {
    const item = filaFalas.shift();
    ultimaFala = item;
    cancelarFala = false;
    estadoFala = { tipo: 'falando', texto: item.texto, origem: item.origem, total: item.topicos.length };
    topicosNoAr = [];
    transmitir(estadoFala);
    // pedaços de áudio de todos os tópicos em fila única; cada um sabe de qual tópico é
    const pedacos = [], donos = [];
    item.topicos.forEach((topico, indice) => {
      dividirEmPedacos(topico.fala).forEach((pedaco, n) => { pedacos.push(pedaco); donos.push({ indice, abre: n === 0 }); });
    });
    let proximaGeracao = gerarAudio(pedacos[0], 0);
    for (let i = 0; i < pedacos.length; i++) {
      const arquivo = await proximaGeracao;
      if (i + 1 < pedacos.length) proximaGeracao = gerarAudio(pedacos[i + 1], i + 1);
      if (cancelarFala) break;
      // o cartão do tópico surge no painel na hora em que o Jarvis começa a falar dele
      if (donos[i].abre) {
        const topico = item.topicos[donos[i].indice];
        const aviso = { tipo: 'topico', indice: donos[i].indice, total: item.topicos.length, texto: topico.texto };
        topicosNoAr.push(aviso);
        transmitir(aviso);
      }
      // volume real da voz, pras barras do orbe
      transmitir({ tipo: 'trecho', envelope: arquivo ? await envelopeDe(arquivo) : null });
      if (!arquivo) continue;
      await new Promise((fim) => {
        // mpv com canal de comando: a velocidade muda AO VIVO no meio da fala
        falaAtual = spawn(MPV, ['--no-video', '--really-quiet', '--input-ipc-server=' + MPV_SOCK,
          '--speed=' + config.velocidade, arquivo]);
        falaAtual.on('exit', () => { falaAtual = null; fim(); });
        falaAtual.on('error', () => { falaAtual = null; fim(); });
      });
    }
    estadoFala = null;
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
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { proc.kill(); resolve(false); }, prazoMs);
    if (entradaStdin !== undefined) proc.stdin.end(entradaStdin);
    proc.on('exit', (cod) => {
      clearTimeout(timer);
      if (cod !== 0) console.error('[Jarvis] ' + path.basename(cmd) + ' falhou: ' + stderr.slice(0, 200));
      resolve(cod === 0);
    });
    proc.on('error', (e) => { clearTimeout(timer); console.error('[Jarvis] ' + path.basename(cmd) + ': ' + e.message); resolve(false); });
  });
}

// Volume da fala a cada 50 ms (0 a 99): as barras do painel acompanham a voz de verdade
function envelopeDe(arquivo) {
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-v', 'error', '-i', arquivo, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 50, timeout: 8000 }, (err, pcm) => {
        if (err || !pcm || pcm.length < 1600) return resolve(null);
        const JANELA = 400, volumes = [];
        let maior = 1;
        for (let i = 0; i + JANELA * 2 <= pcm.length; i += JANELA * 2) {
          let soma = 0;
          for (let j = 0; j < JANELA; j++) { const a = pcm.readInt16LE(i + j * 2); soma += a * a; }
          const rms = Math.sqrt(soma / JANELA);
          volumes.push(rms);
          if (rms > maior) maior = rms;
        }
        resolve(volumes.map((v) => Math.round((v / maior) * 99)));
      });
  });
}

// REGRA DO WYLLE: NUNCA trocar a voz. É o Antonio ou silêncio (o texto fica no painel).
async function gerarAudio(fala, indice) {
  const mp3 = path.join(TMP, 'fala-' + (indice || 0) + '.mp3');
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    if (await rodarComPrazo(EDGE_TTS, ['--voice', VOZ_EDGE, '--text', pronunciar(fala), '--write-media', mp3], 15000)) {
      if (fs.existsSync(mp3) && fs.statSync(mp3).size > 1000) return mp3;
    }
    if (tentativa < 3) await new Promise((f) => setTimeout(f, 800 * tentativa));
  }
  console.error('[Jarvis] voz indisponível após 3 tentativas; pedaço pulado (regra: nunca trocar a voz)');
  return null;
}

async function transcrever(arquivoAudio) {
  if (!fs.existsSync(MODELO_WHISPER)) {
    throw new Error('O microfone do painel não está instalado neste Mac. Use o campo de texto, ou peça ao Claude pra instalar o whisper.');
  }
  const wav = path.join(TMP, 'entrada.wav');
  await rodar(FFMPEG, ['-y', '-loglevel', 'error', '-i', arquivoAudio, '-ar', '16000', '-ac', '1', wav]);
  const texto = await rodar(WHISPER, ['-m', MODELO_WHISPER, '-l', 'pt', '-f', wav, '-np', '-nt'], { timeout: 180000 });
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

    // painel anterior (nébula sozinha) continua disponível em /v1
    if (req.method === 'GET' && (caminho === '/v1' || caminho === '/v2' || caminho === '/v3' || caminho === '/v4' || caminho === '/v5')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(PUBLIC, caminho.slice(1) + '.html')));
      return;
    }

    // foto opcional pro centro do orbe: basta salvar como public/rosto.jpg
    if (req.method === 'GET' && caminho === '/rosto.jpg' && fs.existsSync(ROSTO)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(ROSTO));
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
      res.write('data: ' + JSON.stringify({ tipo: 'conectado', velocidade: config.velocidade, rosto: fs.existsSync(ROSTO) }) + '\n\n');
      if (estadoFala) {
        res.write('data: ' + JSON.stringify(estadoFala) + '\n\n');
        for (const aviso of topicosNoAr) res.write('data: ' + JSON.stringify(aviso) + '\n\n');
      }
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

    if (req.method === 'POST' && caminho === '/api/repetir') {
      if (!ultimaFala) return responderJson(res, 200, { ok: false });
      if (!processandoFila && filaFalas.length === 0) { filaFalas.push(ultimaFala); processarFila(); }
      return responderJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && caminho === '/api/parar') {
      filaFalas = [];
      cancelarFala = true;
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
