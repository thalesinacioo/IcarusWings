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
const DEFAULT_JORNADA_MIN = 8 * 60; // meta do dia (08-12 + 13-17) quando o Icarus ainda não tem registro nenhum pro dia

let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();
let registrosPorDia = {}; // "YYYY-MM-DD" -> ponto object
let pendingAdjustments = {}; // "YYYY-MM-DD" -> [{seq,label,clickedAt}]
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

function showStatus(text, type = "info") {
  const box = $("#statusBox");
  box.textContent = text;
  box.className = `status ${type}`;
  box.classList.remove("hidden");
}
function hideStatus() {
  $("#statusBox").classList.add("hidden");
}

function ingestRegistros(data) {
  registrosPorDia = {};
  (data?.pontos || []).forEach((p) => {
    const d = new Date(p.dataBatida);
    registrosPorDia[dateKey(d)] = p;
  });
  renderCalendar();
  renderDayPanel();
  hideStatus();
}

async function loadPendingAdjustments() {
  pendingAdjustments = await IcarusAPI.getPendingAdjustments();
  renderCalendar();
  renderDayPanel();
}

// ---------- carregar mês ----------
// O calendário (grade de dias) é desenhado na hora, sem depender de dado
// nenhum — só a cor/estado de cada dia é que chega depois, quando a busca
// real na aba do Icarus responde.

function loadMonth() {
  renderCalendar(); // desenha a grade imediatamente com o que já houver em cache
  fetchMonth();
}

async function fetchMonth() {
  const first = new Date(currentYear, currentMonth, 1);
  const last = new Date(currentYear, currentMonth + 1, 0);
  $("#monthLabel").textContent = first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  showStatus("Buscando na aba do Icarus…", "info");
  try {
    await IcarusAPI.searchPeriod(first, last);
    setTimeout(async () => {
      const { data } = await IcarusAPI.getLastRegistros();
      if (data) ingestRegistros(data);
    }, 1200);
  } catch (err) {
    showStatus(`Erro ao buscar: ${err.message}`, "error");
  }
}

// ---------- classificação dos dias ----------

function batidasOrdenadas(ponto) {
  return [...(ponto?.pontosHorariosBatidasOrdenados || [])].sort((a, b) => a.horario - b.horario);
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

function classifyDay(ponto) {
  if (!ponto) return null;
  // Roxo tem prioridade: o dia teve ajuste/abono registrado no Icarus.
  if (ponto.temAbonoOuAjusteRegistrado === true) return "purple";
  if (ponto.falta === "SIM" || ponto.consistente === "NAO") return "red";
  const batidas = batidasOrdenadas(ponto);
  const trabalhouAlgo = (ponto.minutoNormalDiurno || 0) + (ponto.minutoNormalNoturno || 0) > 0 || batidas.length > 0;
  return trabalhouAlgo ? "green" : null;
}

function renderCalendar() {
  const first = new Date(currentYear, currentMonth, 1);
  const last = new Date(currentYear, currentMonth + 1, 0);
  $("#monthLabel").textContent = first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  const grid = $("#calendarGrid");
  grid.innerHTML = "";
  for (let i = 0; i < first.getDay(); i++) {
    const empty = document.createElement("div");
    empty.className = "day empty";
    grid.appendChild(empty);
  }
  const todayKey = dateKey(new Date());
  for (let day = 1; day <= last.getDate(); day++) {
    const d = new Date(currentYear, currentMonth, day);
    const key = dateKey(d);
    const ponto = registrosPorDia[key];
    const cls = classifyDay(ponto);
    const hasPending = (pendingAdjustments[key] || []).length > 0;
    const isSelected = selectedDayKey ? key === selectedDayKey : key === todayKey;
    const cell = document.createElement("div");
    cell.className = `day${cls ? " " + cls : ""}${key === todayKey ? " today" : ""}${isSelected ? " selected" : ""}${hasPending ? " has-pending" : ""}`;
    cell.innerHTML = `<span class="chip">${day}</span>`;
    if (ponto) {
      cell.title = `Normal ${ponto.tempoNormal || "--"} · Falta ${ponto.tempoFaltando || "--"} · Saldo ${ponto.tempoSaldo || "--"}`;
    }
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

  $("#dayPanelTitle").textContent = isToday
    ? "Batidas de hoje"
    : `Batidas de ${date.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })}`;
  $("#backToTodayBtn").classList.toggle("hidden", isToday);
  $("#workedLabel").textContent = isToday ? "Trabalhado hoje" : "Normal";
  $("#remainingLabel").textContent = isToday ? "Falta trabalhar" : "Faltando";

  // tags do dia
  const tags = [];
  if (ponto?.temAbonoOuAjusteRegistrado) tags.push(`<span class="tag purple">Ajuste/abono${ponto.statusSolicitacao ? " · " + ponto.statusSolicitacao.toLowerCase() : ""}</span>`);
  if (ponto?.falta === "SIM") tags.push('<span class="tag red">Falta</span>');
  if (ponto?.consistente === "NAO") tags.push('<span class="tag red">Inconsistente</span>');
  if (diaPending.length) tags.push(`<span class="tag gray">${diaPending.length} ajuste${diaPending.length > 1 ? "s" : ""} pendente${diaPending.length > 1 ? "s" : ""}</span>`);
  $("#dayPanelTags").innerHTML = tags.join("");

  // 4 batidas (compacto) — reais e pendentes juntas, em ordem cronológica real
  const merged = mergedPunchesForDay(key, ordenadas, diaPending);
  document.querySelectorAll(".punch").forEach((el) => {
    const seq = Number(el.dataset.seq);
    const item = merged[seq - 1];
    const valueEl = el.querySelector(".value");
    el.classList.remove("manual", "pending", "fillable");
    el.onclick = null;
    if (item?.real) {
      const b = item.real;
      valueEl.textContent = b.horarioFormatadoSemData || "--:--";
      el.classList.toggle("manual", isBatidaManual(b));
      el.title = `${b.marcacaoFmt || ""}${isBatidaManual(b) ? ` · ${b.tipoRegistroFmt}` : ""}`;
    } else if (item?.pending) {
      const pend = item.pending;
      const label = pend.label || PUNCH_SCHEDULE.find((s) => s.seq === pend.seq)?.label || `${seq}ª batida`;
      const shown = pend.approxTime || hhmm(pend.clickedAt);
      valueEl.textContent = `~${shown}`;
      el.classList.add("pending", "fillable");
      el.title = pend.approxTime
        ? `Horário aproximado informado: ${pend.approxTime} — ainda não registrado no Icarus. Clique pra editar.`
        : `Marcado como "ajustar depois" às ${hhmm(pend.clickedAt)} — ainda não registrado no Icarus. Clique pra informar o horário.`;
      el.onclick = () => openPunchTimeModal(key, pend.seq, label, pend.approxTime);
    } else {
      const label = PUNCH_SCHEDULE.find((s) => s.seq === seq)?.label || `${seq}ª batida`;
      valueEl.textContent = "--:--";
      el.classList.add("fillable");
      el.title = "Batida não registrada. Clique pra informar o horário aproximado.";
      el.onclick = () => openPunchTimeModal(key, seq, label, null);
    }
  });

  renderMissingPunchAlert(key, ordenadas, diaPending, isToday);

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

  // ajustes pendentes (lembrete "ajustar depois" ou horário digitado)
  const pendingBox = $("#pendingAdjustmentsToday");
  if (diaPending.length) {
    pendingBox.classList.remove("hidden");
    pendingBox.innerHTML = diaPending
      .map((p) =>
        p.approxTime
          ? `<div class="pending-item"><span class="dot gray"></span>${p.label} — horário aproximado informado: ${p.approxTime}, falta registrar no Icarus.</div>`
          : `<div class="pending-item"><span class="dot gray"></span>${p.label} — clicado em "ajustar depois" às ${hhmm(p.clickedAt)}, falta registrar no Icarus.</div>`
      )
      .join("");
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
    $("#workedToday").textContent = ponto?.tempoNormal || "--:--";
    $("#remainingToday").textContent = ponto?.tempoFaltando || "--:--";
    $("#workedToday").parentElement.classList.remove("running");
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

// ---------- horário aproximado de uma batida faltante ----------

let punchTimeModalCtx = null; // { dateKey, seq, label }

function openPunchTimeModal(dateKeyStr, seq, label, existingApproxTime) {
  punchTimeModalCtx = { dateKey: dateKeyStr, seq, label };
  $("#punchTimeModalLabel").textContent = label;
  $("#punchTimeModalInput").value = existingApproxTime || hhmm(Date.now());
  $("#punchTimeModal").classList.remove("hidden");
}
function closePunchTimeModal() {
  $("#punchTimeModal").classList.add("hidden");
  punchTimeModalCtx = null;
}
async function savePunchTimeModal() {
  if (!punchTimeModalCtx) return;
  const value = $("#punchTimeModalInput").value; // "HH:MM"
  if (!value) return;
  const { dateKey: dk, seq, label } = punchTimeModalCtx;
  await IcarusAPI.setPendingAdjustmentTime(dk, seq, label, value);
  closePunchTimeModal();
  showStatus(`Horário aproximado salvo para "${label}" — lembre de ajustar de verdade no Icarus.`, "info");
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
  const remainingEl = $("#remainingToday");

  const ordenadas = ponto ? batidasOrdenadas(ponto) : [];
  // batida(s) digitada(s) mas ainda não enviada(s) ao Icarus — o Icarus só
  // viu as reais, então não dá pra confiar no total dele; recalculamos
  // somando os intervalos entrada/saída da sequência completa (real + pendente).
  const diaPendingComHorario = (pendingAdjustments[key] || []).filter((p) => p.approxTime);

  if (!ponto && !diaPendingComHorario.length) {
    // nada aconteceu hoje ainda: nem batida real registrada no Icarus, nem digitada
    workedEl.textContent = "--:--";
    remainingEl.textContent = "--:--";
    workedEl.parentElement.classList.remove("running");
    return;
  }

  const trabalhadoApiBase = ponto
    ? (ponto.minutoNormalDiurno || 0) +
      (ponto.minutoNormalNoturno || 0) +
      (ponto.minutoExtraTP1 || 0) +
      (ponto.minutoExtraTP2 || 0) +
      (ponto.minutoExtraTP3 || 0)
    : 0;
  // sem ponto (Icarus ainda não tem nenhum registro do dia) não dá pra saber
  // a meta real, então usa a jornada padrão só pra não deixar "Falta
  // trabalhar" vazio.
  const metaMin = ponto ? trabalhadoApiBase + (ponto.minutoFaltante || 0) : DEFAULT_JORNADA_MIN;

  let workedMin;
  let emAndamento;
  if (diaPendingComHorario.length) {
    const merged = mergedPunchesForDay(key, ordenadas, diaPendingComHorario);
    workedMin = 0;
    for (let i = 0; i + 1 < merged.length; i += 2) {
      workedMin += (merged[i + 1].timeMs - merged[i].timeMs) / 60000;
    }
    emAndamento = merged.length % 2 === 1;
    if (emAndamento) workedMin += (Date.now() - merged[merged.length - 1].timeMs) / 60000;
  } else {
    emAndamento = ordenadas.length % 2 === 1;
    const decorridoAberto = emAndamento ? (Date.now() - ordenadas[ordenadas.length - 1].horario) / 60000 : 0;
    workedMin = trabalhadoApiBase + decorridoAberto;
  }

  workedEl.textContent = minutesToHHMM(workedMin);
  remainingEl.textContent = minutesToHHMM(Math.max(0, metaMin - workedMin));
  workedEl.parentElement.classList.toggle("running", emAndamento);
}

// ---------- notas ----------

let notaModalDate = null;

function openNotaModal(date) {
  notaModalDate = date;
  $("#notaModalDate").textContent = date.toLocaleDateString("pt-BR");
  $("#notaModalText").value = "";
  $("#notaModal").classList.remove("hidden");
}
function closeNotaModal() {
  $("#notaModal").classList.add("hidden");
}

async function submitNota() {
  const texto = $("#notaModalText").value.trim();
  if (!texto || !notaModalDate) return;
  try {
    await IcarusAPI.addNota(notaModalDate, texto);
    closeNotaModal();
    showStatus("Nota adicionada.", "info");
    setTimeout(fetchMonth, 1000);
  } catch (err) {
    showStatus(`Erro ao salvar nota: ${err.message}`, "error");
  }
}

// ---------- depuração ----------

async function renderEndpointLog() {
  const log = await IcarusAPI.getEndpointLog();
  const el = $("#endpointLog");
  if (!log.length) {
    el.textContent = "Nenhum ainda.";
    return;
  }
  el.innerHTML = log
    .map((e) => `<div>${new Date(e.ts).toLocaleTimeString("pt-BR")} · ${e.method} ${e.status ?? ""} ${(e.url || "").replace("https://backendicarus.pontoicarus.com.br", "")}</div>`)
    .join("");
}

// ---------- wiring ----------

document.addEventListener("DOMContentLoaded", () => {
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
  $("#refreshBtn").addEventListener("click", () => { fetchMonth(); renderEndpointLog(); });

  $("#backToTodayBtn").addEventListener("click", () => {
    selectedDayKey = null;
    renderCalendar();
    renderDayPanel();
  });

  $("#notasBtn").addEventListener("click", () => openNotaModal(new Date()));
  $("#notaModalCancel").addEventListener("click", closeNotaModal);
  $("#notaModalSave").addEventListener("click", submitNota);

  $("#dayPanelAddNota").addEventListener("click", () => {
    const key = selectedDayKey || dateKey(new Date());
    openNotaModal(keyToDate(key));
  });

  $("#punchTimeModalCancel").addEventListener("click", closePunchTimeModal);
  $("#punchTimeModalSave").addEventListener("click", savePunchTimeModal);

  $("#baterPontoBtn").disabled = true; // combinamos deixar pra depois das 17h
  $("#registrarPontoBtn").disabled = true; // fluxo de aprovação — ainda não automatizado
  $("#justificarBtn").disabled = true; // idem

  document.addEventListener("icarus:observed", (ev) => {
    const { url, data } = ev.detail || {};
    if (url && url.includes("/ponto/consultarRegistrosPonto") && data) ingestRegistros(data);
    renderEndpointLog();
  });
  document.addEventListener("icarus:pendingAdjustmentsChanged", loadPendingAdjustments);

  // 1) desenha o calendário e o restante da UI na hora, sem esperar rede
  renderCalendar();
  renderDayPanel();
  loadPendingAdjustments();
  renderEndpointLog();
  // 2) só então dispara a busca real (assíncrona) que colore os dias
  fetchMonth();
});
