'use strict';

/* =====================================================================
   Painel · servidor
   Serve a página, lê os YAMLs da pasta de dados e transmite o monitor
   do sistema por WebSocket a cada 2 segundos.
   ===================================================================== */

const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const yaml = require('js-yaml');
const si = require('systeminformation');
const WebSocket = require('ws');

const PORTA = Number(process.env.PORT) || 3000;
const DADOS = process.env.DADOS_DIR || path.join(__dirname, 'data');
const HOST_PROC = process.env.HOST_PROC || '/host/proc';
const HOST_ROOT = process.env.HOST_ROOT || '/host/root';
const PASTA_FUNDOS = path.join(__dirname, 'public', 'images');

const INTERVALO_MONITOR = 2000;   // uma amostra a cada 2 s
const TAMANHO_HISTORICO = 90;     // 90 amostras = 3 minutos de gráfico
const INTERVALO_DISCOS = 10000;   // disco muda devagar, 10 s basta
const INTERVALO_SERVICOS = 60000; // testa os serviços a cada minuto

const CONFIG_PADRAO = {
    titulo: 'Painel',
    discos: [{ nome: 'Sistema', caminho: HOST_ROOT }],
    rede: { interfaces: [], prefixo_local: '192.168.' },
    verificar_servicos: true
};

/* ---------- YAML: relê assim que o arquivo muda ---------- */

const cacheYaml = new Map();

async function lerYaml(nome) {
    const arquivo = path.join(DADOS, nome);
    const anterior = cacheYaml.get(nome);
    let mtime;
    try {
        mtime = (await fsp.stat(arquivo)).mtimeMs;
    } catch (e) {
        return { dados: null, erro: e.code === 'ENOENT' ? null : e.message };
    }
    if (anterior && anterior.mtime === mtime) return anterior.resultado;

    let resultado;
    try {
        resultado = { dados: yaml.load(await fsp.readFile(arquivo, 'utf8')), erro: null };
    } catch (e) {
        // Arquivo com erro: mostra o aviso, mas continua com a última versão boa
        const msg = e.mark ? `linha ${e.mark.line + 1}: ${e.reason}` : e.message;
        console.error(`[yaml] ${nome}: ${msg}`);
        resultado = { dados: anterior ? anterior.ultimaBoa : null, erro: msg };
    }
    cacheYaml.set(nome, {
        mtime,
        resultado,
        ultimaBoa: resultado.erro ? (anterior && anterior.ultimaBoa) : resultado.dados
    });
    return resultado;
}

async function lerConfig() {
    const { dados } = await lerYaml('config.yaml');
    const c = dados || {};
    return {
        ...CONFIG_PADRAO,
        ...c,
        discos: Array.isArray(c.discos) && c.discos.length ? c.discos : CONFIG_PADRAO.discos,
        rede: { ...CONFIG_PADRAO.rede, ...(c.rede || {}) }
    };
}

const lista = (v) => (Array.isArray(v) ? v : []);

/* ---------- Discos: statfs no caminho, sem depender do df ---------- */

let discosCache = [];

async function lerDiscos() {
    const { discos } = await lerConfig();
    const resultado = await Promise.all(discos.map(async (d) => {
        try {
            const [s, st] = await Promise.all([fsp.statfs(d.caminho), fsp.stat(d.caminho)]);
            const total = s.blocks * s.bsize;
            const livre = s.bavail * s.bsize;
            const usado = (s.blocks - s.bfree) * s.bsize;
            const percentual = usado + livre > 0 ? (usado / (usado + livre)) * 100 : 0;
            return { nome: d.nome, total, usado, livre, percentual: +percentual.toFixed(1), dispositivo: st.dev };
        } catch (e) {
            const erro = e.code === 'ENOENT'
                ? `O caminho ${d.caminho} não existe dentro do container`
                : `Não consegui ler ${d.caminho} (${e.code || e.message})`;
            return { nome: d.nome, erro };
        }
    }));

    // Dois discos no mesmo dispositivo quase sempre significa que o HD
    // não estava montado e a pasta vazia caiu no disco do sistema.
    const vistos = new Map();
    for (const d of resultado) {
        if (d.dispositivo === undefined) continue;
        if (vistos.has(d.dispositivo)) {
            d.aviso = `Está no mesmo disco que "${vistos.get(d.dispositivo)}". Confira se ele está montado no host.`;
        } else {
            vistos.set(d.dispositivo, d.nome);
        }
        delete d.dispositivo;
    }
    discosCache = resultado;
}

/* ---------- Rede: lê a rede do host, não a do container ---------- */

// Interfaces virtuais que só duplicariam o tráfego da placa física
const VIRTUAIS = /^(lo|docker|br-|veth|virbr|vnet|tailscale|tun|tap|wg|zt|cni|flannel|kube|ifb|dummy)/;
let redeAnterior = null;

function interpretarNetDev(texto) {
    const interfaces = {};
    for (const linha of texto.split('\n').slice(2)) {
        const i = linha.indexOf(':');
        if (i < 0) continue;
        const nome = linha.slice(0, i).trim();
        const campos = linha.slice(i + 1).trim().split(/\s+/).map(Number);
        interfaces[nome] = { rx: campos[0], tx: campos[8] };
    }
    return interfaces;
}

async function lerRede(escolhidas) {
    let texto;
    let fonte = 'host';
    try {
        // /proc/1 é o init do host: o net/dev dele mostra a rede de verdade
        texto = await fsp.readFile(path.join(HOST_PROC, '1/net/dev'), 'utf8');
    } catch {
        texto = await fsp.readFile('/proc/net/dev', 'utf8');
        fonte = 'container';
    }

    const todas = interpretarNetDev(texto);
    const nomes = lista(escolhidas).length
        ? lista(escolhidas).filter((n) => todas[n])
        : Object.keys(todas).filter((n) => !VIRTUAIS.test(n));

    let rx = 0;
    let tx = 0;
    for (const n of nomes) { rx += todas[n].rx; tx += todas[n].tx; }

    const agora = Date.now();
    let download = 0;
    let upload = 0;
    if (redeAnterior && redeAnterior.chave === nomes.join(',')) {
        const dt = (agora - redeAnterior.t) / 1000;
        if (dt > 0) {
            download = Math.max(0, (rx - redeAnterior.rx) / dt); // contador zerado vira 0, não negativo
            upload = Math.max(0, (tx - redeAnterior.tx) / dt);
        }
    }
    redeAnterior = { t: agora, rx, tx, chave: nomes.join(',') };
    return { download, upload, interfaces: nomes, fonte };
}

/* ---------- Monitor ---------- */

let amostraAtual = null;
const historico = [];
let coletando = false;

async function coletar() {
    if (coletando) return;
    coletando = true;
    try {
        const config = await lerConfig();
        const [carga, temperatura, memoria, rede] = await Promise.all([
            si.currentLoad(),
            si.cpuTemperature().catch(() => ({})),
            si.mem(),
            lerRede(config.rede.interfaces).catch((e) => ({ download: 0, upload: 0, interfaces: [], fonte: 'erro', erro: e.message }))
        ]);

        const t = Date.now();
        amostraAtual = {
            t,
            cpu: {
                uso: +carga.currentLoad.toFixed(1),
                temperatura: temperatura.main > 0 ? Math.round(temperatura.main) : null,
                nucleos: (carga.cpus || []).length
            },
            memoria: {
                total: memoria.total,
                usada: memoria.active,
                percentual: +((memoria.active / memoria.total) * 100).toFixed(1)
            },
            discos: discosCache,
            rede,
            ligadoHa: os.uptime()
        };

        historico.push({ t, cpu: amostraAtual.cpu.uso, rx: rede.download, tx: rede.upload });
        if (historico.length > TAMANHO_HISTORICO) historico.shift();

        transmitir({ tipo: 'amostra', amostra: amostraAtual });
    } catch (e) {
        console.error('[monitor]', e.message);
    } finally {
        coletando = false;
    }
}

/* ---------- Serviços e projetos: estão no ar? ---------- */

const estados = {};

async function testar(url) {
    const inicio = Date.now();
    try {
        const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
        r.body?.cancel().catch(() => {});
        // Qualquer resposta HTTP conta, até 401 ou 404: o serviço respondeu
        return { online: true, codigo: r.status, ms: Date.now() - inicio };
    } catch (e) {
        const causa = e.cause && e.cause.code ? String(e.cause.code) : '';
        // Certificado autoassinado também significa que o serviço respondeu
        if (/CERT|TLS|SSL/.test(causa)) return { online: true, ms: Date.now() - inicio };
        return { online: false, motivo: causa || e.name };
    }
}

// Cada item tem dois endereços (url_tailscale, url_local); o teste do servidor,
// que roda dentro do container, não depende de rede do navegador: usa o local
// (está na mesma rede do host) e cai pro tailscale se não houver.
function urlVerificar(i) { return i.verificar_url || i.url_local || i.url_tailscale || i.url || ''; }
function chaveItem(prefixo, i) { return `${prefixo}:${i.name || i.nome}`; }

async function verificarServicos() {
    const config = await lerConfig();
    if (!config.verificar_servicos) return;
    const [servidor, projetos] = await Promise.all([lerYaml('dashboard.yaml'), lerYaml('projetos.yaml')]);
    const itens = [
        ...lista(servidor.dados && servidor.dados.Dashboard).filter(Boolean).map((i) => ({ chave: chaveItem('servico', i), url: urlVerificar(i), verificar: i.verificar })),
        ...lista(projetos.dados && projetos.dados.projetos).filter(Boolean).map((i) => ({ chave: chaveItem('projeto', i), url: urlVerificar(i), verificar: i.verificar }))
    ].filter((i) => i.verificar !== false && /^https?:\/\//.test(i.url));

    await Promise.all(itens.map(async (i) => {
        estados[i.chave] = { ...(await testar(i.url)), em: Date.now() };
    }));
}

/* ---------- HTTP ---------- */

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

function rota(caminho, fn) {
    app.get(caminho, async (req, res) => {
        try {
            res.json(await fn(req));
        } catch (e) {
            console.error(`[${caminho}]`, e);
            res.status(500).json({ erro: 'Erro interno do servidor' });
        }
    });
}

rota('/api/config', async () => {
    const c = await lerConfig();
    return { titulo: c.titulo, prefixoLocal: c.rede.prefixo_local };
});

rota('/api/servidor', async () => {
    const { dados, erro } = await lerYaml('dashboard.yaml');
    return { itens: lista(dados && dados.Dashboard), erro };
});

rota('/api/projetos', async () => {
    const { dados, erro } = await lerYaml('projetos.yaml');
    return { projetos: lista(dados && dados.projetos), erro };
});

rota('/api/favoritos', async () => {
    const { dados, erro } = await lerYaml('bookmarks.yaml');
    return { categorias: lista(dados && dados.categories), erro };
});

rota('/api/estado', async () => estados);

rota('/api/fundos', async () => {
    const arquivos = await fsp.readdir(PASTA_FUNDOS).catch(() => []);
    return arquivos
        .filter((a) => /\.(gif|webp|png|jpe?g)$/i.test(a))
        .map((a) => `/images/${encodeURIComponent(a)}`);
});

rota('/api/sistema', async () => ({ amostra: amostraAtual, historico }));

rota('/api/saude', async () => ({
    status: 'ok',
    ligadoHa: process.uptime(),
    clientes: wss.clients.size
}));

/* ---------- WebSocket ---------- */

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws', perMessageDeflate: { threshold: 1024 } });

function transmitir(mensagem) {
    if (wss.clients.size === 0) return;
    const texto = JSON.stringify(mensagem);
    for (const c of wss.clients) {
        if (c.readyState === WebSocket.OPEN) c.send(texto);
    }
}

wss.on('connection', (ws) => {
    ws.vivo = true;
    ws.on('pong', () => { ws.vivo = true; });
    ws.on('error', (e) => console.error('[ws]', e.message));
    ws.send(JSON.stringify({ tipo: 'inicio', amostra: amostraAtual, historico }));
});

// Derruba conexões que pararam de responder
const batimento = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.vivo) { ws.terminate(); continue; }
        ws.vivo = false;
        ws.ping();
    }
}, 30000);

/* ---------- Início e encerramento ---------- */

async function iniciar() {
    await lerDiscos();
    for (const d of discosCache) {
        if (d.erro) console.warn(`[disco] ${d.nome}: ${d.erro}`);
        else console.log(`[disco] ${d.nome}: ${(d.total / 1e9).toFixed(1)} GB${d.aviso ? ` (${d.aviso})` : ''}`);
    }
    await coletar();
    console.log(`[rede] lendo a rede do ${amostraAtual ? amostraAtual.rede.fonte : '?'}: ${amostraAtual ? amostraAtual.rede.interfaces.join(', ') : ''}`);

    setInterval(coletar, INTERVALO_MONITOR);
    setInterval(() => lerDiscos().catch((e) => console.error('[disco]', e.message)), INTERVALO_DISCOS);
    verificarServicos().catch((e) => console.error('[serviços]', e.message));
    setInterval(() => verificarServicos().catch((e) => console.error('[serviços]', e.message)), INTERVALO_SERVICOS);

    server.listen(PORTA, '0.0.0.0', () => console.log(`Painel em http://localhost:${PORTA}`));
}

function encerrar(sinal) {
    console.log(`${sinal} recebido, encerrando`);
    clearInterval(batimento);
    for (const c of wss.clients) c.close(1001, 'Servidor desligando');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
process.on('unhandledRejection', (motivo) => console.error('Promise rejeitada sem tratamento:', motivo));

iniciar();
