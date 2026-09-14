/**
 * inject.js
 * Roda no MUNDO PRINCIPAL (world: "MAIN") da aba web.pontoicarus.com.br.
 *
 * IMPORTANTE — por que isso muda de "chamar a API direto" pra "clicar nos
 * elementos reais da página":
 * Testamos fazer nosso próprio `fetch` pro backend (mesma origem, mesmos
 * cookies) e o Chrome bloqueou com "Failed to fetch". A causa mais provável
 * é que o Icarus autentica via token Bearer que o próprio app anexa a cada
 * chamada (lido do localStorage pelo axios/interceptor dele) — e não só por
 * cookie de sessão. Ler esse token do localStorage é exatamente o tipo de
 * dado sensível que esta extensão se recusa a tocar.
 *
 * Solução: em vez de reconstruir a chamada HTTP nós mesmos, a extensão
 * aciona os MESMOS botões/campos que você acionaria manualmente (via DOM),
 * deixando o próprio app do Icarus (com seu próprio token) fazer a chamada.
 * Paralelamente, continuamos observando passivamente as respostas dessas
 * chamadas (via hook em fetch/XHR) pra extrair os dados pro painel — sem
 * nunca ler nem repassar o token em si.
 */

const BACKEND = "https://backendicarus.pontoicarus.com.br";
const MSG_NS = "__pontoIcarusExt__";

// ---------- 1) Observação passiva do tráfego (URL + corpo da resposta) ----------

function broadcastObservedResponse(url, method, reqBody, status, respText) {
  let data = null;
  try { data = JSON.parse(respText); } catch (_) { /* não-JSON, ignora */ }
  let idColaborador = null;
  try {
    if (reqBody && typeof reqBody === "string") {
      const parsed = JSON.parse(reqBody);
      idColaborador = parsed.idColaborador || parsed.mutuario?.idColaborador || parsed.mutuario?.id || null;
    }
  } catch (_) {}
  if (!idColaborador) {
    const m = url.match(/buscarTurnoVinculadoColaborador\/(\d+)/);
    if (m) idColaborador = Number(m[1]);
  }
  window.postMessage(
    { source: MSG_NS, type: "OBSERVED_RESPONSE", payload: { url, method, status, data, idColaborador } },
    "*"
  );
}

const origFetch = window.fetch;
window.fetch = async function (...args) {
  const res = await origFetch.apply(this, args);
  try {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    if (url && url.startsWith(BACKEND)) {
      const clone = res.clone();
      clone.text().then((text) => broadcastObservedResponse(url, args[1]?.method || "GET", args[1]?.body, res.status, text));
    }
  } catch (_) {}
  return res;
};

const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this.__url = url;
  this.__method = method;
  return origOpen.apply(this, [method, url, ...rest]);
};
XMLHttpRequest.prototype.send = function (body) {
  if (this.__url && this.__url.startsWith(BACKEND)) {
    this.addEventListener("load", () => {
      broadcastObservedResponse(this.__url, this.__method, body, this.status, this.responseText || "");
    });
  }
  return origSend.apply(this, [body]);
};

// ---------- 2) Automação de UI (clicar nos elementos reais da página) ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, { timeout = 4000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = predicate();
    if (found) return found;
    await sleep(interval);
  }
  return null;
}

function findButtonByText(text, { exact = true, root = document } = {}) {
  const buttons = Array.from(root.querySelectorAll("button"));
  return buttons.find((b) => {
    const t = (b.textContent || "").trim();
    return exact ? t === text : t.includes(text);
  });
}

// Encontra a linha (tr) da tabela de registros cujo texto contenha a data
// no formato DD/MM/YYYY.
function findRowByDate(dateDDMMYYYY) {
  const rows = Array.from(document.querySelectorAll("tr"));
  return rows.find((r) => (r.textContent || "").includes(dateDDMMYYYY));
}

// Define o valor de um <input> React-controlled corretamente (via setter
// nativo, senão o React não percebe a mudança) e dispara os eventos que o
// PrimeReact espera.
function setNativeInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function setNativeTextareaValue(textarea, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

async function uiSearch({ dataInicioDDMMYYYY, dataFimDDMMYYYY }) {
  const dateInputs = Array.from(document.querySelectorAll('input[placeholder="DD/MM/YYYY"]'));
  if (dateInputs.length < 2) throw new Error("Campos de período não encontrados na página.");
  setNativeInputValue(dateInputs[0], dataInicioDDMMYYYY);
  await sleep(150);
  setNativeInputValue(dateInputs[1], dataFimDDMMYYYY);
  await sleep(150);
  document.body.click(); // fecha eventual calendário popup
  await sleep(150);
  const searchBtn = findButtonByText("Pesquisar");
  if (!searchBtn) throw new Error('Botão "Pesquisar" não encontrado.');
  searchBtn.click();
  return { ok: true };
}

async function uiAddNota({ dataDDMMYYYY, texto }) {
  const row = await waitFor(() => findRowByDate(dataDDMMYYYY));
  if (!row) throw new Error(`Não encontrei a linha do dia ${dataDDMMYYYY} na tabela. Rode uma pesquisa que inclua esse dia primeiro.`);
  const notaBtn = findButtonByText("Notas", { root: row });
  if (!notaBtn) throw new Error('Botão "Notas" não encontrado nessa linha.');
  notaBtn.click();

  const textarea = await waitFor(() => document.querySelector('textarea[placeholder="Nota *"]'));
  if (!textarea) throw new Error("Modal de nota não abriu.");
  setNativeTextareaValue(textarea, texto);
  await sleep(150);

  const modal = textarea.closest('[class*="modal"], [role="dialog"]') || document;
  const saveBtn = findButtonByText("Cadastrar", { root: modal, exact: false });
  if (!saveBtn) throw new Error('Botão "Cadastrar" não encontrado no modal de nota.');
  saveBtn.click();
  return { ok: true };
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== MSG_NS || msg.type !== "UI_ACTION") return;

  const { requestId, action, params } = msg.payload;
  try {
    let result;
    if (action === "search") result = await uiSearch(params);
    else if (action === "addNota") result = await uiAddNota(params);
    else throw new Error(`Ação desconhecida: ${action}`);

    window.postMessage(
      { source: MSG_NS, type: "UI_ACTION_RESULT", payload: { requestId, ok: true, result } },
      "*"
    );
  } catch (err) {
    console.warn("[PontoIcarusExt] UI_ACTION falhou:", err);
    window.postMessage(
      { source: MSG_NS, type: "UI_ACTION_RESULT", payload: { requestId, ok: false, error: String(err?.message || err) } },
      "*"
    );
  }
});
