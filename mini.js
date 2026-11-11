// mini.js — mini painel flutuante em qualquer página (só consulta).
// Cápsula com linha verde na borda direita; clique abre uma
// barra vertical com as batidas de hoje e os totais. Arrastar reposiciona
// (posição salva em chrome.storage.local.miniHandleTop, em % da altura).
// Lê só o que o painel já guardou no storage — não faz nenhuma requisição.
(() => {
  if (window.__icarusMini) return;
  window.__icarusMini = true;

  const KEYS = ["miniPainelConfig", "miniHandleTop", "cachedRegistrosPorDia", "lastRegistros", "pendingAdjustments", "jornada848Config", "jornada6hConfig", "autoRegistroBatidas", "almocoMinConfig", "miniPainelAberto"];
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hhmm = (ms) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;
  const minToHHMM = (min) => { min = Math.max(0, Math.round(min)); return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; };
  const toMs = (h) => (typeof h === "number" ? h : new Date(h).getTime());

  let state = {};
  let host = null;
  let root = null;
  let aberto = false;
  let timer = null;

  const CSS = `
    :host { all: initial; --card: #ffffff; --bg: #f5f7f6; --border: #e3e7e5; --text: #1c2422; --muted: #6b7570; --progress-l: 80%; }
    @media (prefers-color-scheme: dark) {
      :host { --card: #1d2224; --bg: #14181a; --border: #2b3234; --text: #eef2f0; --muted: #9aa5a1; --progress-l: 30%; }
    }
    .wrap { height: 48px; display: flex; justify-content: flex-end; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    /* gaveta única: botão + painel deslizam juntos; fechado, o painel fica fora da tela à direita */
    .drawer {
      display: flex; align-items: flex-start; pointer-events: auto;
      transform: translateX(80px); transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .wrap.open .drawer { transform: translateX(0); }
    .handle {
      position: relative; z-index: 1; flex-shrink: 0; box-sizing: border-box; width: 17px; height: 48px;
      background: var(--card); border-radius: 12px 0 0 12px;
      box-shadow: -4px 4px 16px rgba(0,0,0,0.18); cursor: grab; user-select: none; touch-action: none;
      /* aberto, estica até a altura do painel no mesmo ritmo do deslize */
      transition: height 0.25s cubic-bezier(0.2, 0.8, 0.2, 1), transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    /* barra verde centralizada na cápsula */
    .handle::before {
      content: ""; position: absolute; left: 5px; top: 5px; bottom: 5px; width: 7px;
      background: #13a36a; border-radius: 4px; transition: background 0.15s ease;
    }
    .handle:hover::before { background: #0d7a50; }
    /* aberto: corta a sombra do botão na borda direita, senão ela escurece o painel e marca a emenda */
    .wrap.open .handle { clip-path: inset(-24px 0 -24px -24px); }
    /* arrastando: sem animação, o painel e a barra verde andam juntos com o mouse */
    .handle.dragging { cursor: grabbing; transition: none; }
    .panel {
      position: relative; top: 0; width: 80px; background: var(--card); color: var(--text); border: 1px solid var(--card);
      border-right: none; border-radius: 12px 0 0 12px; box-shadow: -4px 4px 16px rgba(0,0,0,0.18); padding: 8px 7px; box-sizing: border-box;
      visibility: hidden; transition: visibility 0s linear 0.25s;
    }
    .wrap.open .panel { visibility: visible; transition-delay: 0s; }
    .item { background: var(--bg); border: 1px solid transparent; border-radius: 8px; padding: 5px 4px; margin-bottom: 5px; text-align: center; }
    .item .l { display: block; font-size: 10px; color: var(--muted); }
    .item .v { display: block; font-size: 14px; font-weight: 700; margin-top: 1px; }
    /* mesmas cores dos cartões de batida do painel */
    .item.ok { background: color-mix(in srgb, #1fa35c 9%, var(--card)); border-color: color-mix(in srgb, #1fa35c 28%, var(--card)); }
    .item.auto { background: color-mix(in srgb, #ec4899 9%, var(--card)); border-color: color-mix(in srgb, #ec4899 28%, var(--card)); }
    .item.ajuste { border-color: #8b5cf6; }
    .item.ajuste .v::after { content: "*"; color: #8b5cf6; }
    .item.pend { border: 1px dashed #f97316; }
    .item.pend .v { color: #f97316; }
    .item.pred .v { color: var(--muted); font-weight: 600; }
    .sep { height: 1px; background: var(--border); margin: 7px 0; }
  `;

  function todayData() {
    const key = dateKey(new Date());
    const ponto =
      state.cachedRegistrosPorDia?.[key] ||
      (state.lastRegistros?.pontos || []).find((p) => dateKey(new Date(p.dataBatida)) === key);
    const pend = state.pendingAdjustments?.[key] || [];
    const deletes = pend.filter((p) => p.type === "delete").map((p) => p.horarioMs);
    const autos = state.autoRegistroBatidas?.[key] || [];
    const real = (ponto?.pontosHorariosBatidasOrdenados || [])
      .map((b) => ({ t: toMs(b.horario), tipo: b.tipoRegistro }))
      .filter((b) => !deletes.includes(b.t))
      .map((b) => ({
        t: b.t,
        pending: false,
        ajuste: !!b.tipo && b.tipo !== "O",
        auto: autos.some((a) => Math.abs(a - b.t) <= 3 * 60000),
      }));
    const d = new Date();
    const pendentes = pend
      .filter((p) => p.type !== "delete" && p.approxTime)
      .map((p) => {
        const [h, m] = p.approxTime.split(":").map(Number);
        return { t: new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime(), pending: true };
      });
    const merged = [...real, ...pendentes].sort((a, b) => a.t - b.t);
    const meta = state.jornada6hConfig ? 360 : state.jornada848Config ? 528 : 480;
    const times = merged.map((x) => x.t);
    let worked = 0;
    for (let i = 0; i + 1 < times.length; i += 2) worked += (times[i + 1] - times[i]) / 60000;
    if (times.length % 2 === 1) worked += (Date.now() - times[times.length - 1]) / 60000;
    let intervalo = 0;
    for (let i = 1; i + 1 < times.length; i += 2) intervalo += (times[i + 1] - times[i]) / 60000;
    // fora no almoço (2 batidas): o intervalo conta ao vivo desde a 2ª batida
    if (times.length === 2) intervalo += (Date.now() - times[1]) / 60000;

    // previsão das próximas batidas (mesma conta do painel: meta em duas metades com o almoço no meio)
    const almoco = state.almocoMinConfig || 30;
    const prev = {};
    if (times.length === 1) {
      prev[1] = times[0] + (meta / 2) * 60000;
      prev[2] = prev[1] + almoco * 60000;
      prev[3] = prev[2] + (meta / 2) * 60000;
    } else if (times.length === 2) {
      prev[2] = times[1] + almoco * 60000;
      prev[3] = prev[2] + Math.max(0, meta - (times[1] - times[0]) / 60000) * 60000;
    } else if (times.length === 3) {
      prev[3] = Date.now() + Math.max(0, meta - worked) * 60000;
    }

    const vazio = !times.length;
    return {
      slots: [0, 1, 2, 3].map((i) => merged[i] || (prev[i] ? { t: prev[i], predicted: true } : null)),
      worked: vazio ? "--:--" : minToHHMM(worked),
      intervalo: vazio ? "--:--" : minToHHMM(intervalo),
      falta: vazio ? "--:--" : minToHHMM(meta - worked),
      progresso: vazio ? null : Math.min(1, Math.max(0, worked / meta)),
    };
  }

  function renderPanel() {
    if (!root) return;
    const d = todayData();
    const item = (l, v, cls = "", bg = "") => `<div class="item ${cls}"${bg ? ` style="background:${bg}"` : ""}><span class="l">${l}</span><span class="v">${v}</span></div>`;
    const cor = (s) => (!s ? "" : s.predicted ? "pred" : s.pending ? "pend" : s.ajuste ? "ajuste" : s.auto ? "auto" : "ok");
    const slot = (s) => (s ? (s.pending || s.predicted ? `~${hhmm(s.t)}` : hhmm(s.t)) : "--:--");
    // fundo de progresso, igual ao painel
    const pct = d.progresso == null ? null : (d.progresso * 100).toFixed(1);
    const bgTrab = pct == null ? "" : `linear-gradient(to right, color-mix(in srgb, #1fa35c 45%, var(--card)) ${pct}%, var(--bg) ${pct}%) border-box`;
    const bgFalta = pct == null ? "" : `linear-gradient(to right, hsl(${Math.round(120 * d.progresso)} 75% var(--progress-l)) ${pct}%, var(--bg) ${pct}%) border-box`;
    root.querySelector(".body").innerHTML =
      d.slots.map((s, i) => item(`${i + 1}ª batida`, slot(s), cor(s))).join("") +
      '<div class="sep"></div>' +
      item("Trabalhado", d.worked, "", bgTrab) +
      item("Intervalo", d.intervalo) +
      item("Falta", d.falta, "", bgFalta);
  }

  // margem mínima do centro do botão até a borda da tela: sobra espaço pro
  // painel ter a quina arredondada acima/abaixo dele
  const MARGEM_PX = 52;
  const clampY = (y) => Math.min(window.innerHeight - MARGEM_PX, Math.max(MARGEM_PX, y));

  function applyTop() {
    const pct = typeof state.miniHandleTop === "number" ? state.miniHandleTop : 50;
    host.style.top = `${clampY((pct / 100) * window.innerHeight)}px`;
    fitInView();
  }

  // Fechado: botão de 48px no lugar salvo. Aberto: o painel se ajusta pra
  // caber na tela e o botão estica quase até a altura dele.
  function fitInView() {
    if (!root) return;
    const handle = root.querySelector(".handle");
    const panel = root.querySelector(".panel");
    if (!aberto) {
      handle.style.height = "";
      handle.style.transform = "";
      return;
    }
    const wr = root.querySelector(".wrap").getBoundingClientRect();
    const ph = panel.offsetHeight;
    let top = wr.top + wr.height / 2 - ph / 2;
    top = Math.max(8, Math.min(window.innerHeight - 8 - ph, top));
    const off = top - wr.top;
    panel.style.top = `${off}px`;
    // estica um pouco menos que o painel: deixa a quina arredondada dele
    // livre em cima e embaixo, senão as duas quinas formam um dente
    const folga = 14;
    handle.style.transform = `translateY(${off + folga}px)`;
    handle.style.height = `${ph - folga * 2}px`;
  }



  function setOpen(on) {
    aberto = on;
    root.querySelector(".wrap").classList.toggle("open", on);
    clearInterval(timer);
    if (on) {
      renderPanel();
      timer = setInterval(renderPanel, 30000);
    }
    fitInView();
  }

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483647;margin:0;padding:0;pointer-events:none;";
    root = host.attachShadow({ mode: "closed" });
    // folha construída (adoptedStyleSheets) em vez de <style>: não é barrada
    // pelo Content-Security-Policy de sites mais rígidos
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = `
      <div class="wrap"><div class="drawer">
        <div class="handle" title="Ponto de hoje"></div>
        <div class="panel"><div class="body"></div></div>
      </div></div>`;
    document.documentElement.appendChild(host);
    window.addEventListener("resize", () => host && applyTop());
    applyTop();

    const handle = root.querySelector(".handle");

    let startY = 0, startTop = 0, arrastando = false, apertado = false;
    handle.addEventListener("pointerdown", (ev) => {
      apertado = true;
      arrastando = false;
      startY = ev.clientY;
      startTop = host.getBoundingClientRect().top + host.offsetHeight / 2;
      handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!apertado) return;
      const dy = ev.clientY - startY;
      if (!arrastando && Math.abs(dy) > 4) { arrastando = true; handle.classList.add("dragging"); }
      if (!arrastando) return;
      host.style.top = `${clampY(startTop + dy)}px`;
      fitInView();
    });
    handle.addEventListener("pointerup", () => {
      if (!apertado) return;
      apertado = false;
      handle.classList.remove("dragging");
      if (arrastando) {
        chrome.storage.local.set({ miniHandleTop: (parseFloat(host.style.top) / window.innerHeight) * 100 });
      } else {
        // aberto/fechado é um só pra todas as abas: grava e as outras seguem (sync)
        const novo = !aberto;
        setOpen(novo);
        chrome.storage.local.set({ miniPainelAberto: novo });
      }
    });
    if (aberto) renderPanel();
  }

  function destroy() {
    clearInterval(timer);
    host?.remove();
    host = null;
    root = null;
    aberto = false;
  }

  function sync() {
    if (state.miniPainelConfig === false) return destroy();
    build();
    applyTop();
    if (!!state.miniPainelAberto !== aberto) setOpen(!!state.miniPainelAberto);
    else if (aberto) renderPanel();
  }

  chrome.storage.local.get(KEYS).then((s) => {
    state = s;
    sync();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let mexeu = false;
    for (const k of KEYS) if (changes[k]) { state[k] = changes[k].newValue; mexeu = true; }
    if (mexeu) sync();
  });
})();
