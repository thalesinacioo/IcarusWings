/**
 * sidepanel.js — orquestra a UI do painel lateral.
 *
 * Fluxo de leitura: pedimos pra página real fazer a pesquisa (preenche
 * período + clica "Pesquisar"), e ficamos ouvindo as respostas que ela
 * mesma recebe (evento "icarus:observed"). Nunca montamos uma requisição
 * autenticada nós mesmos.
 *
 * Campos do Icarus que importam aqui (confirmados inspecionando a API real):
 *  - ponto.temAbonoOuAjusteRegistrado  -> dia teve ajuste/abono (roxo)
 *  - ponto.falta / ponto.consistente   -> falta ou inconsistência (vermelho)
 *  - ponto.minutoFaltante              -> quanto falta trabalhar no dia
 *  - batida.tipoRegistro               -> "O" = original, "I" = incluída por digitação
 *  - batida.tipoRegistroFmt            -> rótulo pronto ("Incluido Por Digitação")
 *  - batida.marcacaoFmt                -> "1º Entrada", "1º Saída", ...
 *  - batida.motivo                     -> justificativa escrita no ajuste
 *
 * "Ajuste pendente" (cinza) é um estado só da extensão, não do Icarus: é
 * quando a pessoa clicou "Ajustar depois" num lembrete de bater ponto —
 * fica marcado até a batida real (ou um ajuste aprovado) aparecer nos
 * dados do Icarus pra aquele horário.
 *
 * O painel "Batidas de hoje" é, na verdade, um painel do "dia selecionado":
 * por padrão mostra hoje (com contadores ao vivo); clicar num dia do
 * calendário troca o conteúdo pra aquele dia (sem popup) e mostra um botão
 * pra voltar.
 */

// Mesmos horários de referência usados pelos lembretes em background.js —
// usados aqui só pra saber quando é razoável desconfiar que uma batida
// ficou faltando (ex: já passou muito da hora esperada da volta do almoço).
const PUNCH_SCHEDULE = [
  { seq: 1, hh: 8, mm: 0, label: "1ª entrada" },
  { seq: 2, hh: 12, mm: 0, label: "1ª saída" },
  { seq: 3, hh: 13, mm: 0, label: "2ª entrada" },
  { seq: 4, hh: 17, mm: 0, label: "2ª saída" },
];
const MISSING_PUNCH_GRACE_MIN = 60; // só avisa depois de 1h do horário esperado

// ---------- ciclo de vida do painel (fecha a aba do Icarus ao fechar) ----------
// Conecta uma porta nomeada assim que o painel abre; o background.js usa
// onDisconnect pra saber quando fechar a aba do Icarus (ver background.js).
// Reconecta sozinho se a porta cair: isso acontece tanto quando o painel
// fecha de verdade quanto quando o service worker é só suspenso/reiniciado
// (mesmo com o painel ainda aberto) — o id fixo por documento é o que deixa
// o background distinguir os dois casos.
const __PANEL_ID = crypto.randomUUID();
function __connectToBackground() {
  let port;
  try {
    port = chrome.runtime.connect({ name: `${MSG_NS}:sidepanel:${__PANEL_ID}` });
  } catch (_) {
    setTimeout(__connectToBackground, 250);
    return;
  }
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    setTimeout(__connectToBackground, 250);
  });
}
__connectToBackground();
const DEFAULT_JORNADA_MIN = 8 * 60; // meta do dia (08-12 + 13-17) quando o Icarus ainda não tem registro nenhum pro dia
const MINUTOS_ABONO_POR_DIA_UTIL = 48; // regra do RH: teto de flexibilização = dias úteis do período × 48min
const JORNADA_PADRAO_MIN = 8 * 60 + 48; // 8:48 — jornada padrão usada como base pra prever as batidas restantes do dia
const JORNADA_6H_MIN = 6 * 60; // 6:00 — jornada reduzida, sem abono/flexibilização
const GITHUB_REPO = "thalesinacioo/IcarusWings";

// Intervalo de almoço usado na previsão — configurável (checkbox), 30min por
// padrão. Carregado no boot via IcarusAPI.getAlmocoMinConfig().
let almocoMinAtual = 30;

// "8:48 hoje" — força a meta de hoje pra jornada padrão em vez do que o
// Icarus calculou (ou 8h de fallback). Carregado no boot.
let jornada848Ativo = false;

// "Eu trabalho 6:00h/dia" — jornada reduzida, sem abono/flexibilização.
// Mutuamente exclusivo com jornada848Ativo. Carregado no boot.
let jornada6hAtivo = false;

// Meta de minutos do dia usada nos cálculos "ao vivo" e na previsão das
// batidas restantes — 6h, 8h48 ou 8h (padrão), nessa ordem de prioridade.
function metaMinutosHoje() {
  return jornada6hAtivo ? JORNADA_6H_MIN : jornada848Ativo ? JORNADA_PADRAO_MIN : DEFAULT_JORNADA_MIN;
}

let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();
let registrosPorDia = {}; // "YYYY-MM-DD" -> ponto object
let pendingAdjustments = {}; // "YYYY-MM-DD" -> [{seq,label,clickedAt}]
let achievementsEarned = {}; // id -> "YYYY-MM-DD" em que foi conquistada
let secretKnock = false; // liberado por 5 cliques em "Falta trabalhar"
let autoMarcadas = {}; // "YYYY-MM-DD" -> [seq] marcadas com o ✔ pra bater sozinhas
let autoBatidas = {}; // "YYYY-MM-DD" -> [ms] das batidas feitas pelo auto registro
let feriasFolgasPeriods = []; // [{id, tipo, inicio, fim, nota}]
let selectedDayKey = null; // null = mostrando hoje
let liveTimer = null;

const $ = (sel) => document.querySelector(sel);
const pad2 = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const keyToDate = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };
const minutesToHHMM = (min) => {
  const sign = min < 0 ? "-" : "";
  min = Math.abs(Math.round(min));
  return `${sign}${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
};
const hhmm = (ts) => new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const capitalizeFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- conquistas ----------

// O nome aparece sempre; a descrição só depois que a conquista é ganha.
// As "especiais" ficam numa seção própria.
const SPECIAL_ACHIEVEMENTS = ["auto1", "slot", "easter", "ano1", "ferias"];
const ACHIEVEMENTS = [
  { id: "dias5", emoji: "🏅", name: "Sem choro", desc: "5 dias em sequência sem ajustes" },
  { id: "mes1", emoji: "🎖️", name: "Certinho", desc: "1 mês em sequência sem ajustes" },
  { id: "meses3", emoji: "🥉", name: "Relógio suíço", desc: "3 meses em sequência sem ajustes" },
  { id: "meses6", emoji: "🥈", name: "Lenda do ponto", desc: "6 meses em sequência sem ajustes" },
  { id: "ano1", emoji: "🥇", name: "Imortal", desc: "1 ano de trabalho em sequência sem ajustes" },
  { id: "easter", emoji: "🤖", name: "Hacker do ponto", desc: "Você descobriu o auto registro" },
  { id: "slot", emoji: "🔍", name: "Fuçador", desc: "Você descobriu como espiar uma conquista" },
  { id: "aj3", emoji: "✏️", name: "Rabisqueiro", desc: "Você tem 3 dias em sequência com ajustes" },
  { id: "aj6", emoji: "💀", name: "RIP ponto", desc: "Você tem mais de 5 dias em sequência com ajustes" },
  { id: "auto1", emoji: "🦾", name: "Biônico", desc: "Você fez seu primeiro auto registro" },
  { id: "auto3", emoji: "🚀", name: "Zero esforço", desc: "Você fez 3 auto registros em sequência" },
  { id: "abono", emoji: "🧾", name: "Abonado", desc: "Você já registrou abono" },
  { id: "ferias", emoji: "⛱️", name: "Rei da praia", desc: "Você já registrou férias" },
  { id: "folga", emoji: "⏰", name: "Soneca", desc: "Você já registrou folga" },
];
const ACHIEVEMENT_NAMES = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a.name]));
let achievementsReady = false;
let achievementsUnseen = []; // ganhas e ainda não vistas no modal: o troféu brilha

function updateTrophyGlow() {
  $("#achievementsBtn").classList.toggle("glow", achievementsUnseen.length > 0);
}

// Metas em dias úteis: 5 dias fixos; "N meses" = soma dos dias úteis dos N
// períodos de apuração mais recentes (26 a 25), os mesmos da flexibilização.
function achievementTargets() {
  const { start: curStart } = apuracaoPeriodFor(new Date());
  const somaPeriodos = (n) => {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const { start, end } = apuracaoPeriodFor(new Date(curStart.getFullYear(), curStart.getMonth() - i, 27));
      total += countBusinessDays(start, end);
    }
    return total;
  };
  return { dias5: 5, mes1: somaPeriodos(1), meses3: somaPeriodos(3), meses6: somaPeriodos(6), ano1: somaPeriodos(12) };
}

// Sequência de dias úteis "limpos" (verde: batidas, sem ajuste/abono, sem
// falta). Fim de semana, feriado e férias/folga/abono marcados pulam sem
// quebrar. Mês que ainda não foi buscado no Icarus conta como quebra.
function computeAchievements(mesesBuscados) {
  const earned = { ...achievementsEarned };
  const cobertos = new Set(mesesBuscados);
  const now = new Date();
  cobertos.add(`${now.getFullYear()}-${pad2(now.getMonth() + 1)}`);
  const ordenados = [...cobertos].sort();
  if (!ordenados.length) return earned;
  const [y, m] = ordenados[0].split("-").map(Number);
  const targets = achievementTargets();
  const ontem = new Date();
  ontem.setHours(0, 0, 0, 0);
  ontem.setDate(ontem.getDate() - 1);
  let run = 0;
  let runAj = 0;
  for (const d = new Date(y, m - 1, 1); d <= ontem; d.setDate(d.getDate() + 1)) {
    if (!isBusinessDay(d)) continue;
    const key = dateKey(d);
    if (feriasFolgaParaDia(key)) continue;
    const ponto = registrosPorDia[key];
    const limpo = cobertos.has(key.slice(0, 7)) && ponto && classifyDay(ponto, false) === "green";
    run = limpo ? run + 1 : 0;
    for (const id of Object.keys(targets)) if (!earned[id] && run >= targets[id]) earned[id] = key;
    // dias seguidos com ajuste/abono registrado no Icarus (roxo)
    const comAjuste = cobertos.has(key.slice(0, 7)) && ponto && classifyDay(ponto, false) === "purple";
    runAj = comAjuste ? runAj + 1 : 0;
    if (!earned.aj3 && runAj >= 3) earned.aj3 = key;
    if (!earned.aj6 && runAj >= 6) earned.aj6 = key;
  }

  // auto registro: 1ª batida automática e 3 automáticas seguidas (sem batida manual no meio)
  const diasAuto = Object.keys(autoBatidas).filter((k) => (autoBatidas[k] || []).length).sort();
  if (diasAuto.length && !earned.auto1) earned.auto1 = diasAuto[0];
  if (!earned.auto3) {
    let seguidas = 0;
    for (const key of Object.keys(registrosPorDia).sort()) {
      for (const b of batidasOrdenadas(registrosPorDia[key])) {
        const auto = (autoBatidas[key] || []).some((t) => Math.abs(t - b.horario) <= 3 * 60000);
        seguidas = auto ? seguidas + 1 : 0;
        if (seguidas >= 3 && !earned.auto3) earned.auto3 = key;
      }
    }
  }

  // abono/férias/folga já registrados (data = quando foi cadastrado)
  for (const p of feriasFolgasPeriods) {
    if (earned[p.tipo]) continue;
    const criado = Number(String(p.id).replace("ff_", ""));
    earned[p.tipo] = Number.isFinite(criado) && criado > 0 ? dateKey(new Date(criado)) : dateKey(new Date());
  }
  return earned;
}

// Easter egg: 5 cliques seguidos numa conquista ainda bloqueada mostram
// nome, descrição e emoji (em cinza claro) por 7s.
let badgePeekId = null;
let badgePeekTimer = null;
let badgeClicks = 0;
let badgeClickTimer = null;
function setupBadgePeek() {
  $("#badgeGrid").addEventListener("click", (ev) => {
    const item = ev.target.closest(".badge-item");
    if (!item || item.classList.contains("earned")) return;
    badgeClicks++;
    clearTimeout(badgeClickTimer);
    badgeClickTimer = setTimeout(() => { badgeClicks = 0; }, 1500);
    if (badgeClicks < 5) return;
    badgeClicks = 0;
    badgePeekId = item.dataset.id;
    renderAchievements();
    clearTimeout(badgePeekTimer);
    badgePeekTimer = setTimeout(() => { badgePeekId = null; renderAchievements(); }, 7000);
    grantAchievement("slot");
  });
}

function renderAchievements() {
  const grid = $("#badgeGrid");
  const card = (a) => {
    const dia = achievementsEarned[a.id];
    const espiando = !dia && a.id === badgePeekId;
    return `<div class="badge-item${dia ? " earned" : ""}${espiando ? " peek" : ""}" data-id="${a.id}">
      <span class="badge-emoji">${a.emoji}</span>
      <span class="badge-name">${a.name}</span>
      <span class="badge-desc">${dia || espiando ? a.desc : ""}</span>
      <span class="badge-date">${dia ? fmtDDMMYYYY(dia) : ""}</span>
    </div>`;
  };
  // conquistadas primeiro (a ordem da lista se mantém dentro de cada grupo)
  const porGanhas = (a, b) => !!achievementsEarned[b.id] - !!achievementsEarned[a.id];
  const comuns = ACHIEVEMENTS.filter((a) => !SPECIAL_ACHIEVEMENTS.includes(a.id)).sort(porGanhas);
  const especiais = ACHIEVEMENTS.filter((a) => SPECIAL_ACHIEVEMENTS.includes(a.id)).sort(porGanhas);
  grid.innerHTML =
    comuns.map(card).join("") + '<div class="badge-section">Especiais</div>' + especiais.map(card).join("");
}

async function saveAchievements(novas) {
  const conquistadas = Object.keys(novas).filter((id) => !achievementsEarned[id]);
  achievementsEarned = novas;
  if (conquistadas.length) achievementsUnseen = [...new Set([...achievementsUnseen, ...conquistadas])];
  await chrome.storage.local.set({ achievementsEarned, achievementsUnseen });
  updateTrophyGlow();
  renderAchievements();
  conquistadas.forEach((id) => showStatus(`Conquista desbloqueada: ${ACHIEVEMENT_NAMES[id]}`, "info", 5000));
}

async function refreshAchievements() {
  if (!achievementsReady) return;
  const { achievementMonthsDone = [] } = await chrome.storage.local.get("achievementMonthsDone");
  await saveAchievements(computeAchievements(achievementMonthsDone));
}

async function grantAchievement(id) {
  if (!achievementsReady || achievementsEarned[id]) return;
  await saveAchievements({ ...achievementsEarned, [id]: dateKey(new Date()) });
}

// Busca os últimos 13 meses no Icarus (mês a mês, o mesmo método da busca
// normal) pra poder calcular sequências longas. Meses já buscados e fechados
// não são buscados de novo; só o mês passado (que ainda pode receber ajustes).
let achievementsSyncing = false;
let achievementsSyncedAt = 0;
async function syncAchievementHistory() {
  if (achievementsSyncing || Date.now() - achievementsSyncedAt < 30 * 60000) return;
  achievementsSyncing = true;
  const statusEl = $("#achievementsStatus");
  setSyncing(true);
  let buscou = false;
  try {
    const { achievementMonthsDone = [] } = await chrome.storage.local.get("achievementMonthsDone");
    const done = new Set(achievementMonthsDone);
    const now = new Date();
    const alvo = [];
    for (let i = 1; i <= 13; i++) {
      const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mk = `${m.getFullYear()}-${pad2(m.getMonth() + 1)}`;
      if (i === 1 || !done.has(mk)) alvo.push({ m, mk });
    }
    let n = 0;
    for (const { m, mk } of alvo) {
      statusEl.textContent = `Buscando histórico… ${++n}/${alvo.length}`;
      await IcarusAPI.searchPeriod(m, new Date(m.getFullYear(), m.getMonth() + 1, 0));
      await new Promise((r) => setTimeout(r, 1300));
      const { data } = await IcarusAPI.getLastRegistros();
      if (data) ingestRegistros(data);
      buscou = true;
      done.add(mk);
      await chrome.storage.local.set({ achievementMonthsDone: [...done] });
      await saveAchievements(computeAchievements([...done]));
    }
    achievementsSyncedAt = Date.now();
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = "Não consegui buscar o histórico agora. Confira se o Icarus está logado.";
  } finally {
    achievementsSyncing = false;
    setSyncing(false);
    if (buscou) fetchMonth(); // devolve os dados do mês em exibição
  }
}

function openAchievementsModal() {
  $("#achievementsModal").classList.remove("hidden");
  achievementsUnseen = [];
  chrome.storage.local.set({ achievementsUnseen });
  updateTrophyGlow();
  renderAchievements();
  syncAchievementHistory();
}

// ---------- tooltip genérico (substitui o `title` nativo em todo lugar:
// aparece instantâneo, nunca corta na borda do painel, não muda o cursor).
// Marcar um elemento com `data-tooltip="texto"` (estático no HTML) ou
// `el.dataset.tooltip = "texto"` (dinâmico) é o suficiente pra ativá-lo —
// initTooltips() usa um listener delegado, então funciona mesmo em
// elementos recriados depois (calendário, batidas).
let tooltipEl = null;
function ensureTooltipEl() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "tooltip-bubble";
  tooltipEl.innerHTML = '<div class="tooltip-bubble-text"></div><div class="tooltip-bubble-arrow"></div>';
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}
function positionTooltip(target, el) {
  const margin = 6;
  const targetRect = target.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  let left = Math.round(targetRect.left + targetRect.width / 2 - elRect.width / 2);
  left = Math.max(margin, Math.min(left, window.innerWidth - elRect.width - margin));
  let below = false;
  let top = Math.round(targetRect.top - elRect.height - 8);
  if (top < margin) {
    top = Math.round(targetRect.bottom + 8);
    below = true;
  }
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.classList.toggle("below", below);
  const arrowX = Math.max(10, Math.min(targetRect.left + targetRect.width / 2 - left, elRect.width - 10));
  el.querySelector(".tooltip-bubble-arrow").style.left = `${arrowX}px`;
}
function showTooltip(target) {
  const text = target.dataset.tooltip;
  if (!text) return;
  const el = ensureTooltipEl();
  el.querySelector(".tooltip-bubble-text").textContent = text;
  el.classList.add("visible");
  positionTooltip(target, el);
}
function hideTooltip() {
  tooltipEl?.classList.remove("visible");
}
function initTooltips() {
  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target) showTooltip(target);
  });
  document.addEventListener("mouseout", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target && !target.contains(e.relatedTarget)) hideTooltip();
  });
  document.addEventListener("focusin", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target) showTooltip(target);
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.closest("[data-tooltip]")) hideTooltip();
  });
}

// Soma dos intervalos ENTRE pares (saída -> próxima entrada), numa lista
// ordenada de horários (ms) já mesclados (reais visíveis + pendentes com
// horário). Nunca inclui o trecho em aberto no fim (isso é "trabalhado",
// não intervalo) — só o que fica ENTRE dois pares completos.
function intervalMinutesFromTimes(times) {
  let min = 0;
  for (let i = 1; i + 1 < times.length; i += 2) min += (times[i + 1] - times[i]) / 60000;
  return min;
}

// Pilha única de avisos flutuantes, ancorada embaixo do botão Atualizar —
// uma flechinha só, no topo do contêiner, sempre apontando pra ele. Cada
// aviso (status, nova versão, ...) é uma "linha" independente identificada
// por chave — chamar de novo com a mesma chave atualiza a mesma linha em
// vez de criar outra; linhas diferentes se empilham uma abaixo da outra,
// todas alinhadas pela borda direita (`align-items: flex-end`).
const STATUS_COLORS = { info: ["#e5f4ee", "#0d5a3a"], error: ["#fde2e2", "#8a1f1f"], update: ["#f97316", "#ffffff"] };
let notificationStackEl = null;
const notificationRows = new Map(); // id -> { el, hideTimer }

function ensureNotificationStack() {
  if (notificationStackEl) return notificationStackEl;
  notificationStackEl = document.createElement("div");
  notificationStackEl.className = "notification-stack";
  notificationStackEl.innerHTML = '<div class="notification-stack-rows"></div>';
  document.body.appendChild(notificationStackEl);
  return notificationStackEl;
}

function positionNotificationStack() {
  const el = ensureNotificationStack();
  const firstRow = el.querySelector(".notification-stack-rows").firstElementChild;
  if (!firstRow) return;
  const margin = 6;
  const targetRect = $(firstRow.dataset.anchor || "#refreshBtn").getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  let left = Math.round(targetRect.right - rect.width);
  left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
  el.style.left = `${left}px`;
  el.style.top = `${Math.round(targetRect.bottom + 8)}px`;

  // A flechinha é uma só pra pilha inteira e sempre sai da linha do topo —
  // filha DELA (não da pilha), pra não sobrar fresta entre a ponta e a
  // borda arredondada do balão (mesmo truque do tooltip genérico).
  let arrow = firstRow.querySelector(".tooltip-bubble-arrow");
  if (!arrow) {
    arrow = document.createElement("span");
    arrow.className = "tooltip-bubble-arrow";
    firstRow.appendChild(arrow);
  } else {
    firstRow.appendChild(arrow); // reparenta se estava numa linha anterior
  }
  const rowRect = firstRow.getBoundingClientRect();
  // Clampar pelo CENTRO da seta (não pela borda esquerda dela) — a seta tem
  // 10px de largura, então só limitar a borda esquerda deixava a borda
  // direita invadir a curva do border-radius do balão (10px) do outro lado.
  const arrowHalf = 5;
  const cornerSafe = 10; // border-radius de .notification-row
  const minCenter = cornerSafe + arrowHalf;
  const maxCenter = rowRect.width - cornerSafe - arrowHalf;
  const rawCenter = targetRect.left + targetRect.width / 2 - rowRect.left;
  const arrowCenter = Math.max(minCenter, Math.min(rawCenter, maxCenter));
  arrow.style.left = `${arrowCenter - arrowHalf}px`;
}

function showNotificationRow(id, { text, href, onClick, type = "info", closable = false, autoHideMs = null, anchor = "#refreshBtn" }) {
  const stack = ensureNotificationStack();
  const rowsBox = stack.querySelector(".notification-stack-rows");
  let entry = notificationRows.get(id);
  if (!entry) {
    const el = document.createElement("div");
    el.className = "notification-row";
    el.innerHTML =
      `<${href ? "a" : "span"} class="notification-row-text"></${href ? "a" : "span"}>` +
      '<span class="notification-row-divider"></span>' +
      '<button type="button" class="notification-row-close" aria-label="Fechar">✕</button>';
    el.querySelector(".notification-row-close").addEventListener("click", () => hideNotificationRow(id));
    entry = { el };
    notificationRows.set(id, entry);
    rowsBox.appendChild(el);
  }
  clearTimeout(entry.hideTimer);
  const [bg, fg] = STATUS_COLORS[type] || STATUS_COLORS.info;
  entry.el.style.setProperty("--status-bg", bg);
  entry.el.style.setProperty("--status-text", fg);
  entry.el.classList.toggle("closable", closable);
  entry.el.dataset.anchor = anchor;
  const textEl = entry.el.querySelector(".notification-row-text");
  textEl.textContent = text;
  if (href) {
    textEl.href = href;
    textEl.target = "_blank";
    textEl.rel = "noopener";
  }
  // onclick (não addEventListener) pra não empilhar handler quando a linha
  // é reaproveitada (mesmo id chamado de novo com outro onClick).
  textEl.onclick = onClick || null;
  textEl.style.cursor = onClick ? "pointer" : "";
  stack.classList.add("visible");
  positionNotificationStack();
  if (autoHideMs) entry.hideTimer = setTimeout(() => hideNotificationRow(id), autoHideMs);
}
function hideNotificationRow(id) {
  const entry = notificationRows.get(id);
  if (!entry) return;
  clearTimeout(entry.hideTimer);
  entry.el.remove();
  notificationRows.delete(id);
  const stack = ensureNotificationStack();
  if (notificationRows.size === 0) stack.classList.remove("visible");
  else positionNotificationStack();
}

// autoHideMs: quando passado, some sozinho depois desse tempo (hoje só
// "Buscando na aba do Icarus…" usa isso); sem isso, o aviso fica flutuando
// até o usuário clicar no "✕".
function showStatus(text, type = "info", autoHideMs = null) {
  showNotificationRow("status", { text, type, closable: !autoHideMs, autoHideMs, anchor: "#refreshBtn" });
}
function hideStatus() {
  hideNotificationRow("status");
}

// Traz a aba do Icarus pra frente (ou abre uma nova) na janela atual — pedido
// pelo balão de "não logado"/"tela errada". Nunca loga sozinho.
function focusIcarusTab() {
  chrome.runtime.sendMessage({ source: MSG_NS, type: "FOCUS_ICARUS_TAB" }).catch(() => {});
  showStatus("Depois de logar, clique em Atualizar aqui no painel.", "info", 8000);
}

// Mensagens específicas por causa (ver inject.js requirePontoPage/uiSearch e
// background.js sendToTab) — substitui o antigo "Erro ao buscar: <mensagem
// crua do DOM>", que era genérico demais pra dizer se o problema era não
// estar logado, estar na tela errada, ou o Icarus ter mudado o layout.
const SEARCH_ERROR_MESSAGES = {
  NOT_LOGGED_IN: "Você não está logado no Icarus. Clique aqui pra fazer login.",
  WRONG_ROUTE: "A aba do Icarus não está na tela de Registro de Ponto. Clique aqui pra abri-la.",
  PAGE_NOT_READY: "A página do Icarus ainda está carregando. Tente Atualizar em alguns segundos.",
  SEARCH_FIELDS_MISSING: "Não achei os campos de período na tela de ponto — o Icarus pode ter mudado. Recarregue a aba (F5).",
  SEARCH_BUTTON_MISSING: 'Não achei o botão "Pesquisar" na tela de ponto. Recarregue a aba (F5).',
  TAB_LOAD_TIMEOUT: "A aba do Icarus demorou demais pra carregar. Tente de novo.",
  TAB_UNREACHABLE: "Não consegui falar com a aba do Icarus. Recarregue a aba (F5).",
  TIMEOUT: "A busca demorou demais. Confira a aba do Icarus e tente de novo.",
};

function showSearchError(err, fallbackPrefix = "Erro ao buscar") {
  const code = err?.code || "UNKNOWN";
  const clicavel = code === "NOT_LOGGED_IN" || code === "WRONG_ROUTE";
  hideStatus();
  showNotificationRow(clicavel ? "login" : "status", {
    text: SEARCH_ERROR_MESSAGES[code] || `${fallbackPrefix}: ${err.message}`,
    type: "error",
    closable: true,
    anchor: "#refreshBtn",
    onClick: clicavel ? focusIcarusTab : null,
  });
}

// Popup de configurações (era o accordion "Funções extras", agora abre a
// partir da engrenagem no topbar). Largura/posição horizontal seguem o
// cartão do calendário (mesma largura de conteúdo do painel), recalculadas
// toda vez que abre e também num resize da janela — assim acompanha o
// usuário redimensionando o side panel enquanto o popup está aberto.
function positionSettingsPopup() {
  const popup = $("#settingsPopup");
  const cardRect = $("#calendarCard").getBoundingClientRect();
  const btnRect = $("#settingsBtn").getBoundingClientRect();
  popup.style.left = `${Math.round(cardRect.left)}px`;
  popup.style.width = `${Math.round(cardRect.width)}px`;
  popup.style.top = `${Math.round(btnRect.bottom + 8)}px`;
}
function openSettingsPopup() {
  $("#settingsPopup").classList.remove("hidden");
  positionSettingsPopup();
}
function closeSettingsPopup() {
  $("#settingsPopup").classList.add("hidden");
}
function toggleSettingsPopup() {
  if ($("#settingsPopup").classList.contains("hidden")) openSettingsPopup();
  else closeSettingsPopup();
}

// Confirmação dentro do próprio painel — window.confirm() nativo aparece
// como caixa de diálogo do navegador, cobrindo a janela inteira em vez de
// ficar restrito à área do painel.
let confirmResolve = null;
function showConfirm(message, { title = "Confirmar", okLabel = "OK", cancelLabel = "Cancelar" } = {}) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $("#confirmModalTitle").textContent = title;
    $("#confirmModalText").textContent = message;
    $("#confirmModalOk").textContent = okLabel;
    $("#confirmModalCancel").textContent = cancelLabel;
    $("#confirmModal").classList.remove("hidden");
  });
}
function closeConfirm(result) {
  $("#confirmModal").classList.add("hidden");
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(result);
}

function ingestRegistros(data) {
  // Funde por cima do que já tinha (não zera o cache inteiro): assim um mês
  // já visto antes continua colorido na hora, mesmo navegando pra longe e
  // voltando, ou reabrindo o painel — só o dia que veio na resposta atual
  // é substituído.
  (data?.pontos || []).forEach((p) => {
    const d = new Date(p.dataBatida);
    registrosPorDia[dateKey(d)] = p;
  });
  chrome.storage.local.set({ cachedRegistrosPorDia: registrosPorDia });
  renderCalendar();
  renderDayPanel();
  hideStatus();
  hideNotificationRow("login");
}

async function loadPendingAdjustments() {
  pendingAdjustments = await IcarusAPI.getPendingAdjustments();
  renderCalendar();
  renderDayPanel();
}

function applySecretKnock(on) {
  secretKnock = on;
  $("#legendPink").classList.toggle("hidden", !on);
  renderDayPanel();
}

// 5 cliques seguidos (no máximo 1,5s entre um e outro) em "Falta trabalhar".
function setupSecretKnock() {
  let cliques = 0;
  let timer = null;
  $("#remainingToday").parentElement.addEventListener("click", async () => {
    cliques++;
    clearTimeout(timer);
    timer = setTimeout(() => { cliques = 0; }, 1500);
    if (cliques < 5) return;
    cliques = 0;
    const ativo = !secretKnock;
    const patch = { secretKnockAtivo: ativo };
    if (!ativo) patch.autoRegistroMarcadas = {};
    await chrome.storage.local.set(patch);
    applySecretKnock(ativo);
    if (ativo) grantAchievement("easter");
    showStatus(ativo ? "Modo extra ativado" : "Modo extra desativado", "info", 2500);
    if (ativo) setTimeout(() => window.IcarusTour?.startSecretTour(), 300);
  });
}

async function loadAutoMarcadas() {
  autoMarcadas = await IcarusAPI.getAutoRegistroMarcadas();
  renderDayPanel();
}

function updateAutoCheckTooltip(chk) {
  const card = chk.closest(".punch");
  const marcada = chk.classList.contains("armed");
  const valor = card.querySelector(".value").textContent.replace("~", "");
  const aprox = /\d/.test(valor) ? `por volta de ${valor}` : "no horário previsto, depois da 1ª batida";
  chk.dataset.tooltip = marcada
    ? `Auto registro marcado: o ponto será batido sozinho ${aprox}. Clique pra desmarcar.`
    : `Clique pra bater esta batida automaticamente ${aprox}.`;
}

async function loadAutoBatidas() {
  autoBatidas = await IcarusAPI.getAutoRegistroBatidas();
  renderCalendar();
  renderDayPanel();
  refreshAchievements();
}

async function loadFeriasFolgasPeriods() {
  feriasFolgasPeriods = await IcarusAPI.getFeriasFolgasPeriods();
  renderFeriasFolgasList();
  renderCalendar();
  refreshAchievements();
}

function fmtDDMMYYYY(key) {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

function renderFeriasFolgasList() {
  const box = $("#feriasFolgasList");
  const diaKey = selectedDayKey || dateKey(new Date());
  const doDia = feriasFolgasPeriods.filter((p) => diaKey >= p.inicio && diaKey <= p.fim);
  if (!doDia.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = doDia
    .slice()
    .sort((a, b) => a.inicio.localeCompare(b.inicio))
    .map((p) => {
      const periodo = p.inicio === p.fim ? fmtDDMMYYYY(p.inicio) : `${fmtDDMMYYYY(p.inicio)} – ${fmtDDMMYYYY(p.fim)}`;
      return `<div class="ferias-item ferias-item-${p.tipo}">
        <span class="ferias-item-text">${FERIAS_FOLGAS_LABEL[p.tipo]}, ${periodo}${p.nota ? ", " + p.nota : ""}</span>
        <button type="button" class="ferias-item-remove" data-id="${p.id}" title="Remover">✕</button>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".ferias-item-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await showConfirm("Remove essa marcação do calendário (não afeta o Icarus).", {
        title: "Remover período",
        okLabel: "Remover",
      });
      if (ok) {
        await IcarusAPI.removeFeriasFolgasPeriod(btn.dataset.id);
        loadFeriasFolgasPeriods();
      }
    });
  });
}

function openFeriasFolgasModal() {
  $("#feriasFolgasTipo").value = "abono";
  const dia = selectedDayKey || dateKey(new Date());
  $("#feriasFolgasInicio").value = dia;
  $("#feriasFolgasFim").value = dia;
  $("#feriasFolgasNota").value = "";
  $("#feriasFolgasModal").classList.remove("hidden");
}

function closeFeriasFolgasModal() {
  $("#feriasFolgasModal").classList.add("hidden");
}

async function saveFeriasFolgasModal() {
  const tipo = $("#feriasFolgasTipo").value;
  const inicio = $("#feriasFolgasInicio").value;
  const fim = $("#feriasFolgasFim").value || inicio;
  const nota = $("#feriasFolgasNota").value.trim();
  if (!inicio) return;
  await IcarusAPI.addFeriasFolgasPeriod(tipo, inicio, fim < inicio ? inicio : fim, nota);
  closeFeriasFolgasModal();
  loadFeriasFolgasPeriods();
}

// ---------- carregar mês ----------
// O calendário (grade de dias) é desenhado na hora, sem depender de dado
// nenhum — só a cor/estado de cada dia é que chega depois, quando a busca
// real na aba do Icarus responde.

function loadMonth() {
  renderCalendar(); // desenha a grade imediatamente com o que já houver em cache
  fetchMonth();
  showFlexibilizacaoInstant(); // Flexibilização acompanha o mês em exibição, não só "hoje"
  fetchFlexibilizacao();
}

// Gira o ícone de atualizar enquanto alguma busca no Icarus está em andamento
// (contador: fetchMonth e fetchFlexibilizacao podem se sobrepor).
let syncCount = 0;
function setSyncing(on) {
  syncCount = Math.max(0, syncCount + (on ? 1 : -1));
  $("#refreshBtn").classList.toggle("syncing", syncCount > 0);
}

async function fetchMonth() {
  const first = new Date(currentYear, currentMonth, 1);
  const last = new Date(currentYear, currentMonth + 1, 0);
  $("#monthLabel").textContent = capitalizeFirst(first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }));

  setSyncing(true);
  try {
    await IcarusAPI.searchPeriod(first, last);
    await new Promise((r) => setTimeout(r, 1200));
    const { data } = await IcarusAPI.getLastRegistros();
    if (data) ingestRegistros(data);
    setSyncing(false);
    refreshAchievements();
    playRefreshSuccessAnimation();
  } catch (err) {
    setSyncing(false);
    showSearchError(err);
  }
}

// Pisca verde suavemente + mostra ✓ por 3s no botão Atualizar, no lugar do
// balão "Buscando na aba do Icarus…" — mesmo padrão do botão de bater ponto
// (playBaterPontoSuccessAnimation). Separada de propósito: dá pra testar
// sozinha no console (`playRefreshSuccessAnimation()`) sem buscar de verdade.
let refreshSuccessTimer = null;
let refreshExitTimer = null;
function playRefreshSuccessAnimation() {
  const btn = $("#refreshBtn");
  clearTimeout(refreshSuccessTimer);
  clearTimeout(refreshExitTimer);
  btn.classList.remove("success", "success-exit");
  void btn.offsetWidth; // força reflow pra reiniciar a animação do zero
  btn.classList.add("success");
  refreshSuccessTimer = setTimeout(() => {
    btn.classList.remove("success");
    void btn.offsetWidth; // força reflow pra reiniciar a animação de saída
    btn.classList.add("success-exit");
    refreshExitTimer = setTimeout(() => btn.classList.remove("success-exit"), 300);
  }, 3000);
}

// ---------- flexibilização / abono (regra do RH) ----------
//
// Regra (e-mail do RH, jun/23):
//  - período de apuração: do dia 26 de um mês ao dia 25 do próximo
//  - teto do mês = dias úteis do período × 48min
//  - abono = saldo negativo do período (créditos - débitos), limitado ao
//    teto; se o saldo fechar positivo ou zero, não tem abono
//
// "dias úteis" aqui considera só feriados NACIONAIS (fixos + móveis via
// Páscoa) — feriados estaduais/municipais da sua cidade não entram nessa
// conta, então o número pode variar 1 dia (±48min no teto) em relação ao
// e-mail oficial do RH em meses com feriado local.

function easterDate(year) {
  // algoritmo de Meeus/Jones/Butcher
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function nationalHolidaySet(year) {
  const easter = easterDate(year);
  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  return [
    new Date(year, 0, 1), // Confraternização Universal
    addDays(easter, -48), // Carnaval (segunda)
    addDays(easter, -47), // Carnaval (terça)
    addDays(easter, -2), // Sexta-feira Santa
    addDays(easter, 60), // Corpus Christi
    new Date(year, 3, 21), // Tiradentes
    new Date(year, 4, 1), // Dia do Trabalho
    new Date(year, 8, 7), // Independência
    new Date(year, 9, 12), // N. Sra. Aparecida
    new Date(year, 10, 2), // Finados
    new Date(year, 10, 15), // Proclamação da República
    new Date(year, 10, 20), // Consciência Negra
    new Date(year, 11, 25), // Natal
  ].map(dateKey);
}

// Conta dias úteis (seg-sex, sem feriado nacional) entre start e end, ambos inclusive.
function countBusinessDays(start, end) {
  const holidays = new Set();
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    nationalHolidaySet(y).forEach((k) => holidays.add(k));
  }
  let count = 0;
  const d = new Date(start);
  while (d <= end) {
    if (isBusinessDay(d, holidays)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function isBusinessDay(date, holidaysOfYear) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  const holidays = holidaysOfYear || new Set(nationalHolidaySet(date.getFullYear()));
  return !holidays.has(dateKey(date));
}

// Período de apuração corrente (contém a data passada): dia 26 de um mês
// ao dia 25 do próximo.
function apuracaoPeriodFor(date) {
  const inicioNoMesAtual = date.getDate() >= 26;
  const start = inicioNoMesAtual
    ? new Date(date.getFullYear(), date.getMonth(), 26)
    : new Date(date.getFullYear(), date.getMonth() - 1, 26);
  const end = inicioNoMesAtual
    ? new Date(date.getFullYear(), date.getMonth() + 1, 25)
    : new Date(date.getFullYear(), date.getMonth(), 25);
  return { start, end };
}

// Saldo acumulado direto do Icarus (ponto.tempoSaldo é o saldo corrido, não
// o do dia) no último dia fechado do período: até ontem, ou até o fim se o
// período já fechou. Hoje fica de fora porque ainda está em andamento.
// Sem transformação nenhuma: o Icarus já leva em conta a flexibilidade de
// 10min de entrada/saída, que a extensão não tem como reproduzir sozinha.
function saldoHorasAteOntem(start, fimDecorrido) {
  if (fimDecorrido < start) return "00:00";
  const inicioKey = dateKey(start);
  const fimKey = dateKey(fimDecorrido);
  const keysComSaldo = Object.keys(registrosPorDia)
    .filter((k) => k >= inicioKey && k <= fimKey && registrosPorDia[k]?.tempoSaldo)
    .sort();
  return keysComSaldo.length ? registrosPorDia[keysComSaldo[keysComSaldo.length - 1]].tempoSaldo : null;
}

function renderFlexibilizacaoFromCache(start, end, tetoMin) {
  $("#tetoAbonoMes").textContent = minutesToHHMM(tetoMin);

  // Último dia fechado do período: ontem, ou o fim se o período já fechou.
  const ontem = new Date();
  ontem.setHours(0, 0, 0, 0);
  ontem.setDate(ontem.getDate() - 1);
  const fimDecorrido = ontem < end ? ontem : end;

  $("#saldoHoras").textContent = saldoHorasAteOntem(start, fimDecorrido) || "--:--";

  // Abono estimado = soma de 48min por dia útil já fechado no período,
  // limitado ao teto do período inteiro.
  const diasUteisDecorridos = fimDecorrido < start ? 0 : countBusinessDays(start, fimDecorrido);
  const abonoMin = Math.min(diasUteisDecorridos * MINUTOS_ABONO_POR_DIA_UTIL, tetoMin);
  $("#abonoEstimado").textContent = minutesToHHMM(abonoMin);

  $("#saldoHorasBox").dataset.tooltip =
    "Saldo acumulado até ontem, direto do Icarus (já considera a flexibilidade de 10min de entrada/saída, que a extensão não calcula sozinha).";
}

// Mostra período/teto/valores na hora com o que já tiver em cache — sem
// esperar rede, mesmo padrão do resto do painel (nunca abre vazio).
// Acompanha o mês em exibição no calendário (currentMonth/currentYear). Ao
// navegar pra outro mês, usa o dia 1 dele — dia 1 é sempre < 26, então o
// período vira "dia 26 do mês anterior ao dia 25 do mês em exibição"
// (convenção de rotular o período pelo mês em que ele fecha). Mas enquanto
// o mês em exibição É o mês real de hoje, usa a data de hoje de verdade —
// senão, depois do dia 25, o card ficava preso no período que já fechou em
// vez de virar pro novo período (que só fecha no mês seguinte).
function showFlexibilizacaoInstant() {
  const now = new Date();
  const isMesAtual = currentYear === now.getFullYear() && currentMonth === now.getMonth();
  const { start, end } = apuracaoPeriodFor(isMesAtual ? now : new Date(currentYear, currentMonth, 1));
  const diasUteis = countBusinessDays(start, end);
  const tetoMin = jornada6hAtivo ? 0 : diasUteis * MINUTOS_ABONO_POR_DIA_UTIL;
  const fmtDDMM = (d) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  $("#periodoRange").textContent = `${fmtDDMM(start)} – ${fmtDDMM(end)} · ${diasUteis} dias úteis`;
  renderFlexibilizacaoFromCache(start, end, tetoMin);
  return { start, end, tetoMin };
}

async function fetchFlexibilizacao() {
  const { start, end, tetoMin } = showFlexibilizacaoInstant();
  setSyncing(true);
  try {
    await IcarusAPI.searchPeriod(start, end);
    await new Promise((r) => setTimeout(r, 1200));
    const { data } = await IcarusAPI.getLastRegistros();
    if (data) ingestRegistros(data);
  } catch (err) {
    return; // já mostrou o que tinha em cache, não tem mais nada a fazer
  } finally {
    setSyncing(false);
  }
  renderFlexibilizacaoFromCache(start, end, tetoMin);
}

// ---------- versão / checagem de atualização ----------

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Aviso de "nova versão disponível" — vira mais uma linha na mesma pilha
// do status, mas ancorada na engrenagem (é lá que fica a versão), não no
// Atualizar — assim a flechinha indica o botão certo pra clicar.
function showUpdateNotice(latest, url, release) {
  showNotificationRow("update", { text: `Nova versão disponível (v${latest})`, onClick: () => openUpdateModal(latest, url, release), type: "update", closable: true, anchor: "#settingsBtn" });
}

// Texto da release (markdown simples: títulos, listas, **negrito**, `código`)
// virando HTML seguro — tudo escapado antes de aplicar a formatação.
function releaseNotesToHtml(md) {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
  let html = "";
  let emLista = false;
  for (const linha of (md || "").split(/\r?\n/)) {
    const l = linha.trim();
    const item = /^[-*]\s+(.*)/.exec(l);
    if (item) {
      if (!emLista) { html += "<ul>"; emLista = true; }
      html += `<li>${inline(item[1])}</li>`;
      continue;
    }
    if (emLista) { html += "</ul>"; emLista = false; }
    const titulo = /^#{1,6}\s+(.*)/.exec(l);
    if (titulo) html += `<h4>${inline(titulo[1])}</h4>`;
    else if (l) html += `<p>${inline(l)}</p>`;
  }
  if (emLista) html += "</ul>";
  return html || "<p>Veja os detalhes na página da release.</p>";
}

// ---------- estatísticas do período ----------

function computePeriodStats() {
  const now = new Date();
  const isMesAtual = currentYear === now.getFullYear() && currentMonth === now.getMonth();
  const { start, end } = apuracaoPeriodFor(isMesAtual ? now : new Date(currentYear, currentMonth, 1));
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const hojeKey = dateKey(hoje);
  const ontem = new Date(hoje);
  ontem.setDate(ontem.getDate() - 1);
  const s = {
    start, end, diasComAjuste: 0, aprovados: 0, melhor: 0, atual: 0, folgas: 0, abonos: 0, ferias: 0,
    faltas: 0, inconsistentes: 0, autos: 0,
  };
  let run = 0, somaEntrada = 0, somaSaida = 0, diasEntrada = 0, diasSaida = 0, somaTrabalhado = 0, diasTrabalhados = 0;
  const minDia = (ms) => { const t = new Date(ms); return t.getHours() * 60 + t.getMinutes(); };
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = dateKey(d);
    const periodo = feriasFolgaParaDia(key);
    if (periodo?.tipo === "folga") s.folgas++;
    if (periodo?.tipo === "abono") s.abonos++;
    if (periodo?.tipo === "ferias") s.ferias++;
    s.autos += (autoBatidas[key] || []).length;
    if (key > hojeKey) continue;
    const ponto = registrosPorDia[key];
    if (ponto?.temAbonoOuAjusteRegistrado) {
      s.diasComAjuste++;
      if ((ponto.statusSolicitacao || "").toLowerCase().includes("aprov")) s.aprovados++;
    }
    if (key === hojeKey) continue; // hoje ainda não fechou
    if (ponto?.falta === "SIM" && isBusinessDay(d) && !periodo) s.faltas++;
    if (ponto?.consistente === "NAO" && !periodo) s.inconsistentes++;
    const batidas = ponto ? batidasOrdenadas(ponto) : [];
    if (batidas.length) {
      somaEntrada += minDia(batidas[0].horario); diasEntrada++;
      if (batidas.length % 2 === 0) { somaSaida += minDia(batidas[batidas.length - 1].horario); diasSaida++; }
      const trab = (ponto.minutoNormalDiurno || 0) + (ponto.minutoNormalNoturno || 0) + (ponto.minutoExtraTP1 || 0) + (ponto.minutoExtraTP2 || 0) + (ponto.minutoExtraTP3 || 0);
      if (trab > 0) { somaTrabalhado += trab; diasTrabalhados++; }
    }
    if (!isBusinessDay(d) || periodo) continue;
    run = ponto && classifyDay(ponto, false) === "green" ? run + 1 : 0;
    s.melhor = Math.max(s.melhor, run);
  }
  s.atual = run;
  s.entradaMedia = diasEntrada ? minutesToHHMM(somaEntrada / diasEntrada) : "--:--";
  s.saidaMedia = diasSaida ? minutesToHHMM(somaSaida / diasSaida) : "--:--";
  s.horasPorDia = diasTrabalhados ? minutesToHHMM(somaTrabalhado / diasTrabalhados) : "--:--";
  const fimSaldo = ontem < end ? ontem : end;
  s.saldo = saldoHorasAteOntem(start, fimSaldo) || "--:--";
  const m = /^([+-]?)(\d+):(\d{2})/.exec(s.saldo);
  const saldoMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  s.tetoMin = jornada6hAtivo ? 0 : countBusinessDays(start, end) * MINUTOS_ABONO_POR_DIA_UTIL;
  s.abonoUsadoMin = Math.min(Math.max(0, -saldoMin), s.tetoMin);
  return s;
}

function openStatsModal() {
  const s = computePeriodStats();
  const fmt = (d) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  $("#statsPeriod").textContent = `Período ${fmt(s.start)} – ${fmt(s.end)}`;
  const item = (valor, rotulo) => `<div class="stat-item"><span class="stat-value">${valor}</span><span class="stat-label">${rotulo}</span></div>`;
  const pct = s.tetoMin ? Math.round((s.abonoUsadoMin / s.tetoMin) * 100) : 0;
  const barra = `<div class="stat-item stat-wide"><span class="stat-value">${minutesToHHMM(s.abonoUsadoMin)} <small>de ${minutesToHHMM(s.tetoMin)}</small></span>
    <div class="stat-bar"><div style="width:${pct}%"></div></div><span class="stat-label">abono usado versus teto do mês</span></div>`;
  $("#statsGrid").innerHTML = [
    item(s.diasComAjuste, "dias com ajuste"),
    item(s.aprovados, "ajustes aprovados"),
    item(s.melhor, "maior sequência de dias sem ajustes"),
    item(s.atual, "sequência atual sem ajustes"),
    item(s.folgas, "dias de folga"),
    item(s.abonos, "dias de abono"),
    item(s.ferias, "dias de férias"),
    item(s.faltas, "dias de falta"),
    item(s.inconsistentes, "dias inconsistentes"),
    item(s.saldo, "saldo do período (extras menos faltantes)"),
    item(s.entradaMedia, "entrada média"),
    item(s.saidaMedia, "saída média"),
    item(s.horasPorDia, "média de horas por dia"),
    barra,
    secretKnock ? item(s.autos, "batidas automáticas") : "",
  ].join("");
  $("#statsModal").classList.remove("hidden");
}

function openUpdateModal(latest, url, release) {
  $("#updateModalTitle").textContent = `Novidades da v${latest}`;
  $("#updateModalNotes").innerHTML = releaseNotesToHtml(release?.body);
  $("#updateModalOpen").onclick = () => { window.open(url, "_blank", "noopener"); closeUpdateModal(); };
  $("#updateModal").classList.remove("hidden");
  chrome.storage.local.set({ updateNotesSeenVersion: latest });
}
function closeUpdateModal() {
  $("#updateModal").classList.add("hidden");
}

async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  const versionEl = $("#appVersion");
  versionEl.textContent = `Versão atual: v${current}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!res.ok) return; // sem release publicado ainda, ou API fora do ar — só mostra a versão instalada
    const release = await res.json();
    const latest = (release.tag_name || "").replace(/^v/, "");
    if (latest && compareVersions(latest, current) > 0) {
      versionEl.innerHTML = `Versão atual: v${current} · <a href="${release.html_url}" target="_blank" rel="noopener">Nova versão disponível (v${latest})</a>`;
      showUpdateNotice(latest, release.html_url, release);
      // mostra o popup de novidades sozinho uma vez por versão nova
      const { updateNotesSeenVersion } = await chrome.storage.local.get("updateNotesSeenVersion");
      if (updateNotesSeenVersion !== latest) openUpdateModal(latest, release.html_url, release);
    }
  } catch (err) {
    // sem internet — mantém só a versão instalada, sem travar nada
  }
}

// ---------- nome do colaborador (header) ----------
//
// Fonte principal: GET /mutuario/{id} (lastMutuario.pessoa.nome) — dispara
// sozinho sempre que a página "Registro de Ponto" carrega, confirmado
// inspecionando a resposta real (ver background.js MUTUARIO_PATH). Fallback:
// buscarTurnoVinculadoColaborador (lastTurno.mutuario.pessoa.nome), que só
// dispara se a pessoa clicar "Detalhar" — por isso não é confiável sozinho
// (é a causa de o nome não aparecer pra quem nunca clicou lá). Se nenhum dos
// dois tiver dado ainda, mantém "Ponto Icarus" (fallback já no HTML).
async function loadNomeColaborador() {
  try {
    const mutuario = await IcarusAPI.getLastMutuario();
    const turno = await IcarusAPI.getLastTurno();
    const nome = mutuario?.pessoa?.nome || turno?.mutuario?.pessoa?.nome;
    if (nome) {
      // só o primeiro nome e o último sobrenome, pra caber numa linha
      const partes = nome.trim().split(/\s+/);
      $("#appTitle").textContent = partes.length > 2 ? `${partes[0]} ${partes[partes.length - 1]}` : nome;
    }
  } catch (err) {
    // sem dado ainda — mantém o fallback "Ponto Icarus"
  }
}

// ---------- classificação dos dias ----------

function batidasOrdenadas(ponto) {
  const batidas = [...(ponto?.pontosHorariosBatidasOrdenados || [])];
  // Ordena por horário em milissegundos
  return batidas.sort((a, b) => {
    const timeA = typeof a.horario === "number" ? a.horario : new Date(a.horario).getTime();
    const timeB = typeof b.horario === "number" ? b.horario : new Date(b.horario).getTime();
    return timeA - timeB;
  });
}

function isBatidaManual(b) {
  // "O" = Original (batida de verdade). Qualquer outro tipo veio de
  // digitação/ajuste — é o que o site marca com asterisco na tabela.
  return b.tipoRegistro && b.tipoRegistro !== "O";
}

/**
 * Horário (timestamp) de um ajuste pendente, pra poder ordená-lo junto
 * com as batidas reais. Usa o horário aproximado informado; se ainda não
 * informou nenhum, cai pro momento em que clicou "ajustar depois" (só
 * como posição provisória).
 */
function pendingTimeMs(dayDate, pend) {
  if (pend.approxTime) {
    const [hh, mm] = pend.approxTime.split(":").map(Number);
    return new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), hh, mm, 0, 0).getTime();
  }
  return pend.clickedAt;
}

/**
 * Batidas reais + ajustes pendentes, todos juntos em ordem cronológica
 * real (não pela ordem em que foram digitados/pela "seq" do lembrete).
 * É isso que corrige uma batida digitada fora de ordem (ex: "2ª saída"
 * digitada com horário anterior a uma batida real já registrada).
 */
function mergedPunchesForDay(key, ordenadas, diaPending) {
  const dayDate = keyToDate(key);
  const real = ordenadas.map((b) => ({ timeMs: b.horario, real: b }));
  const pending = diaPending.map((p) => ({ timeMs: pendingTimeMs(dayDate, p), pending: p }));
  return [...real, ...pending].sort((a, b) => a.timeMs - b.timeMs);
}

function classifyDay(ponto, isToday) {
  if (!ponto) return null;
  // Roxo tem prioridade: o dia teve ajuste/abono registrado no Icarus.
  if (ponto.temAbonoOuAjusteRegistrado === true) return "purple";
  // Hoje ainda está em andamento — o Icarus marca falta/inconsistente pra
  // qualquer dia incompleto, inclusive hoje, mas isso não é um erro real
  // até o dia terminar. Só conta pra dias anteriores.
  if (!isToday && (ponto.falta === "SIM" || ponto.consistente === "NAO")) return "red";
  const batidas = batidasOrdenadas(ponto);
  const trabalhouAlgo = (ponto.minutoNormalDiurno || 0) + (ponto.minutoNormalNoturno || 0) > 0 || batidas.length > 0;
  return trabalhouAlgo ? "green" : null;
}

// ---------- férias / folgas / abono (marcação local, informativa) ----------

const FERIAS_FOLGAS_LABEL = { ferias: "Férias", folga: "Folga", abono: "Abono" };

// Comparação lexical de "YYYY-MM-DD" funciona igual comparação de data.
function feriasFolgaParaDia(key) {
  return feriasFolgasPeriods.find((p) => key >= p.inicio && key <= p.fim) || null;
}

function renderCalendar() {
  const first = new Date(currentYear, currentMonth, 1);
  const last = new Date(currentYear, currentMonth + 1, 0);
  $("#monthLabel").textContent = capitalizeFirst(first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }));

  const grid = $("#calendarGrid");
  grid.innerHTML = "";
  for (let i = 0; i < first.getDay(); i++) {
    const empty = document.createElement("div");
    empty.className = "day empty";
    grid.appendChild(empty);
  }
  const todayKey = dateKey(new Date());
  const holidays = new Set(nationalHolidaySet(currentYear));
  for (let day = 1; day <= last.getDate(); day++) {
    const d = new Date(currentYear, currentMonth, day);
    const key = dateKey(d);
    const ponto = registrosPorDia[key];
    const ferias = feriasFolgaParaDia(key);
    // Prioridade: classificação real do Icarus (roxo/vermelho/verde) primeiro;
    // depois férias/folga/abono programado (ciano/azul-escuro/preto); feriado
    // é o "chão", só aparece cinza quando não tem nenhuma classificação mais
    // importante.
    const cls = classifyDay(ponto, key === todayKey) || (ferias ? ferias.tipo : null) || (holidays.has(key) ? "holiday" : null);
    const hasPending = (pendingAdjustments[key] || []).length > 0;
    const hasAuto = (autoBatidas[key] || []).length > 0;
    const isSelected = selectedDayKey ? key === selectedDayKey : key === todayKey;
    const cell = document.createElement("div");
    cell.className = `day${cls ? " " + cls : ""}${key === todayKey ? " today" : ""}${isSelected ? " selected" : ""}${hasPending ? " has-pending" : ""}${hasAuto ? " has-auto" : ""}`;
    cell.innerHTML = `<span class="chip">${day}</span>`;
    cell.classList.add("clickable");
    cell.addEventListener("click", () => selectDay(d));
    grid.appendChild(cell);
  }
}

function selectDay(date) {
  const todayKey = dateKey(new Date());
  const key = dateKey(date);
  selectedDayKey = key === todayKey ? null : key; // clicar em hoje volta ao modo "hoje"
  renderCalendar();
  renderDayPanel();
}

// ---------- painel do dia (hoje por padrão, ou o dia selecionado) ----------

function renderDayPanel() {
  const isToday = !selectedDayKey;
  const key = selectedDayKey || dateKey(new Date());
  const date = keyToDate(key);
  const ponto = registrosPorDia[key];
  const ordenadas = batidasOrdenadas(ponto);
  const diaPending = pendingAdjustments[key] || [];
  // "delete" é lembrete sobre uma batida que JÁ existe — não entra no merge
  // cronológico (que é só pra preencher slots vazios) nem no alerta de
  // batida faltando (que é sobre slots que ainda não aconteceram).
  const diaPendingMissing = diaPending.filter((p) => p.type !== "delete");
  const diaPendingDelete = diaPending.filter((p) => p.type === "delete");
  // batida marcada como "pendente de exclusão" some do cartão e da contagem
  // — é assim que o dia vai ficar assim que a exclusão for aprovada de
  // verdade, e é o que deixa a próxima batida real ocupar o slot certo
  // (ex: a 2ª saída de verdade vira a 4ª batida, não a 5ª).
  const ordenadasVisiveis = ordenadas.filter((b) => !diaPendingDelete.some((p) => p.horarioMs === b.horario));

  $("#dayPanelTitle").textContent = isToday
    ? "Batidas de hoje"
    : `Batidas de ${date.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" })}`;
  $("#backToTodayBtn").classList.toggle("hidden", isToday);
  $("#workedLabel").textContent = isToday ? "Trabalhado hoje" : "Trabalhado";
  $("#remainingLabel").textContent = isToday ? "Falta trabalhar" : "Faltando";

  // tags do dia
  const tags = [];
  if (ponto?.temAbonoOuAjusteRegistrado) tags.push(`<span class="tag purple">Ajuste/abono${ponto.statusSolicitacao ? " · " + ponto.statusSolicitacao.toLowerCase() : ""}</span>`);
  // Hoje ainda está em andamento — falta/inconsistente só vale pra dias
  // anteriores já fechados (ver classifyDay).
  if (!isToday && ponto?.falta === "SIM") tags.push('<span class="tag red">Falta</span>');
  if (!isToday && ponto?.consistente === "NAO") tags.push('<span class="tag red">Inconsistente</span>');
  if (diaPending.length) tags.push(`<span class="tag orange">${diaPending.length} ajuste${diaPending.length > 1 ? "s" : ""} pendente${diaPending.length > 1 ? "s" : ""}</span>`);
  $("#dayPanelTags").innerHTML = tags.join("");

  // 4 batidas (compacto) — reais (já sem as marcadas p/ exclusão) e
  // pendentes juntas, em ordem cronológica real
  const merged = mergedPunchesForDay(key, ordenadasVisiveis, diaPendingMissing);
  const periodoDia = feriasFolgaParaDia(key);
  document.querySelectorAll(".punch").forEach((el) => {
    const seq = Number(el.dataset.seq);
    const item = merged[seq - 1];
    const valueEl = el.querySelector(".value");
    el.classList.remove("manual", "pending", "fillable", "deletable", "predicted", "auto-punch", "manual-punch", "dia-ferias", "dia-folga", "dia-abono");
    // dia de férias/folga/abono: os cartões assumem a cor do tipo (ganha de rosa/verde)
    if (periodoDia) el.classList.add(`dia-${periodoDia.tipo}`);
    el.onclick = null;
    if (item?.real) {
      const b = item.real;
      valueEl.textContent = b.horarioFormatadoSemData || "--:--";
      el.classList.toggle("manual", isBatidaManual(b));
      if (!isBatidaManual(b) && !periodoDia) {
        // batida original: rosa se foi o auto registro (instante bate com a
        // batida em até 3min), verde se foi bater na mão
        const automatica = (autoBatidas[key] || []).some((t) => Math.abs(t - b.horario) <= 3 * 60000);
        el.classList.add(automatica ? "auto-punch" : "manual-punch");
      }
      el.classList.add("deletable");
      el.dataset.tooltip = `${b.marcacaoFmt || ""}${isBatidaManual(b) ? ` · ${b.tipoRegistroFmt}` : ""} · Clique pra marcar como pendente de exclusão.`;
      el.onclick = () => markPunchPendingDeletion(key, seq, b);
    } else if (item?.pending) {
      const pend = item.pending;
      // O rótulo (1ª entrada / 1ª saída / ...) é sempre o da posição ATUAL
      // na ordem cronológica — não o que foi gravado quando a pessoa
      // informou o horário. A posição pode mudar depois (ex: cancelar uma
      // exclusão pendente de outra batida empurra este ajuste pra outro
      // lugar), e o rótulo salvo (pend.label) ficaria desatualizado.
      const label = PUNCH_SCHEDULE.find((s) => s.seq === seq)?.label || pend.label || `${seq}ª batida`;
      const shown = pend.approxTime || hhmm(pend.clickedAt);
      valueEl.textContent = `~${shown}`;
      el.classList.add("pending", "fillable");
      el.dataset.tooltip = pend.approxTime
        ? `Ajuste manual: ${pend.approxTime}, ainda não registrado no Icarus. Clique pra editar.`
        : `Marcado como "ajustar depois" às ${hhmm(pend.clickedAt)}, ainda não registrado no Icarus. Clique pra informar o horário.`;
      el.onclick = () => openPunchTimeModal(key, pend.seq, label, pend.approxTime);
    } else {
      const label = PUNCH_SCHEDULE.find((s) => s.seq === seq)?.label || `${seq}ª batida`;
      valueEl.textContent = "--:--";
      el.classList.add("fillable");
      el.dataset.tooltip = "Batida não registrada. Clique pra informar o horário aproximado.";
      el.onclick = () => openPunchTimeModal(key, seq, label, null);
    }

    // ✔ do Auto registro: só hoje, só 2ª/3ª/4ª, e só enquanto a batida ainda
    // não existe (nem real, nem ajuste pendente ocupando o slot)
    const chk = el.querySelector(".auto-check");
    if (chk) {
      chk.classList.toggle("hidden", !(secretKnock && isToday && seq >= 2 && !item?.real && !item?.pending));
      chk.classList.toggle("armed", (autoMarcadas[key] || []).includes(seq));
    }
  });

  renderMissingPunchAlert(key, ordenadasVisiveis, diaPendingMissing, isToday);

  // motivos das batidas ajustadas manualmente (detalhe extra)
  const motivos = ordenadas.filter((b) => isBatidaManual(b) && b.motivo);
  const motivoBox = $("#dayPanelMotivos");
  if (motivos.length) {
    motivoBox.classList.remove("hidden");
    motivoBox.innerHTML = motivos
      .map((b) => `<div class="motivo-item"><strong>${b.marcacaoFmt || "Ajuste"} (${b.horarioFormatadoSemData}):</strong> “${b.motivo}”</div>`)
      .join("");
  } else {
    motivoBox.classList.add("hidden");
    motivoBox.innerHTML = "";
  }

  // ajustes pendentes (lembrete "ajustar depois", horário digitado, ou
  // exclusão pendente de uma batida real)
  const pendingBox = $("#pendingAdjustmentsToday");
  if (diaPending.length) {
    pendingBox.classList.remove("hidden");
    pendingBox.innerHTML = diaPending
      .map((p) => {
        if (p.type === "delete") {
          return `<div class="pending-item pending-item-delete">
            <label class="pending-check-label">
              <input type="checkbox" class="pending-check" data-horario="${p.horarioMs}" ${p.done ? "checked" : ""} />
              <span class="pending-text${p.done ? " struck" : ""}">Exclusão pendente: ${p.label} (${p.horario})</span>
            </label>
            <button type="button" class="pending-cancel" data-horario="${p.horarioMs}" title="Cancelar exclusão pendente">✕</button>
          </div>`;
        }
        // Mesmo motivo do rótulo nos cartões: usa a posição cronológica
        // ATUAL (onde esse ajuste caiu no merge com as outras batidas), não
        // o rótulo salvo em p.label — que fica desatualizado se outra
        // batida do dia mudar depois (ex: cancelar uma exclusão pendente).
        const posAtual = merged.findIndex((item) => item.pending === p) + 1;
        const label = (posAtual > 0 && PUNCH_SCHEDULE.find((s) => s.seq === posAtual)?.label) || p.label;
        const texto = p.approxTime
          ? `${label} ${p.approxTime}, falta registrar no Icarus.`
          : `${label}, clicado em "ajustar depois" às ${hhmm(p.clickedAt)}, falta registrar no Icarus.`;
        return `<div class="pending-item">
          <label class="pending-check-label">
            <input type="checkbox" class="pending-adjust-check" data-seq="${p.seq}" ${p.done ? "checked" : ""} />
            <span class="pending-text${p.done ? " struck" : ""}">${texto}</span>
          </label>
          <button type="button" class="pending-cancel" data-remove-seq="${p.seq}" title="Remover ajuste pendente">✕</button>
        </div>`;
      })
      .join("");
    pendingBox.querySelectorAll(".pending-check").forEach((cb) => {
      cb.addEventListener("change", () => IcarusAPI.setPendingDeletionDone(key, Number(cb.dataset.horario), cb.checked));
    });
    // "já cadastrei no Icarus" — só risca o texto; o ajuste continua no
    // cartão e nas contas até ser aprovado. Quando a busca mostrar o ajuste
    // aprovado, reconcilePendingAdjustments (background.js) remove o item.
    pendingBox.querySelectorAll(".pending-adjust-check").forEach((cb) => {
      cb.addEventListener("change", () => IcarusAPI.setPendingAdjustmentDone(key, Number(cb.dataset.seq), cb.checked));
    });
    pendingBox.querySelectorAll(".pending-cancel[data-horario]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await showConfirm("A batida volta a aparecer no cartão de batidas.", {
          title: "Cancelar exclusão pendente",
          okLabel: "Cancelar exclusão",
          cancelLabel: "Voltar",
        });
        if (ok) IcarusAPI.resolvePendingDeletion(key, Number(btn.dataset.horario));
      });
    });
    pendingBox.querySelectorAll(".pending-cancel[data-remove-seq]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await showConfirm("O ajuste manual será removido. Você pode informar de novo depois se ainda precisar.", {
          title: "Remover ajuste pendente",
          okLabel: "Remover",
          cancelLabel: "Voltar",
        });
        if (ok) IcarusAPI.removePendingAdjustment(key, Number(btn.dataset.removeSeq));
      });
    });
  } else {
    pendingBox.classList.add("hidden");
    pendingBox.innerHTML = "";
  }

  // nota do dia
  $("#dayPanelNota").innerHTML = ponto?.nota ? `<div class="day-nota"><span>Nota</span>${ponto.nota}</div>` : "";

  renderFeriasFolgasList();

  // contadores: hoje é ao vivo (atualiza sozinho); outro dia é estático (Icarus)
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (isToday) {
    tickLive();
    liveTimer = setInterval(tickLive, 30000);
  } else {
    const diaPendingComHorarioSel = diaPendingMissing.filter((p) => p.approxTime);
    const mergedTimesSel = ponto ? mergedPunchesForDay(key, ordenadasVisiveis, diaPendingComHorarioSel).map((item) => item.timeMs) : [];

    // Trabalhado/Falta trabalhar de QUALQUER dia (não só hoje) vêm sempre das
    // batidas reais + ajustes anotados na extensão, nunca de tempoNormal/
    // tempoFaltando do Icarus — a meta ali pode não bater com a que o
    // funcionário está mirando hoje (8h vs 8h48, via abono diário). Sem
    // nenhum dado do dia (nem ponto, nem ajuste), não dá pra saber nada.
    if (!ponto && !diaPendingComHorarioSel.length) {
      $("#workedToday").textContent = "--:--";
      $("#remainingToday").textContent = "--:--";
    } else {
      let workedLocal = 0;
      for (let i = 0; i + 1 < mergedTimesSel.length; i += 2) workedLocal += (mergedTimesSel[i + 1] - mergedTimesSel[i]) / 60000;
      const metaMin = metaMinutosHoje();
      $("#workedToday").textContent = minutesToHHMM(workedLocal);
      $("#remainingToday").textContent = minutesToHHMM(Math.max(0, metaMin - workedLocal));
    }
    $("#intervalToday").textContent = ponto ? minutesToHHMM(intervalMinutesFromTimes(mergedTimesSel)) : "--:--";
  }
}

/**
 * Detecta proativamente uma batida que já deveria ter acontecido e ainda
 * não tem registro (nem real, nem pendente) — ex: já é tarde e falta a
 * volta do almoço. Só avisa pro dia de HOJE (não faz sentido cobrar
 * horário de um dia passado que já fechou de outro jeito).
 */
function renderMissingPunchAlert(key, ordenadas, diaPending, isToday) {
  const alertBox = $("#missingPunchAlert");
  if (!isToday) {
    alertBox.classList.add("hidden");
    return;
  }
  const now = new Date();
  const punchCount = ordenadas.length;
  const next = PUNCH_SCHEDULE.find((s) => s.seq === punchCount + 1);
  if (!next) { alertBox.classList.add("hidden"); return; }
  if (diaPending.some((p) => p.seq === next.seq)) { alertBox.classList.add("hidden"); return; }

  const scheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), next.hh, next.mm);
  const lateMin = (now - scheduled) / 60000;
  if (lateMin < MISSING_PUNCH_GRACE_MIN) { alertBox.classList.add("hidden"); return; }

  alertBox.classList.remove("hidden");
  $("#missingPunchText").textContent = `Falta registrar: ${next.label}.`;
  $("#missingPunchFillBtn").onclick = () => openPunchTimeModal(key, next.seq, next.label, null);
}

// ---------- exclusão pendente (lembrete local, não mexe no Icarus) ----------

async function markPunchPendingDeletion(key, seq, batida) {
  const label = batida.marcacaoFmt || PUNCH_SCHEDULE.find((s) => s.seq === seq)?.label || `${seq}ª batida`;
  const horario = batida.horarioFormatadoSemData || "";
  const ok = await showConfirm(
    `Marcar a batida das ${horario} (${label}) como pendente de exclusão?\n\n` +
    "Ela some do cartão de batidas (como se já tivesse sido excluída de verdade) e passa a aparecer só na lista " +
    "de ajustes pendentes. Isso não mexe no Icarus, solicite a exclusão de verdade no site; dá pra cancelar o " +
    "lembrete por lá se você errar a mão.",
    { title: "Pendente de exclusão", okLabel: "Marcar" }
  );
  if (!ok) return;
  await IcarusAPI.markPendingDeletion(key, batida.horario, label, horario);
}

// ---------- horário aproximado de uma batida faltante ----------

let punchTimeModalCtx = null; // { dateKey, seq, label }

// Converte "HH:MM" string para minutos desde meia-noite
function timeStrToMinutes(timeStr) {
  if (!timeStr || timeStr.length !== 5) return null;
  const [hh, mm] = timeStr.split(":").map(Number);
  return hh * 60 + mm;
}

/**
 * Recalcula trabalhado/falta pro dia `key` como ficaria SE a batida `seq`
 * valesse `inputTimeStr` — usa a mesma lógica de "merge cronológico" de
 * mergedPunchesForDay (não importa a ordem em que foi digitada), somando os
 * pares entrada/saída reais + pendentes (exceto a que está sendo editada,
 * que entra com o valor do campo em vez do valor salvo).
 */
function computeTotalsForDayPreview(key, seq, inputTimeStr) {
  const inputMinutes = timeStrToMinutes(inputTimeStr);
  const ponto = registrosPorDia[key];
  const ordenadas = ponto ? batidasOrdenadas(ponto) : [];
  const diaPendingList = pendingAdjustments[key] || [];
  const diaPendingDelete = diaPendingList.filter((p) => p.type === "delete");
  const ordenadasVisiveis = ordenadas.filter((b) => !diaPendingDelete.some((p) => p.horarioMs === b.horario));
  const outrasPendentesComHorario = diaPendingList.filter((p) => p.type !== "delete" && p.approxTime && p.seq !== seq);

  const merged = mergedPunchesForDay(key, ordenadasVisiveis, outrasPendentesComHorario).map((item) => item.timeMs);

  if (inputMinutes !== null) {
    const dayDate = keyToDate(key);
    const hypTime = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 0, 0, 0).getTime() + inputMinutes * 60000;
    merged.push(hypTime);
  }
  merged.sort((a, b) => a - b);

  let workedMin = 0;
  for (let i = 0; i + 1 < merged.length; i += 2) {
    workedMin += (merged[i + 1] - merged[i]) / 60000;
  }
  const isToday = key === dateKey(new Date());
  if (merged.length % 2 === 1 && isToday) {
    workedMin += (Date.now() - merged[merged.length - 1]) / 60000;
  }

  // Meta fixa (8h, ou 8h48/6h com o checkbox) pra qualquer dia, não só hoje —
  // nunca depende do que o Icarus calculou pro dia (ver renderDayPanel).
  const metaMin = metaMinutosHoje();

  return { worked: workedMin, remaining: Math.max(0, metaMin - workedMin) };
}

function updatePunchTimePreview() {
  if (!punchTimeModalCtx) return;

  const inputValue = $("#punchTimeModalInput").value;
  if (!inputValue) {
    $("#punchTimePreview").classList.add("hidden");
    return;
  }

  const { dateKey: key, seq } = punchTimeModalCtx;
  const totals = computeTotalsForDayPreview(key, seq, inputValue);
  $("#previewWorked").textContent = minutesToHHMM(totals.worked);
  $("#previewRemaining").textContent = minutesToHHMM(totals.remaining);
  $("#punchTimePreview").classList.remove("hidden");
}

function openPunchTimeModal(dateKeyStr, seq, label, existingApproxTime) {
  punchTimeModalCtx = { dateKey: dateKeyStr, seq, label };
  $("#punchTimeModalLabel").textContent = label;
  $("#punchTimeModalInput").value = existingApproxTime || hhmm(Date.now());
  $("#punchTimeModal").classList.remove("hidden");
  updatePunchTimePreview();
}

function closePunchTimeModal() {
  $("#punchTimeModal").classList.add("hidden");
  punchTimeModalCtx = null;
  $("#punchTimePreview").classList.add("hidden");
}

function clearPunchTimeInput() {
  $("#punchTimeModalInput").value = "";
  $("#punchTimePreview").classList.add("hidden");
}

async function savePunchTimeModal() {
  if (!punchTimeModalCtx) return;
  const value = $("#punchTimeModalInput").value; // "HH:MM"
  const { dateKey: dk, seq, label } = punchTimeModalCtx;
  // Campo limpo (botão "✕" do modal) + Salvar = remover o ajuste pendente,
  // mesmo caminho do "✕" da lista de ajustes pendentes — antes isso só
  // fechava sem fazer nada (nem salvava, nem removia).
  if (!value) {
    await IcarusAPI.removePendingAdjustment(dk, seq);
    closePunchTimeModal();
    return;
  }
  await IcarusAPI.setPendingAdjustmentTime(dk, seq, label, value);
  closePunchTimeModal();
  // Removido: só fazia sentido se o ajuste fosse enviado de verdade pro
  // Icarus. Hoje ele só fica salvo localmente na extensão, então esse aviso
  // não agrega nada — reativar se um dia isso mudar.
  // showStatus(`Ajuste manual salvo para "${label}", lembre de ajustar de verdade no Icarus.`, "info");
  // storage.onChanged já dispara icarus:pendingAdjustmentsChanged, que recarrega
}

/**
 * Trabalhado / falta trabalhar de HOJE, atualizando ao longo do tempo.
 * Base: os números que o próprio Icarus calculou (autoritativos, já
 * consideram a escala do dia). Se há um número ímpar de batidas, o turno
 * está em aberto — somamos o tempo corrido desde a última batida.
 */
function tickLive() {
  const key = dateKey(new Date());
  const ponto = registrosPorDia[key];
  const workedEl = $("#workedToday");
  const intervalEl = $("#intervalToday");
  const remainingEl = $("#remainingToday");
  const punch2 = document.querySelector('.punch[data-seq="2"]');
  const punch3 = document.querySelector('.punch[data-seq="3"]');
  const punch4 = document.querySelector('.punch[data-seq="4"]');

  const ordenadas = ponto ? batidasOrdenadas(ponto) : [];
  const diaPendingList = pendingAdjustments[key] || [];
  // batida marcada como "pendente de exclusão" não pode entrar na conta —
  // ela ainda está nos dados do Icarus (é por isso que dá pra marcar pra
  // excluir), mas some do cartão e deve sumir do cálculo também.
  const diaPendingDelete = diaPendingList.filter((p) => p.type === "delete");
  const ordenadasVisiveis = ordenadas.filter((b) => !diaPendingDelete.some((p) => p.horarioMs === b.horario));
  // batida(s) digitada(s) mas ainda não enviada(s) ao Icarus — o Icarus só
  // viu as reais, então não dá pra confiar no total dele; recalculamos
  // somando os intervalos entrada/saída da sequência completa (real + pendente).
  const diaPendingComHorario = diaPendingList.filter((p) => p.type !== "delete" && p.approxTime);

  if (!ponto && !diaPendingComHorario.length) {
    // nada aconteceu hoje ainda: nem batida real registrada no Icarus, nem digitada
    workedEl.textContent = "--:--";
    intervalEl.textContent = "--:--";
    remainingEl.textContent = "--:--";
    [punch2, punch3, punch4].forEach((el) => el?.classList.remove("predicted"));
    return;
  }

  // Meta de hoje é sempre fixa (8:00, ou 8:48 com "8:48 hoje" marcado) —
  // nunca depende do que o Icarus calculou pro dia, pra ficar previsível.
  const metaMin = metaMinutosHoje();

  // sequência cronológica só dos instantes (reais visíveis + pendentes com
  // horário) — usada sempre pro trabalhado/intervalo de hoje, nunca o total
  // pronto do Icarus (minutoNormalDiurno etc.): logo depois de bater a
  // última batida do dia, esses campos agregados do Icarus ainda podem
  // estar defasados (só a lista de batidas em si já vem atualizada),
  // então somar os pares entrada/saída na hora é o único jeito confiável.
  const mergedTimes = mergedPunchesForDay(key, ordenadasVisiveis, diaPendingComHorario).map((item) => item.timeMs);

  let workedMin = 0;
  for (let i = 0; i + 1 < mergedTimes.length; i += 2) {
    workedMin += (mergedTimes[i + 1] - mergedTimes[i]) / 60000;
  }
  const emAndamento = mergedTimes.length % 2 === 1;
  if (emAndamento) workedMin += (Date.now() - mergedTimes[mergedTimes.length - 1]) / 60000;

  const remainingMin = Math.max(0, metaMin - workedMin);
  workedEl.textContent = minutesToHHMM(workedMin);
  intervalEl.textContent = minutesToHHMM(intervalMinutesFromTimes(mergedTimes));
  remainingEl.textContent = minutesToHHMM(remainingMin);

  // previsão das batidas restantes — estimativa a partir da 1ª batida real
  // (meta fixa de hoje, 8:00 ou 8:48 com o checkbox, dividida em duas
  // metades com o mínimo de almoço configurado no meio); nunca é uma
  // batida, só some assim que a batida real (ou uma pendente) ocupar o slot.
  const applyPredictedPunch = (el, timeMs, tooltip) => {
    if (!el || !el.classList.contains("fillable")) return;
    el.classList.add("predicted");
    el.querySelector(".value").textContent = `~${hhmm(timeMs)}`;
    el.dataset.tooltip = tooltip;
  };
  [punch2, punch3, punch4].forEach((el) => el?.classList.remove("predicted"));

  // Base da meta usada nas previsões abaixo: 8:48 menos o abono do período,
  // ou 8:48 "seco" (sem descontar abono) quando "8:48 hoje" está marcado.
  const metaMinPrevisao = metaMinutosHoje();

  if (mergedTimes.length === 1) {
    const metadeMin = metaMinPrevisao / 2;
    const saida1Pred = mergedTimes[0] + metadeMin * 60000;
    const entrada2Pred = saida1Pred + almocoMinAtual * 60000;
    const saida2Pred = entrada2Pred + metadeMin * 60000;
    applyPredictedPunch(punch2, saida1Pred, "Previsão de saída pro almoço (estimativa, não é uma batida real). Clique pra informar o horário quando bater de verdade.");
    applyPredictedPunch(punch3, entrada2Pred, "Previsão de volta do almoço (estimativa, não é uma batida real). Clique pra informar o horário quando bater de verdade.");
    applyPredictedPunch(punch4, saida2Pred, "Previsão de saída (estimativa, não é uma batida real). Clique pra informar o horário quando bater de verdade.");
  } else if (mergedTimes.length === 2) {
    const metaMin = metaMinPrevisao;
    const manhaMin = (mergedTimes[1] - mergedTimes[0]) / 60000;
    const restanteMin = Math.max(0, metaMin - manhaMin);
    const entrada2Pred = mergedTimes[1] + almocoMinAtual * 60000;
    const saida2Pred = entrada2Pred + restanteMin * 60000;
    applyPredictedPunch(punch3, entrada2Pred, "Previsão de volta do almoço (estimativa, não é uma batida real). Clique pra informar o horário quando bater de verdade.");
    applyPredictedPunch(punch4, saida2Pred, "Previsão de saída (estimativa, não é uma batida real). Clique pra informar o horário quando bater de verdade.");
  } else if (mergedTimes.length === 3) {
    applyPredictedPunch(punch4, Date.now() + remainingMin * 60000, "Previsão de saída (estimativa, não é uma batida real). Clique pra informar o horário quando bater de verdade.");
  }
}

// ---------- registrar ponto ----------

// Troca texto <-> 👍 por 2s no botão de bater ponto. Separada de baterPonto()
// de propósito: dá pra testar a animação sozinha no console do painel
// (`playBaterPontoSuccessAnimation()`) sem registrar ponto de verdade.
let baterPontoSuccessTimer = null;
let baterPontoExitTimer = null;
function playBaterPontoSuccessAnimation() {
  const btn = $("#baterPontoBtn");
  clearTimeout(baterPontoSuccessTimer);
  clearTimeout(baterPontoExitTimer);
  btn.classList.remove("success", "success-exit");
  void btn.offsetWidth; // força reflow pra reiniciar a animação do zero
  btn.classList.add("success");
  baterPontoSuccessTimer = setTimeout(() => {
    btn.classList.remove("success");
    void btn.offsetWidth; // força reflow pra reiniciar a animação de saída
    btn.classList.add("success-exit");
    baterPontoExitTimer = setTimeout(() => btn.classList.remove("success-exit"), 400);
  }, 2000);
}

async function baterPonto() {
  const ok = await showConfirm("Registrar ponto agora, no horário atual, na aba do Icarus?", {
    title: "Registrar Ponto",
    okLabel: "Registrar",
  });
  if (!ok) return;
  const btn = $("#baterPontoBtn");
  btn.disabled = true;
  showStatus("Registrando ponto na aba do Icarus…", "info");
  try {
    await IcarusAPI.baterPonto();
    showStatus("Ponto registrado! Atualizando…", "info");
    playBaterPontoSuccessAnimation();
    setTimeout(fetchMonth, 1200);
  } catch (err) {
    showSearchError(err, "Erro ao registrar ponto");
  } finally {
    btn.disabled = false;
  }
}

// ---------- wiring ----------

document.addEventListener("DOMContentLoaded", async () => {
  $("#prevMonth").addEventListener("click", () => {
    currentMonth--;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    loadMonth();
  });
  $("#nextMonth").addEventListener("click", () => {
    currentMonth++;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    loadMonth();
  });
  $("#refreshBtn").addEventListener("click", async () => {
    await fetchMonth();
    fetchFlexibilizacao();
  });

  $("#backToTodayBtn").addEventListener("click", () => {
    selectedDayKey = null;
    renderCalendar();
    renderDayPanel();
  });

  $("#punchTimeModalCancel").addEventListener("click", closePunchTimeModal);
  $("#punchTimeModalSave").addEventListener("click", savePunchTimeModal);
  $("#punchTimeModalInput").addEventListener("input", updatePunchTimePreview);
  $("#punchTimeModalClear").addEventListener("click", clearPunchTimeInput);

  $("#baterPontoBtn").addEventListener("click", baterPonto);

  $("#almocoUmaHoraCheck").addEventListener("change", async (ev) => {
    almocoMinAtual = ev.target.checked ? 60 : 30;
    await IcarusAPI.setAlmocoMinConfig(almocoMinAtual);
    tickLive();
  });

  $("#jornada848Check").addEventListener("change", async (ev) => {
    jornada848Ativo = ev.target.checked;
    if (jornada848Ativo && jornada6hAtivo) {
      jornada6hAtivo = false;
      $("#jornada6hCheck").checked = false;
      await IcarusAPI.setJornada6hConfig(false);
    }
    await IcarusAPI.setJornada848Config(jornada848Ativo);
    showFlexibilizacaoInstant();
    tickLive();
  });

  $("#jornada6hCheck").addEventListener("change", async (ev) => {
    jornada6hAtivo = ev.target.checked;
    if (jornada6hAtivo && jornada848Ativo) {
      jornada848Ativo = false;
      $("#jornada848Check").checked = false;
      await IcarusAPI.setJornada848Config(false);
    }
    await IcarusAPI.setJornada6hConfig(jornada6hAtivo);
    showFlexibilizacaoInstant();
    tickLive();
  });

  document.querySelectorAll(".auto-check").forEach((chk) => {
    const seq = Number(chk.dataset.seq);
    const toggle = async (ev) => {
      ev.stopPropagation();
      await IcarusAPI.toggleAutoRegistroMarcada(dateKey(new Date()), seq);
    };
    chk.addEventListener("click", toggle);
    chk.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(ev); } });
    // roda no próprio elemento, antes do tooltip global ler o data-tooltip
    chk.addEventListener("mouseover", () => updateAutoCheckTooltip(chk));
    chk.addEventListener("focus", () => updateAutoCheckTooltip(chk));
  });

  $("#settingsBtn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleSettingsPopup();
  });
  document.addEventListener("click", (ev) => {
    const popup = $("#settingsPopup");
    if (!popup.classList.contains("hidden") && !popup.contains(ev.target) && ev.target !== $("#settingsBtn")) {
      closeSettingsPopup();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeSettingsPopup();
  });
  window.addEventListener("resize", () => {
    if (!$("#settingsPopup").classList.contains("hidden")) positionSettingsPopup();
    if (notificationRows.size > 0) positionNotificationStack();
  });
  // O side panel do Chrome não recarrega ao fechar/reabrir — o JS continua
  // rodando, só fica escondido. Um aviso que já estava de pé (ex.: "nova
  // versão disponível") ficava com a posição antiga, calculada da última
  // vez que o painel esteve visível — se o painel reabrir com outro
  // tamanho, ele aparecia deslocado. Reposiciona sempre que volta a ficar
  // visível, não só num resize.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (notificationRows.size > 0) positionNotificationStack();
    if (!$("#settingsPopup").classList.contains("hidden")) positionSettingsPopup();
  });

  $("#addFeriasFolgasBtn").addEventListener("click", openFeriasFolgasModal);
  $("#feriasFolgasCancel").addEventListener("click", closeFeriasFolgasModal);
  $("#updateModalLater").addEventListener("click", closeUpdateModal);
  $("#statsBtn").addEventListener("click", openStatsModal);
  $("#statsClose").addEventListener("click", () => $("#statsModal").classList.add("hidden"));
  $("#statsModal").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.classList.add("hidden"); });
  $("#achievementsBtn").addEventListener("click", openAchievementsModal);
  $("#achievementsClose").addEventListener("click", () => $("#achievementsModal").classList.add("hidden"));
  $("#achievementsModal").addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) ev.currentTarget.classList.add("hidden");
  });
  $("#feriasFolgasSave").addEventListener("click", saveFeriasFolgasModal);

  $("#confirmModalCancel").addEventListener("click", () => closeConfirm(false));
  $("#confirmModalOk").addEventListener("click", () => closeConfirm(true));

  document.addEventListener("icarus:observed", (ev) => {
    const { url, data } = ev.detail || {};
    if (url && url.includes("/ponto/consultarRegistrosPonto") && data) ingestRegistros(data);
  });
  document.addEventListener("icarus:pendingAdjustmentsChanged", loadPendingAdjustments);
  document.addEventListener("icarus:autoBatidasChanged", loadAutoBatidas);
  document.addEventListener("icarus:autoMarcadasChanged", loadAutoMarcadas);

  // 1) recupera o que já tinha sido visto na última vez que o painel foi
  // aberto — sem isso, cada reabertura começa com registrosPorDia vazio e
  // o painel pisca "--:--"/sem cor até a busca real responder.
  const { cachedRegistrosPorDia } = await chrome.storage.local.get("cachedRegistrosPorDia");
  if (cachedRegistrosPorDia) registrosPorDia = cachedRegistrosPorDia;

  // 2) desenha o calendário e o restante da UI na hora, sem esperar rede
  initTooltips();
  renderCalendar();
  renderDayPanel();
  loadPendingAdjustments();
  loadFeriasFolgasPeriods();
  loadAutoBatidas();
  setupSecretKnock();
  setupBadgePeek();
  ({ achievementsEarned = {}, achievementsUnseen = [] } = await chrome.storage.local.get({ achievementsEarned: {}, achievementsUnseen: [] }));
  updateTrophyGlow();
  achievementsReady = true;
  renderAchievements();
  refreshAchievements();
  const { secretKnockAtivo } = await chrome.storage.local.get({ secretKnockAtivo: false });
  applySecretKnock(secretKnockAtivo);
  loadAutoMarcadas();
  showFlexibilizacaoInstant();
  checkForUpdate();
  loadNomeColaborador();
  almocoMinAtual = await IcarusAPI.getAlmocoMinConfig();
  $("#almocoUmaHoraCheck").checked = almocoMinAtual === 60;
  jornada848Ativo = await IcarusAPI.getJornada848Config();
  $("#jornada848Check").checked = jornada848Ativo;
  jornada6hAtivo = await IcarusAPI.getJornada6hConfig();
  $("#jornada6hCheck").checked = jornada6hAtivo;
  showFlexibilizacaoInstant();
  tickLive();
  // 3) só então dispara a busca real (assíncrona) que atualiza os dias —
  // em sequência, não em paralelo, pra não disputar a mesma aba do Icarus
  await fetchMonth();
  fetchFlexibilizacao();
  loadNomeColaborador();

  // saldo/abono/período sobem ao longo do dia — reavalia a cada minuto,
  // independente do dia selecionado no calendário.
  setInterval(showFlexibilizacaoInstant, 60000);
});
