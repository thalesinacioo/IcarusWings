/**
 * api.js — wrapper usado pelo sidepanel.js.
 *
 * Duas fontes de dados, nenhuma delas monta uma requisição autenticada por
 * conta própria (isso falha por causa do token Bearer que só o app do
 * Icarus sabe anexar):
 *  1) Leitura passiva: o que o próprio Icarus já buscou fica salvo em
 *     chrome.storage.local (populado por background.js a partir do que
 *     inject.js observa).
 *  2) Ações de UI: pedimos pro inject.js clicar/preencher os elementos
 *     reais da página (que o próprio Icarus autentica sozinho).
 */
const MSG_NS = "__pontoIcarusExt__";
let __reqCounter = 0;
const __pending = new Map();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== MSG_NS) return;

  if (msg.type === "UI_ACTION_RESULT") {
    const p = __pending.get(msg.payload.requestId);
    if (p) {
      __pending.delete(msg.payload.requestId);
      p.resolve(msg.payload);
    }
  }

  if (msg.type === "OBSERVED_RESPONSE") {
    document.dispatchEvent(new CustomEvent("icarus:observed", { detail: msg.payload }));
  }
});

function runUiAction(action, params) {
  return new Promise((resolve, reject) => {
    const requestId = `ui_${Date.now()}_${__reqCounter++}`;
    __pending.set(requestId, { resolve, reject });
    chrome.runtime
      .sendMessage({ source: MSG_NS, type: "UI_ACTION", payload: { requestId, action, params } })
      .catch((err) => {
        __pending.delete(requestId);
        reject(err);
      });
    setTimeout(() => {
      if (__pending.has(requestId)) {
        __pending.delete(requestId);
        reject(new Error("Tempo esgotado. Confira se a aba do Ponto Icarus está aberta e você está logado."));
      }
    }, 15000);
  });
}

const IcarusAPI = {
  async getIdColaborador() {
    const { idColaborador } = await chrome.storage.local.get("idColaborador");
    return idColaborador || null;
  },

  async getLastRegistros() {
    const { lastRegistros, lastRegistrosAt } = await chrome.storage.local.get(["lastRegistros", "lastRegistrosAt"]);
    return { data: lastRegistros || null, at: lastRegistrosAt || null };
  },

  async getLastTurno() {
    const { lastTurno } = await chrome.storage.local.get("lastTurno");
    return lastTurno || null;
  },

  // Preenche o período na tela real e clica em "Pesquisar" — os dados
  // chegam de volta via o evento "icarus:observed" (resposta real do site).
  async searchPeriod(dataInicioDate, dataFimDate) {
    const fmt = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    return runUiAction("search", { dataInicioDDMMYYYY: fmt(dataInicioDate), dataFimDDMMYYYY: fmt(dataFimDate) });
  },

  async addNota(dateObj, texto) {
    const fmt = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    return runUiAction("addNota", { dataDDMMYYYY: fmt(dateObj), texto });
  },

  async getEndpointLog() {
    const { endpointLog } = await chrome.storage.local.get({ endpointLog: [] });
    return endpointLog;
  },

  // "Ajustar depois" clicado num lembrete, ou horário aproximado digitado
  // manualmente — { "YYYY-MM-DD": [{seq, label, clickedAt, approxTime?}] }
  async getPendingAdjustments() {
    const { pendingAdjustments } = await chrome.storage.local.get({ pendingAdjustments: {} });
    return pendingAdjustments;
  },

  // Salva (ou substitui) o horário aproximado de uma batida faltante que a
  // pessoa digitou manualmente. approxTimeHHMM: "13:05".
  async setPendingAdjustmentTime(dateKeyStr, seq, label, approxTimeHHMM) {
    const { pendingAdjustments = {} } = await chrome.storage.local.get({ pendingAdjustments: {} });
    const dayList = (pendingAdjustments[dateKeyStr] || []).filter((p) => p.seq !== seq);
    dayList.push({ seq, label, clickedAt: Date.now(), approxTime: approxTimeHHMM });
    dayList.sort((a, b) => a.seq - b.seq);
    pendingAdjustments[dateKeyStr] = dayList;
    await chrome.storage.local.set({ pendingAdjustments });
  },
};

// storage muda em segundo plano (ex: lembrete resolvido, nova consulta) —
// avisa o sidepanel mesmo sem precisar de uma mensagem explícita.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.pendingAdjustments) {
    document.dispatchEvent(new CustomEvent("icarus:pendingAdjustmentsChanged"));
  }
});
