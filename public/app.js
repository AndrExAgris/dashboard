'use strict';

/* =====================================================================
   Painel · app.js
   Abas pela âncora da URL (#servidor, #projetos, #favoritos), dados
   vindos dos YAMLs pela API e monitor ao vivo por WebSocket.
   ===================================================================== */

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

/* Cria elementos sem innerHTML, então nada do YAML vira HTML */
function h(tag, props, ...filhos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const f of filhos.flat(Infinity)) {
        if (f == null || f === false) continue;
        el.append(f instanceof Node ? f : String(f));
    }
    return el;
}
const icone = (nome) => h('span', { class: 'icone', 'aria-hidden': 'true' }, nome);

const normalizar = (t) => String(t || '').toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

async function buscarJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url} respondeu ${r.status}`);
    return r.json();
}

function mostrarAviso(painel, texto, tipo = 'erro') {
    const alvo = $(`[data-aviso="${painel}"]`);
    alvo.replaceChildren();
    if (!texto) return;
    alvo.append(h('div', { class: 'alerta', 'data-tipo': tipo, role: 'status' },
        icone(tipo === 'erro' ? 'error' : 'warning'),
        h('div', null, h('p', null, texto))));
}

function vazio(nomeIcone, titulo, texto) {
    return h('div', { class: 'vazio' }, icone(nomeIcone), h('strong', null, titulo), texto ? h('p', { class: 'pequeno' }, texto) : null);
}

/* Ícone: URL de imagem, emoji ou a primeira letra do nome */
function miniatura(item, nome) {
    const fonte = item.iconurl || item.icone || '';
    if (/^(https?:|\/|data:)/.test(fonte)) {
        const img = h('img', { src: fonte, alt: '', loading: 'lazy' });
        img.addEventListener('error', () => img.replaceWith(String(nome || '?').charAt(0).toUpperCase()), { once: true });
        return h('span', { class: 'miniatura' }, img);
    }
    return h('span', { class: 'miniatura', 'aria-hidden': 'true' }, fonte || String(nome || '?').charAt(0).toUpperCase());
}

const etiquetas = (tags) => (Array.isArray(tags) && tags.length
    ? h('div', { class: 'etiquetas' }, tags.map((t) => h('span', { class: 'etiqueta' }, t)))
    : null);

/* ---------- Abas ---------- */

const ABAS = { servidor: 'Servidor', projetos: 'Projetos', favoritos: 'Favoritos' };
let titulo = 'Painel';

function abaAtual() {
    const pedida = location.hash.slice(1);
    return pedida in ABAS ? pedida : 'servidor';
}

function mostrarAba() {
    const aba = abaAtual();
    $$('[data-painel]').forEach((p) => { p.hidden = p.dataset.painel !== aba; });
    $$('[data-aba]').forEach((a) => {
        if (a.dataset.aba === aba) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });
    document.title = `${ABAS[aba]} | ${titulo}`;
    window.scrollTo({ top: 0 });
}

window.addEventListener('hashchange', mostrarAba);

/* "/" foca a busca da aba aberta */
document.addEventListener('keydown', (ev) => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const campo = $(`[data-painel="${abaAtual()}"] [data-busca]`);
    if (campo) { ev.preventDefault(); campo.focus(); }
});

/* ---------- DNS dinâmico: tailscale fora de casa, rede local em casa ---------- */

// Trocado pelo valor de rede.prefixo_local do config.yaml antes de desenhar os cartões
let PREFIXO_LOCAL = '192.168.';
let EM_CASA = false;

async function detectarRede() {
    try {
        const c = await buscarJson('/api/config');
        titulo = c.titulo || titulo;
        PREFIXO_LOCAL = c.prefixoLocal || PREFIXO_LOCAL;
    } catch { /* fica com os padrões */ }
    EM_CASA = location.hostname.startsWith(PREFIXO_LOCAL);
    $$('[data-titulo]').forEach((el) => { el.textContent = titulo; });
    document.title = `${ABAS[abaAtual()]} | ${titulo}`;
}

// Mesma porta, IP diferente: em casa usa a rede local (sem passar pelo tailscale);
// fora, usa o tailscale. Itens antigos com só "url" caem nos dois casos.
function escolherUrl(item) {
    return EM_CASA
        ? (item.url_local || item.url_tailscale || item.url)
        : (item.url_tailscale || item.url_local || item.url);
}

const chaveServico = (s) => `servico:${s.name}`;
const chaveProjeto = (p) => `projeto:${p.nome}`;

/* ---------- Estado dos serviços (no ar ou não) ---------- */

let estados = {};

function pontoDeEstado(chave) {
    const e = estados[chave];
    if (!e) return h('span', { class: 'estado', title: 'Ainda não testado' }, h('span', { class: 'so-leitor' }, 'Ainda não testado'));
    return e.online
        ? h('span', { class: 'estado', 'data-estado': 'on', title: e.ms != null ? `Respondeu em ${e.ms} ms` : 'No ar' }, 'No ar')
        : h('span', { class: 'estado', 'data-estado': 'off', title: e.motivo ? `Sem resposta (${e.motivo})` : 'Sem resposta' }, 'Sem resposta');
}

async function atualizarEstados() {
    try {
        estados = await buscarJson('/api/estado');
        $$('[data-estado-de]').forEach((alvo) => alvo.replaceChildren(pontoDeEstado(alvo.dataset.estadoDe)));
        resumirServicos();
    } catch { /* fica com o último estado conhecido */ }
}

/* ---------- Servidor ---------- */

let servicos = [];

function resumirServicos() {
    const testados = servicos.filter((s) => estados[chaveServico(s)]);
    const noAr = testados.filter((s) => estados[chaveServico(s)].online).length;
    $('[data-resumo-servicos]').textContent = testados.length
        ? `${noAr} de ${testados.length} no ar`
        : '';
}

function cartaoServico(s) {
    const chave = chaveServico(s);
    return h('a', { class: 'cartao cartao-interativo servico', href: escolherUrl(s), target: '_blank', rel: 'noopener noreferrer' },
        miniatura(s, s.name),
        h('div', { style: 'min-width: 0' },
            h('div', { class: 'servico-topo' },
                h('h2', null, s.name),
                h('span', { 'data-estado-de': chave }, pontoDeEstado(chave))),
            s.descricao ? h('p', { class: 'servico-descricao' }, s.descricao) : null,
            etiquetas(s.tags)));
}

async function carregarServidor() {
    const lista = $('[data-lista-servicos]');
    try {
        const { itens, erro } = await buscarJson('/api/servidor');
        servicos = itens.filter((s) => s && s.name && (s.url || s.url_tailscale || s.url_local));
        mostrarAviso('servidor', erro ? `O dashboard.yaml tem um erro (${erro}). Mostrando a última versão que funcionou.` : null);
        lista.replaceChildren(...(servicos.length
            ? servicos.map(cartaoServico)
            : [vazio('dns', 'Nenhum serviço cadastrado', 'Adicione serviços no dashboard.yaml, na pasta dados.')]));
        resumirServicos();
    } catch (e) {
        lista.replaceChildren(vazio('cloud_off', 'Não consegui carregar os serviços', e.message));
    }
    lista.removeAttribute('aria-busy');
}

/* ---------- Monitor ao vivo ---------- */

const GB = 1024 ** 3;
const num = (n, casas = 1) => n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

function formatarTaxa(bytes) {
    if (bytes < 1024) return `${Math.round(bytes)} B/s`;
    if (bytes < 1024 ** 2) return `${num(bytes / 1024)} KB/s`;
    return `${num(bytes / 1024 ** 2)} MB/s`;
}

function formatarTamanho(bytes) {
    return bytes >= 1024 ** 4 ? `${num(bytes / 1024 ** 4, 2)} TB` : `${num(bytes / GB)} GB`;
}

function formatarLigado(segundos) {
    const dias = Math.floor(segundos / 86400);
    const horas = Math.floor((segundos % 86400) / 3600);
    if (dias > 0) return `Ligado há ${dias} ${dias === 1 ? 'dia' : 'dias'} e ${horas} h`;
    const min = Math.floor((segundos % 3600) / 60);
    return `Ligado há ${horas} h ${min} min`;
}

function preencherBarra(barra, percentual) {
    const p = Math.min(Math.max(percentual || 0, 0), 100);
    barra.firstElementChild.style.width = `${p}%`;
    barra.dataset.nivel = p >= 85 ? 'alto' : p >= 65 ? 'medio' : 'baixo';
    barra.setAttribute('role', 'meter');
    barra.setAttribute('aria-valuemin', '0');
    barra.setAttribute('aria-valuemax', '100');
    barra.setAttribute('aria-valuenow', String(Math.round(p)));
}

/* Desenha uma ou mais séries num SVG de 100 x 24 */
function desenharGrafico(svg, series, maximo, comArea) {
    const N = 90;
    const ns = 'http://www.w3.org/2000/svg';
    svg.replaceChildren();
    series.forEach((valores, i) => {
        if (valores.length < 2) return;
        const inicio = N - valores.length;
        const pontos = valores.map((v, j) => {
            const x = ((inicio + j) / (N - 1)) * 100;
            const y = 23 - (Math.min(v, maximo) / maximo) * 22;
            return `${x.toFixed(2)},${y.toFixed(2)}`;
        });
        if (comArea && i === 0) {
            const area = document.createElementNS(ns, 'path');
            area.setAttribute('class', 'area');
            area.setAttribute('d', `M${pontos[0].split(',')[0]},24 L${pontos.join(' L')} L100,24 Z`);
            svg.append(area);
        }
        const linha = document.createElementNS(ns, 'path');
        linha.setAttribute('class', `linha-${i + 1}`);
        linha.setAttribute('d', `M${pontos.join(' L')}`);
        svg.append(linha);
    });
}

let historico = [];
let chaveDiscos = '';

function desenharDiscos(discos) {
    const caixa = $('[data-discos]');
    const chave = discos.map((d) => d.nome).join('|');
    if (chave !== chaveDiscos) {
        chaveDiscos = chave;
        const cores = ['var(--cor-dado-5)', 'var(--cor-dado-3)', 'var(--cor-dado-2)', 'var(--cor-dado-4)'];
        caixa.replaceChildren(...discos.map((d, i) => h('div', { class: 'medida', 'data-disco': d.nome },
            h('div', { class: 'medida-topo' },
                h('span', { class: 'medida-nome' }, icone('hard_drive'), d.nome),
                h('span', { class: 'medida-valor', 'data-disco-texto': '' })),
            h('div', { class: 'barra', style: `--cor-barra: ${cores[i % cores.length]}` }, h('span')),
            h('p', { class: 'medida-aviso', 'data-disco-aviso': '', hidden: true }))));
    }
    discos.forEach((d) => {
        const bloco = $$('[data-disco]', caixa).find((b) => b.dataset.disco === d.nome);
        if (!bloco) return;
        const texto = $('[data-disco-texto]', bloco);
        const aviso = $('[data-disco-aviso]', bloco);
        if (d.erro) {
            texto.textContent = 'Indisponível';
            preencherBarra($('.barra', bloco), 0);
            aviso.textContent = d.erro;
            aviso.dataset.tipo = 'erro';
            aviso.hidden = false;
            return;
        }
        texto.textContent = `${formatarTamanho(d.usado)} de ${formatarTamanho(d.total)}`;
        texto.title = `${num(d.percentual)}% usado, ${formatarTamanho(d.livre)} livres`;
        preencherBarra($('.barra', bloco), d.percentual);
        aviso.textContent = d.aviso || '';
        delete aviso.dataset.tipo;
        aviso.hidden = !d.aviso;
    });
}

function desenharMonitor(a) {
    if (!a) return;

    $('[data-cpu-uso]').textContent = `${num(a.cpu.uso)}%`;
    $('[data-cpu-temp]').textContent = a.cpu.temperatura != null ? `${a.cpu.temperatura} °C` : '';
    preencherBarra($('[data-barra="cpu"]'), a.cpu.uso);

    $('[data-ram-texto]').textContent = `${formatarTamanho(a.memoria.usada)} de ${formatarTamanho(a.memoria.total)}`;
    preencherBarra($('[data-barra="ram"]'), a.memoria.percentual);

    desenharDiscos(a.discos || []);

    $('[data-rede-down]').textContent = formatarTaxa(a.rede.download);
    $('[data-rede-up]').textContent = formatarTaxa(a.rede.upload);
    const avisoRede = $('[data-rede-aviso]');
    if (a.rede.fonte === 'container') {
        avisoRede.textContent = 'Lendo só a rede do container. Confira se o /proc do host está montado em /host/proc.';
        avisoRede.hidden = false;
    } else if (a.rede.fonte === 'erro') {
        avisoRede.textContent = `Não consegui ler a rede: ${a.rede.erro}`;
        avisoRede.hidden = false;
    } else if (!a.rede.interfaces.length) {
        avisoRede.textContent = 'Nenhuma interface de rede encontrada. Defina rede.interfaces no config.yaml.';
        avisoRede.hidden = false;
    } else {
        avisoRede.hidden = true;
    }

    $('[data-ligado-ha]').textContent = formatarLigado(a.ligadoHa);
    $('[data-interfaces]').textContent = a.rede.interfaces.join(', ');

    desenharGrafico($('[data-grafico="cpu"]'), [historico.map((p) => p.cpu)], 100, true);
    const picoRede = Math.max(1024, ...historico.map((p) => Math.max(p.rx, p.tx)));
    desenharGrafico($('[data-grafico="rede"]'), [historico.map((p) => p.rx), historico.map((p) => p.tx)], picoRede * 1.1, false);
}

function marcarConexao(estado) {
    const el = $('[data-conexao]');
    el.dataset.conexao = estado;
    el.textContent = { conectando: 'Conectando', 'ao-vivo': 'Ao vivo', caiu: 'Sem conexão' }[estado];
}

let tentativas = 0;

function conectarMonitor() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.addEventListener('open', () => { tentativas = 0; marcarConexao('ao-vivo'); });
    ws.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.tipo === 'inicio') {
            historico = m.historico || [];
        } else if (m.tipo === 'amostra' && m.amostra) {
            const a = m.amostra;
            historico.push({ t: a.t, cpu: a.cpu.uso, rx: a.rede.download, tx: a.rede.upload });
            if (historico.length > 90) historico.shift();
        }
        desenharMonitor(m.amostra);
    });
    ws.addEventListener('close', () => {
        marcarConexao(tentativas === 0 ? 'conectando' : 'caiu');
        // Tenta para sempre, esperando no máximo 30 s entre tentativas
        setTimeout(conectarMonitor, Math.min(30000, 1000 * 2 ** tentativas++));
    });
}

/* ---------- Projetos ---------- */

let projetos = [];

function cartaoProjeto(p) {
    const temUrl = !!(p.url || p.url_tailscale || p.url_local);
    const url = temUrl ? escolherUrl(p) : null;
    const chave = chaveProjeto(p);
    const nome = url
        ? h('a', { class: 'projeto-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, p.nome)
        : p.nome;
    const repo = p.repo
        ? h('a', {
            class: 'botao botao-fantasma',
            href: /^https?:/.test(p.repo) ? p.repo : `https://github.com/${p.repo}`,
            target: '_blank',
            rel: 'noopener noreferrer'
        }, icone('code'), 'Código')
        : null;
    return h('article', { class: 'cartao projeto' },
        h('div', { class: 'projeto-topo' },
            miniatura(p, p.nome),
            h('h3', null, nome),
            temUrl ? h('span', { 'data-estado-de': chave }, pontoDeEstado(chave)) : null),
        p.descricao ? h('p', { class: 'projeto-descricao' }, p.descricao) : null,
        etiquetas(p.tags),
        (repo || !temUrl) ? h('div', { class: 'projeto-rodape' },
            repo,
            temUrl ? null : h('span', { class: 'projeto-sem-link' }, 'Ainda sem endereço')) : null);
}

function desenharProjetos() {
    const caixa = $('[data-lista-projetos]');
    const termo = normalizar($('[data-busca="projetos"]').value.trim());
    const visiveis = projetos.filter((p) => !termo || normalizar([p.nome, p.descricao, ...(p.tags || [])].join(' ')).includes(termo));

    if (!projetos.length) {
        caixa.replaceChildren(vazio('construction', 'Nenhum projeto cadastrado', 'Adicione projetos no projetos.yaml, na pasta dados.'));
        return;
    }
    if (!visiveis.length) {
        caixa.replaceChildren(vazio('search', 'Nenhum projeto encontrado', 'Tente outro nome ou tag.'));
        return;
    }

    caixa.replaceChildren(h('div', { class: 'grade projetos' }, visiveis.map(cartaoProjeto)));
}

async function carregarProjetos() {
    const caixa = $('[data-lista-projetos]');
    try {
        const { projetos: lista, erro } = await buscarJson('/api/projetos');
        projetos = lista.filter((p) => p && p.nome);
        mostrarAviso('projetos', erro ? `O projetos.yaml tem um erro (${erro}). Mostrando a última versão que funcionou.` : null);
        desenharProjetos();
    } catch (e) {
        caixa.replaceChildren(vazio('cloud_off', 'Não consegui carregar os projetos', e.message));
    }
    caixa.removeAttribute('aria-busy');
}

$('[data-busca="projetos"]').addEventListener('input', desenharProjetos);

/* ---------- Favoritos ---------- */

const favicon = (url) => `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(url)}`;

function abrirTodos(itens, nomeLista) {
    if (itens.length > 10 && !confirm(`Abrir ${itens.length} links de ${nomeLista}?`)) return;
    // Pequeno intervalo entre abas para o navegador não bloquear
    itens.forEach((item, i) => setTimeout(() => window.open(item.url, '_blank', 'noopener,noreferrer'), i * 100));
}

function itemFavorito(item) {
    const img = h('img', { src: favicon(item.url), alt: '', loading: 'lazy' });
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true });
    return h('a', { class: 'fav', href: item.url, target: '_blank', rel: 'noopener noreferrer' },
        img,
        h('span', null,
            h('span', { class: 'fav-titulo' }, item.title),
            item.tags && item.tags.length ? h('span', { class: 'fav-tags' }, item.tags.join(', ')) : null));
}

let categorias = [];

function desenharFavoritos() {
    const caixa = $('[data-lista-favoritos]');
    const termo = normalizar($('[data-busca="favoritos"]').value.trim());

    const filtradas = categorias.map((cat) => {
        const catCasa = termo && normalizar(cat.name).includes(termo);
        const listas = (cat.lists || []).map((l) => {
            const listaCasa = catCasa || (termo && normalizar(l.name).includes(termo));
            const itens = (l.items || []).filter((i) => i && i.url && i.title &&
                (!termo || listaCasa || normalizar([i.title, ...(i.tags || [])].join(' ')).includes(termo)));
            return { ...l, items: itens };
        }).filter((l) => l.name && l.items.length);
        return { ...cat, lists: listas };
    }).filter((c) => c.name && c.lists.length);

    if (!filtradas.length) {
        caixa.replaceChildren(termo
            ? vazio('search', 'Nenhum favorito encontrado', 'Tente outro título, tag ou categoria.')
            : vazio('bookmarks', 'Nenhum favorito cadastrado', 'Adicione links no bookmarks.yaml, na pasta dados.'));
        return;
    }

    caixa.replaceChildren(...filtradas.map((cat) => h('section', { class: 'cartao categoria' },
        h('h2', null, cat.name),
        cat.lists.map((l) => h('div', { class: 'lista-fav' },
            h('div', { class: 'lista-fav-topo' },
                h('h3', null, l.name),
                h('button', {
                    class: 'botao botao-fantasma botao-icone',
                    type: 'button',
                    title: `Abrir todos os links de ${l.name}`,
                    'aria-label': `Abrir todos os links de ${l.name}`,
                    onclick: () => abrirTodos(l.items, l.name)
                }, icone('open_in_new'))),
            l.items.map(itemFavorito))))));
}

async function carregarFavoritos() {
    const caixa = $('[data-lista-favoritos]');
    try {
        const { categorias: lista, erro } = await buscarJson('/api/favoritos');
        categorias = lista;
        mostrarAviso('favoritos', erro ? `O bookmarks.yaml tem um erro (${erro}). Mostrando a última versão que funcionou.` : null);
        desenharFavoritos();
    } catch (e) {
        caixa.replaceChildren(vazio('cloud_off', 'Não consegui carregar os favoritos', e.message));
    }
    caixa.removeAttribute('aria-busy');
}

let esperaBusca;
$('[data-busca="favoritos"]').addEventListener('input', () => {
    clearTimeout(esperaBusca);
    esperaBusca = setTimeout(desenharFavoritos, 150);
});

/* ---------- Fundo, tema e configurações ---------- */

const CHAVE_FUNDO = 'painel:fundo';

function fundoLigado() {
    try { return localStorage.getItem(CHAVE_FUNDO) !== 'nao'; } catch { return true; }
}

async function aplicarFundo() {
    const ligado = fundoLigado();
    document.documentElement.dataset.fundo = ligado ? 'sim' : 'nao';
    $('[data-pref-fundo]').checked = ligado;
    const fundo = $('.fundo');
    if (!ligado || fundo.style.backgroundImage) return;
    try {
        const imagens = await buscarJson('/api/fundos');
        if (imagens.length) fundo.style.backgroundImage = `url("${imagens[Math.floor(Math.random() * imagens.length)]}")`;
    } catch { /* sem fundo, fica a cor do tema */ }
}

$('[data-pref-fundo]').addEventListener('change', (ev) => {
    try { localStorage.setItem(CHAVE_FUNDO, ev.target.checked ? 'sim' : 'nao'); } catch { /* ignora */ }
    aplicarFundo();
});

const dialogo = $('[data-config]');
$('[data-abrir-config]').addEventListener('click', () => dialogo.showModal());
$('[data-fechar-config]').addEventListener('click', () => dialogo.close());
dialogo.addEventListener('click', (ev) => { if (ev.target === dialogo) dialogo.close(); });

/* ---------- Início ---------- */

async function iniciar() {
    mostrarAba();
    aplicarFundo();
    conectarMonitor();

    // Antes dos cartões: eles já nascem com o endereço certo (local ou tailscale)
    await detectarRede();

    await Promise.all([carregarServidor(), carregarProjetos(), carregarFavoritos()]);
    atualizarEstados();
    setInterval(atualizarEstados, 30000);

    // Recarrega os YAMLs quando a aba do navegador volta a ficar visível
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        carregarServidor();
        carregarProjetos();
        carregarFavoritos();
        atualizarEstados();
    });
}

iniciar();
