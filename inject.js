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

// Muitos botões de ação (linha da tabela: "Notas", "Justificar Ponto",
// "Reprocessar Ponto"...) são só ícone — sem NENHUM texto visível, o nome
// "Justificar Ponto" etc. só existe no atributo `title` (tooltip). Por isso
// aqui, se o textContent não bater, cai pro título/aria-label também.
function findButtonByText(text, { exact = true, root = document } = {}) {
  const buttons = Array.from(root.querySelectorAll("button"));
  const matches = (t) => (exact ? t === text : t.includes(text));
  return buttons.find((b) => {
    if (matches((b.textContent || "").trim())) return true;
    const tooltip = b.getAttribute("title") || b.getAttribute("aria-label") || b.getAttribute("data-pr-tooltip") || "";
    return matches(tooltip.trim());
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

// Confirmado inspecionando a página real (15/09/2026): NÃO existe um botão
// com texto "Bater Ponto". O botão real é um ícone (sem texto visível) no
// topo direito, cujo tooltip/atributo é "Registrar Ponto" — o mesmo texto
// do botão "Registrar Ponto" da tela de pesquisa (que é uma ação diferente:
// abre um formulário de ajuste/solicitação). O que diferencia os dois é que
// o botão real de bater ponto NÃO tem texto visível (só o ícone).
function findBaterPontoButton() {
  const candidates = Array.from(document.querySelectorAll("button"));
  const semTextoComTooltip = candidates.filter((b) => {
    if ((b.textContent || "").trim()) return false; // tem texto visível -> é o outro botão
    const tooltip = b.getAttribute("title") || b.getAttribute("aria-label") || b.getAttribute("data-pr-tooltip") || "";
    return /registrar ponto/i.test(tooltip);
  });
  if (semTextoComTooltip.length) return semTextoComTooltip[0];

  // Fallback: qualquer botão pequeno, só ícone, perto do topo da página.
  return candidates.find((b) => {
    if ((b.textContent || "").trim()) return false;
    const rect = b.getBoundingClientRect();
    return rect.top >= 0 && rect.top < 80 && rect.width > 0 && rect.width < 60;
  }) || null;
}

// Clica no botão real de bater ponto e confirma no modal que o Icarus abre
// ("Deseja realmente efetuar a batida de ponto?" / botão "Sim"), esperando
// depois a mensagem de sucesso ("Ponto registrado com sucesso!") aparecer.
async function uiBaterPonto() {
  const btn = await waitFor(() => findBaterPontoButton(), { timeout: 3000 });
  if (!btn) throw new Error('Botão de bater ponto (ícone "Registrar Ponto" no topo) não encontrado na página.');
  if (btn.disabled) throw new Error("Botão de bater ponto está desabilitado na página agora.");
  btn.click();

  const confirmBtn = await waitFor(
    () => {
      const dialog = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="dialog"]')).find((d) =>
        /efetuar a batida de ponto/i.test(d.textContent || "")
      );
      if (!dialog) return null;
      return findButtonByText("Sim", { root: dialog, exact: false });
    },
    { timeout: 3000, interval: 150 }
  );
  if (!confirmBtn) {
    throw new Error('Cliquei no botão mas não apareceu o modal esperado ("Deseja realmente efetuar a batida de ponto?"). Confira manualmente.');
  }
  confirmBtn.click();

  const sucesso = await waitFor(() => /ponto registrado com sucesso/i.test(document.body.textContent || ""), {
    timeout: 4000,
    interval: 200,
  });
  if (!sucesso) {
    throw new Error("Confirmei a batida mas não vi a mensagem de sucesso — confira manualmente na aba do Icarus.");
  }

  return { ok: true };
}

// Acha a linha do registro "DD/MM/YYYY HH:MM" dentro do modal de "Ajuste de
// Ponto" e sobe até o container que também tem os botões de ação da linha
// (o texto do horário é um nó-folha; os botões "Remover"/"Adicionar" ficam
// num ancestral próximo — a estrutura exata do PrimeReact não é estável o
// bastante pra confiar num seletor fixo).
function findAjusteRegistroRow(dataDDMMYYYY, horarioHHMM) {
  const wanted = `${dataDDMMYYYY} ${horarioHHMM}`;
  // O horário fica numa <td class="p-editable-column"> (PrimeReact) que tem
  // 1 filho — não é um nó-folha puro, então NÃO exigimos children.length===0
  // (isso já foi um bug: nunca achava a linha por causa disso).
  const candidates = Array.from(document.querySelectorAll("*")).filter((el) => (el.textContent || "").trim() === wanted);
  for (const el of candidates) {
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const removerBtn =
        findButtonByText("Remover", { root: node, exact: false }) || findButtonByText("Excluir", { root: node, exact: false });
      const adicionarBtn = findButtonByText("Adicionar", { root: node, exact: true });
      if (removerBtn && adicionarBtn) return { row: node, removerBtn, adicionarBtn };
      node = node.parentElement;
    }
  }
  return null;
}

// Abre "Justificar Ponto" na linha do dia -> escolhe "Ajuste de Ponto" no
// modal "O Que Deseja Solicitar?" -> espera a lista de registros do dia
// carregar. Comum às ações de remover/editar uma batida real.
async function abrirModalAjustePonto(dataDDMMYYYY) {
  const row = await waitFor(() => findRowByDate(dataDDMMYYYY));
  if (!row) throw new Error(`Não encontrei a linha do dia ${dataDDMMYYYY} na tabela. Rode uma pesquisa que inclua esse dia primeiro.`);
  const justificarBtn = findButtonByText("Justificar Ponto", { root: row, exact: false });
  if (!justificarBtn) throw new Error('Botão "Justificar Ponto" não encontrado nessa linha.');
  justificarBtn.click();

  const ajusteBtn = await waitFor(() => findButtonByText("Ajuste de Ponto", { exact: true }), { timeout: 3000 });
  if (!ajusteBtn) throw new Error('Não abriu o modal "O Que Deseja Solicitar?" (ou o botão "Ajuste de Ponto" não apareceu).');
  ajusteBtn.click();

  const carregou = await waitFor(() => findButtonByText("Adicionar Horário", { exact: false }), { timeout: 3000 });
  if (!carregou) throw new Error('O modal de "Ajuste de Ponto" (lista de registros do dia) não abriu.');
}

// Remove de verdade uma batida existente: acha a linha certa (pelo horário
// já registrado), clica "Remover", escreve a justificativa (obrigatória) e
// clica "Cadastrar". Isso fica pendente de aprovação do gestor, como
// qualquer ajuste de ponto no Icarus.
async function uiRemoverBatida({ dataDDMMYYYY, horarioHHMM, justificativa }) {
  if (!justificativa || !justificativa.trim()) throw new Error("Justificativa é obrigatória pra remover uma batida.");

  await abrirModalAjustePonto(dataDDMMYYYY);

  const found = await waitFor(() => findAjusteRegistroRow(dataDDMMYYYY, horarioHHMM), { timeout: 3000 });
  if (!found) throw new Error(`Não encontrei o registro de ${horarioHHMM} do dia ${dataDDMMYYYY} no modal de ajuste.`);
  found.removerBtn.click();
  await sleep(200);

  // O campo de Justificativa é um MUI multiline com DOIS <textarea> no DOM:
  // o real (name="justificativa") e um aria-hidden/readonly só pra medir
  // altura (auto-resize) — pegar "o último da página" pega o errado.
  const textarea =
    document.querySelector('textarea[name="justificativa"]') ||
    Array.from(document.querySelectorAll("textarea")).find((t) => !t.readOnly && t.getAttribute("aria-hidden") !== "true");
  if (!textarea) throw new Error('Campo de "Justificativa" não encontrado no modal.');
  setNativeTextareaValue(textarea, justificativa);
  await sleep(150);

  const cadastrarBtn = findButtonByText("Cadastrar", { exact: false });
  if (!cadastrarBtn) throw new Error('Botão "Cadastrar" não encontrado no modal.');
  cadastrarBtn.click();

  // O Icarus valida no clique e mostra um toast de erro se a quantidade de
  // registros do dia ficar ímpar (não dá pra remover só 1 batida de um dia
  // com número par — precisa remover/adicionar em pares).
  const resultado = await waitFor(
    () => {
      const texto = document.body.textContent || "";
      if (/precisa ser par/i.test(texto)) return { erro: "par" };
      if (/sucesso/i.test(texto)) return { ok: true };
      if (!findButtonByText("Adicionar Horário", { exact: false })) return { ok: true };
      return null;
    },
    { timeout: 5000, interval: 200 }
  );
  if (!resultado) throw new Error("Enviei o ajuste mas não consegui confirmar — confira em Minhas Solicitações.");
  if (resultado.erro === "par") {
    throw new Error(
      "O Icarus não deixa remover só essa batida: a quantidade de registros do dia precisa ficar par. Remova em pares, ou edite o horário em vez de excluir."
    );
  }

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
    else if (action === "baterPonto") result = await uiBaterPonto();
    else if (action === "removerBatida") result = await uiRemoverBatida(params);
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
