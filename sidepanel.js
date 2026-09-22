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
  { seq: 2, hh: 12, mm: 0, label: "1ª saída (almoço)" },
  { seq: 3, hh: 13, mm: 0, label: "volta do almoço (2ª entrada)" },
  { seq: 4, hh: 17, mm: 0, label: "saída (2ª saída)" },
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

async function loadFeriasFolgasPeriods() {
  feriasFolgasPeriods = await IcarusAPI.getFeriasFolgasPeriods();
  renderFeriasFolgasList();
  renderCalendar();
}

function fmtDDMMYYYY(key) {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

function renderFeriasFolgasList() {
  const box = $("#feriasFolgasList");
  if (!feriasFolgasPeriods.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = feriasFolgasPeriods
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
  $("#feriasFolgasTipo").value = "ferias";
  const hoje = dateKey(new Date());
  $("#feriasFolgasInicio").value = hoje;
  $("#feriasFolgasFim").value = hoje;
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

async function fetchMonth() {
  const first = new Date(currentYear, currentMonth, 1);
  const last = new Date(currentYear, currentMonth + 1, 0);
  $("#monthLabel").textContent = capitalizeFirst(first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }));

  try {
    await IcarusAPI.searchPeriod(first, last);
    await new Promise((r) => setTimeout(r, 1200));
    const { data } = await IcarusAPI.getLastRegistros();
    if (data) ingestRegistros(data);
    playRefreshSuccessAnimation();
  } catch (err) {
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

// Ajuste pendente em qualquer dia do período: solicitação real no Icarus
// ainda aguardando o gestor, OU lembrete local da extensão ("ajustar
// depois"/horário aproximado ainda não registrado).
function periodoTemAjustePendente(start, end) {
  const d = new Date(start);
  while (d <= end) {
    const key = dateKey(d);
    const ponto = registrosPorDia[key];
    if (ponto?.temAbonoOuAjusteRegistrado === true && (ponto.statusSolicitacao || "").toLowerCase().includes("aguardando")) return true;
    if ((pendingAdjustments[key] || []).length > 0) return true;
    d.setDate(d.getDate() + 1);
  }
  return false;
}

// Dia do período em que o Icarus registrou trabalho mas com menos de 4
// batidas reais — mesma heurística de "trabalhou algo" do classifyDay.
function periodoTemDiaComPoucasBatidas(start, end) {
  const d = new Date(start);
  while (d <= end) {
    const ponto = registrosPorDia[dateKey(d)];
    if (ponto) {
      const batidas = batidasOrdenadas(ponto);
      const trabalhouAlgo = (ponto.minutoNormalDiurno || 0) + (ponto.minutoNormalNoturno || 0) > 0 || batidas.length > 0;
      if (trabalhouAlgo && batidas.length < 4) return true;
    }
    d.setDate(d.getDate() + 1);
  }
  return false;
}

function renderFlexibilizacaoFromCache(start, end, tetoMin) {
  $("#tetoAbonoMes").textContent = minutesToHHMM(tetoMin);

  const saldoEl = $("#saldoHoras");
  const { faltanteTotal: usadoMin, extraTotal: extraMin } = saldoLocalNoPeriodo(start, end);
  saldoEl.textContent = minutesToHHMM(usadoMin);

  // Abono estimado = soma de 48min por dia útil já decorrido no período
  // (do início até hoje, ou até o fim se o período já fechou), limitado ao
  // teto do período inteiro.
  const hojeMeiaNoite = new Date();
  hojeMeiaNoite.setHours(0, 0, 0, 0);
  const fimDecorrido = hojeMeiaNoite < end ? hojeMeiaNoite : end;
  const diasUteisDecorridos = fimDecorrido < start ? 0 : countBusinessDays(start, fimDecorrido);
  const abonoMin = Math.min(diasUteisDecorridos * MINUTOS_ABONO_POR_DIA_UTIL, tetoMin);
  $("#abonoEstimado").textContent = minutesToHHMM(abonoMin);

  saldoEl.classList.remove("status-green", "status-yellow", "status-red");
  if (!jornada6hAtivo) {
    saldoEl.classList.add(usadoMin < abonoMin ? "status-green" : usadoMin === abonoMin ? "status-yellow" : "status-red");
  }

  let avisoSaldo;
  let explicacaoSaldo;
  if (jornada6hAtivo) {
    explicacaoSaldo = "Jornada de 6h/dia não tem abono nem teto de flexibilização — este é só quanto você já ficou devendo, calculado com base nas suas batidas.";
    avisoSaldo = "Não se aplica à sua jornada.";
  } else {
    explicacaoSaldo = "Cálculo de quantas horas você já utilizou do abono, com base nas suas batidas anotadas na extensão.";
    if (usadoMin > abonoMin) {
      if (periodoTemAjustePendente(start, end)) {
        avisoSaldo = "Parece que tem ajustes pendentes, verifique com seu gestor.";
      } else if (periodoTemDiaComPoucasBatidas(start, end)) {
        avisoSaldo = "Verifique suas horas, você tem inconsistências.";
      } else {
        avisoSaldo = "Parece que suas horas estão abaixo do esperado, acho que você tem problemas.";
      }
    } else if (extraMin > 0) {
      avisoSaldo = "Você tem saldo de horas positivas.";
    } else {
      avisoSaldo = "Suas horas estão dentro do esperado.";
    }
  }
  $("#saldoHorasBox").dataset.tooltip = `${avisoSaldo}\n\n${explicacaoSaldo}`;
}

// Meta de minutos esperada num dia, só com dados locais: dia útil (sem
// feriado nacional) e sem estar marcado como férias/folga/abono na
// extensão. Não usa o que o Icarus decidiu que era a meta do dia.
function metaLocalDoDia(key, holidays) {
  if (feriasFolgaParaDia(key)) return 0;
  if (!isBusinessDay(keyToDate(key), holidays)) return 0;
  return jornada6hAtivo ? JORNADA_6H_MIN : DEFAULT_JORNADA_MIN;
}

// Minutos efetivamente trabalhados num dia, somando só os pares
// entrada/saída das batidas reais + ajustes pendentes anotados na
// extensão — não usa nenhum total pronto do Icarus, que pode estar
// defasado enquanto um ajuste ainda aguarda aprovação do gestor.
function minutosTrabalhadosLocalNoDia(key) {
  const ponto = registrosPorDia[key];
  const diaPending = pendingAdjustments[key] || [];
  // "done" (não-delete) significa que o Icarus já tem batida real cobrindo
  // esse horário informado (reconcilePendingAdjustments em background.js) —
  // incluir o horário aproximado de novo aqui duplicaria a batida real já
  // presente em `ordenadas`, bagunçando o pareamento entrada/saída.
  const diaPendingMissing = diaPending.filter((p) => p.type !== "delete" && !p.done);
  const diaPendingDelete = diaPending.filter((p) => p.type === "delete");
  const ordenadas = batidasOrdenadas(ponto).filter((b) => !diaPendingDelete.some((p) => p.horarioMs === b.horario));
  const merged = mergedPunchesForDay(key, ordenadas, diaPendingMissing).map((item) => item.timeMs);
  let worked = 0;
  for (let i = 0; i + 1 < merged.length; i += 2) worked += (merged[i + 1] - merged[i]) / 60000;
  return worked;
}

// Abono do período (card "Abono") = soma das horas faltantes de cada dia já
// fechado (até ontem — hoje ainda em andamento ficaria artificialmente
// negativo), tudo calculado com base nas batidas anotadas na extensão.
// Também soma à parte as horas extras (dias que passaram da meta), só pra
// avisar quando há saldo positivo acumulado — não abate do abono devido.
function saldoLocalNoPeriodo(start, end) {
  const hojeMeiaNoite = new Date();
  hojeMeiaNoite.setHours(0, 0, 0, 0);
  const ontem = new Date(hojeMeiaNoite);
  ontem.setDate(ontem.getDate() - 1);
  const fimFechado = ontem < end ? ontem : end;
  if (fimFechado < start) return { faltanteTotal: 0, extraTotal: 0 };

  const holidays = new Set();
  for (let y = start.getFullYear(); y <= fimFechado.getFullYear(); y++) nationalHolidaySet(y).forEach((k) => holidays.add(k));

  let faltanteTotal = 0;
  let extraTotal = 0;
  const d = new Date(start);
  while (d <= fimFechado) {
    const key = dateKey(d);
    // Sem nenhuma batida (real ou anotada) pro dia, não dá pra saber se
    // faltou ou não — não conta como falta só por falta de dado em cache
    // (ex: mês ainda não sincronizado), senão qualquer dia sem sync vira
    // um dia inteiro de "abono usado" por engano.
    if (registrosPorDia[key] || (pendingAdjustments[key] || []).length > 0) {
      const meta = metaLocalDoDia(key, holidays);
      if (meta > 0) {
        const trabalhado = minutosTrabalhadosLocalNoDia(key);
        faltanteTotal += Math.max(0, meta - trabalhado);
        extraTotal += Math.max(0, trabalhado - meta);
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return { faltanteTotal, extraTotal };
}

// Mostra período/teto/valores na hora com o que já tiver em cache — sem
// esperar rede, mesmo padrão do resto do painel (nunca abre vazio).
// Acompanha o mês em exibição no calendário (currentMonth/currentYear), não
// sempre "hoje" — dia 1 do mês é sempre < 26, então o período resultante é
// "dia 26 do mês anterior ao dia 25 do mês em exibição" (convenção usual de
// rotular o período de apuração pelo mês em que ele fecha).
function showFlexibilizacaoInstant() {
  const { start, end } = apuracaoPeriodFor(new Date(currentYear, currentMonth, 1));
  const diasUteis = countBusinessDays(start, end);
  const tetoMin = jornada6hAtivo ? 0 : diasUteis * MINUTOS_ABONO_POR_DIA_UTIL;
  const fmtDDMM = (d) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  $("#periodoRange").textContent = `${fmtDDMM(start)} – ${fmtDDMM(end)} · ${diasUteis} dias úteis`;
  renderFlexibilizacaoFromCache(start, end, tetoMin);
  return { start, end, tetoMin };
}

async function fetchFlexibilizacao() {
  const { start, end, tetoMin } = showFlexibilizacaoInstant();
  try {
    await IcarusAPI.searchPeriod(start, end);
    await new Promise((r) => setTimeout(r, 1200));
    const { data } = await IcarusAPI.getLastRegistros();
    if (data) ingestRegistros(data);
  } catch (err) {
    return; // já mostrou o que tinha em cache, não tem mais nada a fazer
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
function showUpdateNotice(latest, url) {
  showNotificationRow("update", { text: `Nova versão disponível (v${latest})`, href: url, type: "update", closable: true, anchor: "#settingsBtn" });
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
      showUpdateNotice(latest, release.html_url);
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
    if (nome) $("#appTitle").textContent = nome;
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
    const isSelected = selectedDayKey ? key === selectedDayKey : key === todayKey;
    const cell = document.createElement("div");
    cell.className = `day${cls ? " " + cls : ""}${key === todayKey ? " today" : ""}${isSelected ? " selected" : ""}${hasPending ? " has-pending" : ""}`;
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
  document.querySelectorAll(".punch").forEach((el) => {
    const seq = Number(el.dataset.seq);
    const item = merged[seq - 1];
    const valueEl = el.querySelector(".value");
    el.classList.remove("manual", "pending", "fillable", "deletable", "predicted");
    el.onclick = null;
    if (item?.real) {
      const b = item.real;
      valueEl.textContent = b.horarioFormatadoSemData || "--:--";
      el.classList.toggle("manual", isBatidaManual(b));
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
    // "já ajustei no Icarus" — marca só localmente (mesma ideia do check de
    // exclusão pendente). Se a busca seguinte já mostrar o Icarus cobrindo
    // esse horário, reconcilePendingAdjustments (background.js) marca
    // sozinho, sem precisar você clicar.
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

  // contadores: hoje é ao vivo (atualiza sozinho); outro dia é estático (Icarus)
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (isToday) {
    tickLive();
    liveTimer = setInterval(tickLive, 30000);
  } else {
    // Ignora ajustes já marcados "done" (Icarus já tem batida real cobrindo
    // o horário informado) — senão duplicaria essa batida no total.
    const diaPendingComHorarioSel = diaPendingMissing.filter((p) => p.approxTime && !p.done);
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
  $("#feriasFolgasSave").addEventListener("click", saveFeriasFolgasModal);

  $("#confirmModalCancel").addEventListener("click", () => closeConfirm(false));
  $("#confirmModalOk").addEventListener("click", () => closeConfirm(true));

  document.addEventListener("icarus:observed", (ev) => {
    const { url, data } = ev.detail || {};
    if (url && url.includes("/ponto/consultarRegistrosPonto") && data) ingestRegistros(data);
  });
  document.addEventListener("icarus:pendingAdjustmentsChanged", loadPendingAdjustments);

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
