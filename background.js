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

// Horários fixos de lembrete e o que cada um representa (n-ésima batida
// esperada do dia). Se a pessoa já bateu esse ponto antes do horário —
// por exemplo, voltou do almoço às 12:30 (mínimo de 30min já é aceitável)
// — o lembrete correspondente simplesmente não aparece, porque checamos
// "já tem N batidas?" e não "é exatamente esse horário?".
const PUNCH_SCHEDULE = [
  { seq: 1, hh: 8, mm: 0, label: "1ª entrada" },
  { seq: 2, hh: 12, mm: 0, label: "1ª saída (almoço)" },
  { seq: 3, hh: 13, mm: 0, label: "volta do almoço" },
  { seq: 4, hh: 17, mm: 0, label: "saída" },
];

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

function scheduleAllAlarms() {
  PUNCH_SCHEDULE.forEach(({ seq, hh, mm }) => {
    chrome.alarms.create(`punchReminder_${seq}`, {
      when: nextOccurrence(hh, mm),
      periodInMinutes: 24 * 60,
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  const m = /^punchReminder_(\d)$/.exec(alarm.name);
  if (!m) return;
  const seq = Number(m[1]);
  const entry = PUNCH_SCHEDULE.find((p) => p.seq === seq);
  if (entry) checkAndNotify(entry);
});

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
    const filtered = pending[key].filter((entry) => entry.seq > punchCount);
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
