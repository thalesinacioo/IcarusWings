/**
 * background.js — service worker
 * Roteia mensagens entre o content script (aba do Icarus) e o side panel,
 * guarda um pequeno estado local (idColaborador aprendido, última lista de
 * registros observada) e cuida dos lembretes de bater ponto (alarmes +
 * notificações). Nada de credenciais é lido ou armazenado aqui.
 */

const MSG_NS = "__pontoIcarusExt__";
const ICARUS_URL_PATTERN = "https://web.pontoicarus.com.br/*";
const CONSULTAR_REGISTROS_PATH = "/ponto/consultarRegistrosPonto";
const TURNO_PATH = "/colaboradorTurno/buscarTurnoVinculadoColaborador";

// Rótulos das 4 batidas esperadas do dia (mesma numeração do painel). Só a
// 1ª tem horário fixo de checagem (7:30, recorrente) — as outras 3 são
// avisadas dinamicamente, 10min e 5min antes do horário PREVISTO do dia
// (ver "previsão dos horários restantes" abaixo), porque a pessoa pode
// entrar/sair em horários flexíveis, não só às 12h/13h/17h.
const PUNCH_SCHEDULE = [
  { seq: 1, hh: 7, mm: 30, label: "1ª entrada" },
  { seq: 2, hh: 12, mm: 0, label: "1ª saída (almoço)" },
  { seq: 3, hh: 13, mm: 0, label: "volta do almoço" },
  { seq: 4, hh: 17, mm: 0, label: "saída" },
];

// ---------- previsão dos horários restantes do dia ----------
// Mesma regra do sidepanel.js (renderFlexibilizacaoFromCache / tickLive):
// jornada padrão 8:48 menos o abono do período corrente, dividida em duas
// metades com o mínimo de 30min de almoço no meio. Duplicado aqui (em vez
// de compartilhado via módulo) porque o service worker roda isolado do
// painel — se a regra do RH mudar, atualize os dois lugares.
const JORNADA_PADRAO_MIN = 8 * 60 + 48; // 8:48
const MIN_ALMOCO_MIN = 30;
const MINUTOS_ABONO_POR_DIA_UTIL = 48;

function easterDate(year) {
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
    new Date(year, 0, 1),
    addDays(easter, -48),
    addDays(easter, -47),
    addDays(easter, -2),
    addDays(easter, 60),
    new Date(year, 3, 21),
    new Date(year, 4, 1),
    new Date(year, 8, 7),
    new Date(year, 9, 12),
    new Date(year, 10, 2),
    new Date(year, 10, 15),
    new Date(year, 10, 20),
    new Date(year, 11, 25),
  ].map((d) => dateKeyOf(d));
}

function isBusinessDay(date, holidaysOfYear) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  const holidays = holidaysOfYear || new Set(nationalHolidaySet(date.getFullYear()));
  return !holidays.has(dateKeyOf(date));
}

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

// Best-effort: só enxerga o abono dos dias que o painel já buscou nesta
// sessão (cachedRegistrosPorDia, escrito pelo sidepanel.js). Se o período
// nunca foi consultado, abono sai 0 — subestima a previsão, não superestima.
// Só conta dias FECHADOS (até ontem): incluir hoje inflaria o saldo negativo
// enquanto o dia ainda está em andamento (minutoFaltante de hoje aparece
// quase inteiro com só 1-2 batidas), zerando a meta prevista.
// O abono é um saldo do PERÍODO inteiro (pode acumular vários dias), mas só
// é permitido USAR até MINUTOS_ABONO_POR_DIA_UTIL (48min) por dia — por
// isso o retorno é limitado a esse teto diário, não ao saldo do período.
async function abonoMinForTodayBg() {
  const { cachedRegistrosPorDia = {} } = await chrome.storage.local.get("cachedRegistrosPorDia");
  const { start, end: periodEnd } = apuracaoPeriodFor(new Date());
  const tetoMin = countBusinessDays(start, periodEnd) * MINUTOS_ABONO_POR_DIA_UTIL;
  const ontem = new Date();
  ontem.setDate(ontem.getDate() - 1);
  if (ontem < start) return 0;
  const end = ontem < periodEnd ? ontem : periodEnd;
  let saldoTotal = 0;
  const d = new Date(start);
  while (d <= end) {
    const ponto = cachedRegistrosPorDia[dateKeyOf(d)];
    if (ponto) {
      const extra = (ponto.minutoExtraTP1 || 0) + (ponto.minutoExtraTP2 || 0) + (ponto.minutoExtraTP3 || 0);
      saldoTotal += extra - (ponto.minutoFaltante || 0);
    }
    d.setDate(d.getDate() + 1);
  }
  const abonoPeriodo = saldoTotal < 0 ? Math.min(-saldoTotal, tetoMin) : 0;
  return Math.min(abonoPeriodo, MINUTOS_ABONO_POR_DIA_UTIL);
}

async function getTodayPonto() {
  const { lastRegistros } = await chrome.storage.local.get("lastRegistros");
  const todayKey = dateKeyOf(new Date());
  return (lastRegistros?.pontos || []).find((p) => dateKeyOf(new Date(p.dataBatida)) === todayKey);
}

async function getTodayPunchTimesMs() {
  const ponto = await getTodayPonto();
  return (ponto?.pontosHorariosBatidasOrdenados || [])
    .map((b) => (typeof b.horario === "number" ? b.horario : new Date(b.horario).getTime()))
    .sort((a, b) => a - b);
}

// Horários previstos (ms) das batidas que ainda faltam, por seq — null se
// ainda não bateu a 1ª (nada a prever) ou já bateu as 4 (nada mais a prever).
async function computePredictedPunchTimes() {
  const times = await getTodayPunchTimesMs();
  if (times.length === 0 || times.length >= 4) return null;

  if (times.length === 3) {
    // 4ª batida: usa o "falta trabalhar" do próprio Icarus (já reflete
    // ajuste/abono real do dia, mais preciso que a nossa estimativa).
    const ponto = await getTodayPonto();
    const remainingMin = ponto?.minutoFaltante || 0;
    return { 4: Date.now() + remainingMin * 60000 };
  }

  const abonoMin = await abonoMinForTodayBg();
  const metaMin = Math.max(0, JORNADA_PADRAO_MIN - abonoMin);
  const metadeMin = metaMin / 2;

  if (times.length === 1) {
    const saida1 = times[0] + metadeMin * 60000;
    const entrada2 = saida1 + MIN_ALMOCO_MIN * 60000;
    const saida2 = entrada2 + metadeMin * 60000;
    return { 2: saida1, 3: entrada2, 4: saida2 };
  }

  // times.length === 2
  const manhaMin = (times[1] - times[0]) / 60000;
  const restanteMin = Math.max(0, metaMin - manhaMin);
  const entrada2 = times[1] + MIN_ALMOCO_MIN * 60000;
  const saida2 = entrada2 + restanteMin * 60000;
  return { 3: entrada2, 4: saida2 };
}

// Recria os alarmes de "10min antes" / "5min antes" pras batidas 2/3/4 a
// partir da previsão atual. Chamado sempre que chega um novo registro do
// Icarus (a previsão muda a cada batida real) — chrome.alarms.create com
// nome existente substitui, então não precisa limpar antes de recriar.
async function scheduleDynamicPunchReminders() {
  const predicted = await computePredictedPunchTimes();
  const now = Date.now();
  for (const seq of [2, 3, 4]) {
    const name10 = `punchPred_${seq}_10`;
    const name5 = `punchPred_${seq}_5`;
    const when = predicted?.[seq];
    if (!when) {
      await chrome.alarms.clear(name10);
      await chrome.alarms.clear(name5);
      continue;
    }
    const t10 = when - 10 * 60000;
    const t5 = when - 5 * 60000;
    if (t10 > now) chrome.alarms.create(name10, { when: t10 });
    else await chrome.alarms.clear(name10);
    if (t5 > now) chrome.alarms.create(name5, { when: t5 });
    else await chrome.alarms.clear(name5);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  scheduleAllAlarms();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAllAlarms();
});

// ---------- alarmes (agendamento diário) ----------

function nextOccurrence(hh, mm) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// BUG corrigido: isso recriava os 4 alarmes do zero toda vez que rodava —
// e onInstalled dispara em TODO "recarregar" da extensão em chrome://extensions,
// não só na instalação. chrome.alarms.create com um nome que já existe
// SUBSTITUI o alarme, recalculando "próxima ocorrência a partir de agora".
// Resultado prático: cada reload durante o dia empurrava pra amanhã
// qualquer lembrete cujo horário já tivesse passado — inclusive os de
// horários ainda não disparados, se o reload acontecesse um instante
// depois do horário previsto. Por isso os lembretes pareciam nunca disparar.
// Agora só cria o alarme se ele ainda não existir.
async function scheduleAllAlarms() {
  // 1ª entrada: único horário fixo, mas recorrente a cada 15min (não uma
  // vez por dia) — assim, se ela ainda não bateu, o lembrete continua
  // reaparecendo/permanecendo na tela (requireInteraction) até bater.
  const name1 = "punchReminder_1";
  const existing1 = await chrome.alarms.get(name1);
  if (!existing1) {
    chrome.alarms.create(name1, { when: nextOccurrence(7, 30), periodInMinutes: 15 });
  }
  await scheduleDynamicPunchReminders();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "punchReminder_1") {
    checkAndNotify(PUNCH_SCHEDULE[0]);
    return;
  }
  const p = /^punchPred_(\d)_(10|5)$/.exec(alarm.name);
  if (p) notifyUpcomingPunch(Number(p[1]), Number(p[2]));
});

// Aviso "faltam N minutos" pras batidas 2/3/4, no horário previsto — some
// sozinho (não é requireInteraction, é só um heads-up).
async function notifyUpcomingPunch(seq, minutesBefore) {
  const times = await getTodayPunchTimesMs();
  if (times.length >= seq) return; // já bateu, nada a avisar

  const todayKey = dateKeyOf(new Date());
  const pending = await getPendingAdjustments();
  if ((pending[todayKey] || []).some((p) => p.seq === seq)) return; // já marcou "ajustar depois"

  const entry = PUNCH_SCHEDULE.find((p) => p.seq === seq);
  const label = entry?.label || `${seq}ª batida`;
  chrome.notifications.create(`punchPred_${todayKey}_${seq}_${minutesBefore}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Hora de bater o ponto se aproximando",
    message: `Faltam ${minutesBefore}min pro horário previsto de: ${label}.`,
    priority: 1,
  });
}

// ---------- checagem + notificação ----------

async function findIcarusTabId() {
  const tabs = await chrome.tabs.query({ url: ICARUS_URL_PATTERN });
  return tabs[0]?.id ?? null;
}

function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("A aba do Icarus demorou demais pra carregar."));
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Abre a aba do Icarus sozinha, em segundo plano (sem tirar o foco da aba
// atual do usuário), se nenhuma já estiver aberta. É a única forma de ter
// um contexto autenticado disponível sem pedir/ler suas credenciais — o
// próprio Icarus cuida do login usando a sessão que já existe no Chrome.
async function ensureIcarusTab() {
  const existing = await findIcarusTabId();
  if (existing) return existing;
  const tab = await chrome.tabs.create({
    url: "https://web.pontoicarus.com.br/ponto",
    active: false,
    pinned: true,
  });
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 1500));
  return tab.id;
}

function forwardToSidepanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// Reinjeta os content scripts numa aba que já estava aberta antes da
// extensão ser carregada/atualizada.
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["inject.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-bridge.js"] });
    return true;
  } catch (err) {
    console.warn("Falha ao reinjetar content scripts:", err);
    return false;
  }
}

async function sendToTab(msg) {
  let tabId;
  try {
    tabId = await ensureIcarusTab();
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return { ok: true };
  } catch (_) {
    // provavelmente a aba já estava aberta antes da extensão carregar
  }
  const injected = await ensureInjected(tabId);
  if (!injected) {
    return { ok: false, error: "Não consegui me conectar à aba do Icarus. Recarregue a aba (F5) e tente de novo." };
  }
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Ainda não consegui me conectar à aba do Icarus. Recarregue a aba (F5) e tente de novo." };
  }
}

const pad2 = (n) => String(n).padStart(2, "0");
const dateKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtDDMMYYYY = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;

async function getPendingAdjustments() {
  const { pendingAdjustments = {} } = await chrome.storage.local.get("pendingAdjustments");
  return pendingAdjustments;
}
async function setPendingAdjustments(next) {
  await chrome.storage.local.set({ pendingAdjustments: next });
}

// Dispara uma busca de verdade na aba do Icarus (silenciosa, sem o painel
// aberto) e aguarda a resposta chegar em chrome.storage.local.lastRegistros.
async function refreshTodayAndGetPunchCount() {
  const today = new Date();
  const requestId = `bg_${Date.now()}`;
  await sendToTab({
    source: MSG_NS,
    type: "UI_ACTION",
    payload: { requestId, action: "search", params: { dataInicioDDMMYYYY: fmtDDMMYYYY(today), dataFimDDMMYYYY: fmtDDMMYYYY(today) } },
  });
  await new Promise((r) => setTimeout(r, 2500));
  const { lastRegistros } = await chrome.storage.local.get("lastRegistros");
  const key = dateKeyOf(today);
  const ponto = (lastRegistros?.pontos || []).find((p) => dateKeyOf(new Date(p.dataBatida)) === key);
  return (ponto?.pontosHorariosBatidasOrdenados || []).length;
}

async function checkAndNotify({ seq, label }) {
  let punchCount = 0;
  try {
    punchCount = await refreshTodayAndGetPunchCount();
  } catch (err) {
    console.warn("Falha ao atualizar antes do lembrete:", err);
  }
  if (punchCount >= seq) return; // já bateu esse ponto, nada a lembrar

  const todayKey = dateKeyOf(new Date());
  const pending = await getPendingAdjustments();
  const todaysPending = pending[todayKey] || [];
  if (todaysPending.some((p) => p.seq === seq)) return; // já marcou "ajustar depois" pra essa batida

  const notifId = `punch_${todayKey}_${seq}`;
  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Hora de bater o ponto",
    message: `Falta registrar: ${label}.`,
    requireInteraction: true, // fica na tela até a pessoa interagir
    buttons: [{ title: "Ajustar depois" }],
    priority: 2,
  });
}

chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  const m = /^punch_(\d{4}-\d{2}-\d{2})_(\d)$/.exec(notifId);
  if (!m || buttonIndex !== 0) return;
  const [, dateKey, seqStr] = m;
  const seq = Number(seqStr);
  const entry = PUNCH_SCHEDULE.find((p) => p.seq === seq);

  const pending = await getPendingAdjustments();
  const todays = pending[dateKey] || [];
  if (!todays.some((p) => p.seq === seq)) {
    todays.push({ seq, label: entry?.label || `${seq}ª batida`, clickedAt: Date.now() });
  }
  await setPendingAdjustments({ ...pending, [dateKey]: todays });
  chrome.notifications.clear(notifId);
});

chrome.notifications.onClicked.addListener((notifId) => {
  if (!/^punch_/.test(notifId)) return;
  chrome.notifications.clear(notifId);
  chrome.tabs.query({}, (tabs) => {
    const win = tabs[0]?.windowId;
    if (win != null) chrome.sidePanel.open({ windowId: win }).catch(() => {});
  });
});

// Remove entradas de "ajustar depois" que já foram resolvidas de verdade
// (o dia passou a ter batidas reais suficientes pra cobrir aquele seq —
// seja porque a pessoa bateu, seja porque um ajuste foi aprovado no Icarus).
async function reconcilePendingAdjustments(registrosData) {
  if (!registrosData?.pontos?.length) return;
  const pending = await getPendingAdjustments();
  let changed = false;
  for (const p of registrosData.pontos) {
    const key = dateKeyOf(new Date(p.dataBatida));
    if (!pending[key]) continue;
    const punchCount = (p.pontosHorariosBatidasOrdenados || []).length;
    const horariosReais = new Set((p.pontosHorariosBatidasOrdenados || []).map((b) => b.horario));
    // "delete" nunca reconcilia por contagem (a batida já existe, então
    // punchCount>=seq seria sempre verdade e apagaria o lembrete na hora).
    // Só some quando o horário exato dela some de vez do Icarus — sinal de
    // que o gestor aprovou a exclusão de verdade — não quando a pessoa
    // marca o checkbox (isso só risca o texto, ver setPendingDeletionDone).
    const filtered = pending[key].filter((entry) =>
      entry.type === "delete" ? horariosReais.has(entry.horarioMs) : entry.seq > punchCount
    );
    if (filtered.length !== pending[key].length) {
      changed = true;
      if (filtered.length) pending[key] = filtered;
      else delete pending[key];
    }
  }
  if (changed) await setPendingAdjustments(pending);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== MSG_NS) return;

  if (msg.type === "OBSERVED_RESPONSE") {
    const { url, idColaborador } = msg.payload || {};
    if (idColaborador) chrome.storage.local.set({ idColaborador });

    if (url && url.includes(CONSULTAR_REGISTROS_PATH) && msg.payload.data) {
      chrome.storage.local.set({ lastRegistros: msg.payload.data, lastRegistrosAt: Date.now() });
      reconcilePendingAdjustments(msg.payload.data);
      scheduleDynamicPunchReminders();
    }
    if (url && url.includes(TURNO_PATH) && msg.payload.data) {
      chrome.storage.local.set({ lastTurno: msg.payload.data, lastTurnoAt: Date.now() });
    }

    chrome.storage.local.get({ endpointLog: [] }, ({ endpointLog }) => {
      const entry = { url, method: msg.payload.method, status: msg.payload.status, ts: Date.now() };
      chrome.storage.local.set({ endpointLog: [entry, ...endpointLog].slice(0, 50) });
    });

    forwardToSidepanel(msg);
    return;
  }

  if (msg.type === "UI_ACTION_RESULT") {
    forwardToSidepanel(msg);
    return;
  }

  if (msg.type === "UI_ACTION") {
    // veio do side panel: repassa pra aba real do Icarus executar
    sendToTab(msg).then((res) => {
      if (!res.ok) {
        forwardToSidepanel({
          source: MSG_NS,
          type: "UI_ACTION_RESULT",
          payload: { requestId: msg.payload.requestId, ok: false, error: res.error },
        });
      }
    });
    return;
  }
});
