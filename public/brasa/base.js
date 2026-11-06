/* =====================================================================
   Brasa · base.js
   Carregue no <head>, sem defer, logo depois do base.css:
     <script src="base.js"></script>
   Faz quatro coisas:
   1. Aplica as preferências salvas (tema, paleta, densidade, fonte,
      movimento) antes da página aparecer, sem piscar.
   2. Liga qualquer controle com data-pref="..." a essas preferências.
   3. Abre e fecha o menu lateral no celular (data-alternar-menu).
   4. Sinaliza rolagem: sombra no cabeçalho, bordas esmaecidas em
      .rolagem-x e item atual do índice em [data-acompanhar-rolagem].
   ===================================================================== */
(function () {
  "use strict";

  var raiz = document.documentElement;
  var CHAVE = "brasa:preferencias";

  /* O projeto define os próprios padrões no <html>, por exemplo:
     <html data-paleta="mare" data-densidade="compacta"> */
  var PADRAO = {
    tema: raiz.dataset.tema || "escuro",       /* escuro | claro | sistema */
    paleta: raiz.dataset.paleta || "sobria",   /* sobria | mare | ametista */
    densidade: raiz.dataset.densidade || "normal", /* compacta | normal | arejada */
    fonte: raiz.dataset.fonte || "m",          /* p | m | g */
    movimento: "sistema"                       /* sistema | reduzido */
  };

  var midiaClara = window.matchMedia("(prefers-color-scheme: light)");
  var midiaMovimento = window.matchMedia("(prefers-reduced-motion: reduce)");

  function copiar(o) { return JSON.parse(JSON.stringify(o)); }

  function ler() {
    var p = copiar(PADRAO);
    try {
      var salvo = JSON.parse(localStorage.getItem(CHAVE) || "{}");
      for (var k in salvo) if (k in p) p[k] = salvo[k];
    } catch (e) { /* armazenamento indisponível: segue com o padrão */ }
    return p;
  }

  function gravar() {
    try { localStorage.setItem(CHAVE, JSON.stringify(prefs)); } catch (e) {}
  }

  var prefs = ler();

  function aplicar() {
    var tema = prefs.tema === "sistema" ? (midiaClara.matches ? "claro" : "escuro") : prefs.tema;
    raiz.dataset.tema = tema;
    raiz.dataset.paleta = prefs.paleta;
    raiz.dataset.densidade = prefs.densidade;
    raiz.dataset.fonte = prefs.fonte;
    var reduzir = prefs.movimento === "reduzido" || (prefs.movimento === "sistema" && midiaMovimento.matches);
    raiz.dataset.movimento = reduzir ? "reduzido" : "normal";
  }

  function avisar() {
    document.dispatchEvent(new CustomEvent("preferencias", { detail: copiar(prefs) }));
  }

  function sincronizar() {
    document.querySelectorAll("[data-pref]").forEach(function (el) {
      var valor = prefs[el.dataset.pref];
      if (el.type === "radio") el.checked = el.value === valor;
      else if (el.type === "checkbox") el.checked = valor === (el.dataset.ligado || "sim");
      else el.value = valor;
    });
  }

  function definir(nome, valor) {
    if (!(nome in prefs)) return;
    prefs[nome] = valor;
    gravar(); aplicar(); sincronizar(); avisar();
  }

  function restaurar() {
    prefs = copiar(PADRAO);
    try { localStorage.removeItem(CHAVE); } catch (e) {}
    aplicar(); sincronizar(); avisar();
  }

  aplicar();
  midiaClara.addEventListener("change", aplicar);
  midiaMovimento.addEventListener("change", aplicar);

  /* API para o código do projeto */
  window.Brasa = {
    preferencias: function () { return copiar(prefs); },
    definir: definir,
    restaurar: restaurar,
    alternarTema: function () { definir("tema", raiz.dataset.tema === "claro" ? "escuro" : "claro"); }
  };

  /* ---------- Comportamentos que dependem da página ---------- */
  function iniciar() {
    sincronizar();

    document.addEventListener("change", function (ev) {
      var el = ev.target.closest && ev.target.closest("[data-pref]");
      if (!el) return;
      var valor = el.type === "checkbox"
        ? (el.checked ? (el.dataset.ligado || "sim") : (el.dataset.desligado || "nao"))
        : el.value;
      definir(el.dataset.pref, valor);
    });

    /* Menu lateral no celular */
    function menu(abrir) {
      if (abrir) document.body.dataset.menu = "aberto";
      else delete document.body.dataset.menu;
      document.querySelectorAll("[data-alternar-menu]").forEach(function (b) {
        b.setAttribute("aria-expanded", abrir ? "true" : "false");
      });
    }

    document.addEventListener("click", function (ev) {
      var alvo = ev.target.closest ? ev.target : ev.target.parentElement;
      if (alvo.closest("[data-alternar-menu]")) { menu(document.body.dataset.menu !== "aberto"); return; }
      if (alvo.closest(".veu")) { menu(false); return; }
      if (alvo.closest(".nav-lateral a")) menu(false);
      if (alvo.closest("[data-alternar-tema]")) window.Brasa.alternarTema();
      if (alvo.closest("[data-restaurar-preferencias]")) restaurar();
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && document.body.dataset.menu === "aberto") menu(false);
    });

    /* Sombra no cabeçalho quando a página rola */
    var cabecalho = document.querySelector(".cabecalho");
    function rolou() {
      if (cabecalho) cabecalho.toggleAttribute("data-rolado", window.scrollY > 4);
    }
    window.addEventListener("scroll", rolou, { passive: true });
    rolou();

    /* Bordas esmaecidas quando há mais conteúdo para os lados */
    function bordas(el) {
      el.toggleAttribute("data-mais-esq", el.scrollLeft > 2);
      el.toggleAttribute("data-mais-dir", el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    }
    document.querySelectorAll(".rolagem-x").forEach(function (el) {
      el.addEventListener("scroll", function () { bordas(el); }, { passive: true });
      if ("ResizeObserver" in window) new ResizeObserver(function () { bordas(el); }).observe(el);
      bordas(el);
    });

    /* Índice que acompanha a rolagem: <nav data-acompanhar-rolagem> com links #secao */
    document.querySelectorAll("[data-acompanhar-rolagem]").forEach(function (nav) {
      var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
      var secoes = links.map(function (a) {
        try { return document.querySelector(a.getAttribute("href")); } catch (e) { return null; }
      });
      function atualizar() {
        var limite = window.innerHeight * 0.3;
        var atual = 0;
        secoes.forEach(function (s, i) { if (s && s.getBoundingClientRect().top <= limite) atual = i; });
        if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) atual = secoes.length - 1;
        links.forEach(function (a, i) {
          if (i === atual) a.setAttribute("aria-current", "location");
          else a.removeAttribute("aria-current");
        });
      }
      window.addEventListener("scroll", atualizar, { passive: true });
      window.addEventListener("resize", atualizar);
      atualizar();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
