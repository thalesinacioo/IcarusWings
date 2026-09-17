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
// Dispara sozinho sempre que a página "Registro de Ponto" carrega (ao
// contrário de TURNO_PATH, que só dispara se a pessoa clicar "Detalhar") —
// é a fonte confiável do nome do colaborador (pessoa.nome).
const MUTUARIO_PATH = "/mutuario/";

// Pedidos de UI_ACTION disparados pelo próprio background (lembrete de
// ponto) aguardando o UI_ACTION_RESULT correspondente — mesmo padrão do
// __pending de api.js, só que do lado do service worker.
const __bgPending = new Map();

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
// A meta de hoje é sempre fixa — 8:00, ou 8:48 com "8:48 hoje" marcado no
// painel — nunca depende do que o Icarus calculou pro dia (ver
// computePredictedPunchTimes abaixo). Duplicado aqui (em vez de
// compartilhado via módulo) porque o service worker roda isolado do painel.
const DEFAULT_JORNADA_MIN = 8 * 60; // 8:00
const JORNADA_PADRAO_MIN = 8 * 60 + 48; // 8:48

// Intervalo de almoço configurável (checkbox no painel) — 30min por padrão.
// Igual à leitura em api.js (getAlmocoMinConfig), duplicada aqui porque o
// service worker roda isolado do painel.
async function getAlmocoMinConfig() {
  const { almocoMinConfig } = await chrome.storage.local.get({ almocoMinConfig: 30 });
  return almocoMinConfig;
}

// "8:48 hoje" (checkbox no painel) — igual à leitura em api.js
// (getJornada848Config), duplicada aqui pelo mesmo motivo acima.
async function getJornada848Config() {
  const { jornada848Config } = await chrome.storage.local.get({ jornada848Config: false });
  return jornada848Config;
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

  // Meta de hoje é sempre fixa (8:00, ou 8:48 com "8:48 hoje" marcado) —
  // nunca depende do que o Icarus calculou pro dia, pra ficar previsível
  // (mesma regra do sidepanel.js).
  const [jornada848, almocoMin] = await Promise.all([getJornada848Config(), getAlmocoMinConfig()]);
  const metaMin = jornada848 ? JORNADA_PADRAO_MIN : DEFAULT_JORNADA_MIN;

  if (times.length === 3) {
    const ponto = await getTodayPonto();
    const trabalhadoFechado = ponto
      ? (ponto.minutoNormalDiurno || 0) + (ponto.minutoNormalNoturno || 0) +
        (ponto.minutoExtraTP1 || 0) + (ponto.minutoExtraTP2 || 0) + (ponto.minutoExtraTP3 || 0)
      : 0;
    // 3 batidas = turno em aberto desde a última — soma o tempo já corrido
    // dela, senão a previsão ignora o que já foi trabalhado desde então.
    const decorridoAbertoMin = (Date.now() - times[2]) / 60000;
    const remainingMin = Math.max(0, metaMin - trabalhadoFechado - decorridoAbertoMin);
    return { 4: Date.now() + remainingMin * 60000 };
  }

  const metadeMin = metaMin / 2;

  if (times.length === 1) {
    const saida1 = times[0] + metadeMin * 60000;
    const entrada2 = saida1 + almocoMin * 60000;
    const saida2 = entrada2 + metadeMin * 60000;
    return { 2: saida1, 3: entrada2, 4: saida2 };
  }

  // times.length === 2
  const manhaMin = (times[1] - times[0]) / 60000;
  const restanteMin = Math.max(0, metaMin - manhaMin);
  const entrada2 = times[1] + almocoMin * 60000;
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

// Mudou o intervalo de almoço ou o "8:48 hoje" no painel (checkbox) —
// recalcula os lembretes 10min/5min na hora, sem esperar a próxima batida real.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.almocoMinConfig || changes.jornada848Config)) scheduleDynamicPunchReminders();
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

// Espera o UI_ACTION_RESULT do pedido `requestId` (resolvido pelo listener
// de UI_ACTION_RESULT lá embaixo) — mesmo padrão do __pending de api.js,
// só que do lado do background. Nunca rejeita: se der erro ou estourar o
// timeout, resolve com ok:false pra quem chamou decidir o que fazer.
function waitForActionResult(requestId, timeout = 6000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      __bgPending.delete(requestId);
      resolve({ ok: false, error: "timeout" });
    }, timeout);
    __bgPending.set(requestId, {
      resolve: (result) => { clearTimeout(timer); resolve({ ok: true, result }); },
      reject: (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err?.message || err) }); },
    });
  });
}

// O UI_ACTION_RESULT só confirma que a busca foi CLICADA com sucesso — a
// resposta de rede que realmente atualiza lastRegistros chega em paralelo,
// via o hook de fetch/XHR do inject.js (OBSERVED_RESPONSE), não nessa mesma
// mensagem. Por isso espera lastRegistrosAt avançar de verdade, em vez de
// confiar num sleep de duração fixa.
async function waitForFreshRegistros(sinceMs, timeout = 4000, interval = 200) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { lastRegistrosAt } = await chrome.storage.local.get("lastRegistrosAt");
    if (lastRegistrosAt && lastRegistrosAt >= sinceMs) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

// Dispara uma busca de verdade na aba do Icarus (silenciosa, sem o painel
// aberto) e aguarda a resposta chegar em chrome.storage.local.lastRegistros.
// Retorna null (em vez de arriscar um número desatualizado) sempre que não
// dá pra confirmar que a busca realmente rodou e atualizou o cache — por
// exemplo se a aba do Icarus estava aberta em outra tela, sem os campos de
// período esperados (BUG corrigido: antes, qualquer falha aqui era ignorada
// e a função caía direto pra ler lastRegistros como estava, por mais velho
// que fosse — é por isso que o lembrete de "falta bater ponto" continuava
// aparecendo mesmo depois da pessoa já ter batido direto no site).
async function refreshTodayAndGetPunchCount() {
  const today = new Date();
  const requestId = `bg_${Date.now()}`;
  const sentAt = Date.now();

  const resultPromise = waitForActionResult(requestId);
  const sent = await sendToTab({
    source: MSG_NS,
    type: "UI_ACTION",
    payload: { requestId, action: "search", params: { dataInicioDDMMYYYY: fmtDDMMYYYY(today), dataFimDDMMYYYY: fmtDDMMYYYY(today) } },
  });
  if (!sent.ok) {
    __bgPending.delete(requestId);
    return null;
  }

  const actionResult = await resultPromise;
  if (!actionResult.ok) return null;

  const fresh = await waitForFreshRegistros(sentAt);
  if (!fresh) return null;

  const { lastRegistros } = await chrome.storage.local.get("lastRegistros");
  const key = dateKeyOf(today);
  const ponto = (lastRegistros?.pontos || []).find((p) => dateKeyOf(new Date(p.dataBatida)) === key);
  return (ponto?.pontosHorariosBatidasOrdenados || []).length;
}

async function checkAndNotify({ seq, label }) {
  let punchCount = null;
  try {
    punchCount = await refreshTodayAndGetPunchCount();
  } catch (err) {
    console.warn("Falha ao atualizar antes do lembrete:", err);
  }
  // Sem confirmação de dado fresco, não arrisca notificar com base em cache
  // velho — melhor pular esse ciclo (o alarme roda de novo em 15min) do que
  // avisar "falta bater ponto" pra quem já bateu.
  if (punchCount === null) {
    console.warn(`Lembrete de "${label}" pulado: não consegui confirmar o estado atual do dia.`);
    return;
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
    const horariosReais = new Set((p.pontosHorariosBatidasOrdenados || []).map((b) => b.horario));
    // BUG corrigido: usava o total bruto de batidas reais do Icarus pra
    // decidir se um horário aproximado informado (não-delete) já estava
    // "coberto" — mas isso ignora batidas marcadas localmente como pendente
    // de exclusão, que ainda contam nesse total (o Icarus só some com elas
    // quando o gestor aprova de verdade). Resultado: informar um horário
    // aproximado pra um slot esvaziado por uma exclusão pendente apagava
    // esse mesmo horário na hora, porque punchCount (bruto) já cobria o seq.
    // Agora desconta as exclusões pendentes ainda presentes no Icarus, pra
    // contar só as batidas que a pessoa realmente vê no cartão.
    const pendingDeleteAindaReais = pending[key].filter((e) => e.type === "delete" && horariosReais.has(e.horarioMs)).length;
    const punchCountVisivel = (p.pontosHorariosBatidasOrdenados || []).length - pendingDeleteAindaReais;
    // "delete" nunca reconcilia por contagem (a batida já existe, então
    // punchCount>=seq seria sempre verdade e apagaria o lembrete na hora).
    // Só some quando o horário exato dela some de vez do Icarus — sinal de
    // que o gestor aprovou a exclusão de verdade — não quando a pessoa
    // marca o checkbox (isso só risca o texto, ver setPendingDeletionDone).
    // "delete" some da lista quando o horário aprova de verdade (acima). Já
    // o horário informado manualmente (não-delete) nunca some sozinho — só
    // marca "done" (mesmo checkbox que a pessoa também pode marcar na mão)
    // assim que o Icarus passa a ter batidas suficientes cobrindo o slot;
    // fica registrado na lista, riscado, até ela mesma cancelar/remover.
    const filtered = pending[key].filter((entry) => entry.type === "delete" ? horariosReais.has(entry.horarioMs) : true);
    if (filtered.length !== pending[key].length) {
      changed = true;
    }
    for (const entry of filtered) {
      if (entry.type !== "delete" && entry.seq <= punchCountVisivel && !entry.done) {
        entry.done = true;
        changed = true;
      }
    }
    if (filtered.length) pending[key] = filtered;
    else delete pending[key];
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
    if (url && url.includes(MUTUARIO_PATH) && msg.payload.data) {
      chrome.storage.local.set({ lastMutuario: msg.payload.data, lastMutuarioAt: Date.now() });
    }

    chrome.storage.local.get({ endpointLog: [] }, ({ endpointLog }) => {
      const entry = { url, method: msg.payload.method, status: msg.payload.status, ts: Date.now() };
      chrome.storage.local.set({ endpointLog: [entry, ...endpointLog].slice(0, 50) });
    });

    forwardToSidepanel(msg);
    return;
  }

  if (msg.type === "UI_ACTION_RESULT") {
    const pending = __bgPending.get(msg.payload.requestId);
    if (pending) {
      __bgPending.delete(msg.payload.requestId);
      if (msg.payload.ok) pending.resolve(msg.payload.result);
      else pending.reject(new Error(msg.payload.error || "Ação falhou na aba do Icarus."));
    }
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
