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

// Soma dos intervalos ENTRE pares (saída -> próxima entrada), numa lista
// ordenada de horários (ms) já mesclados (reais visíveis + pendentes com
// horário). Nunca inclui o trecho em aberto no fim (isso é "trabalhado",
// não intervalo) — só o que fica ENTRE dois pares completos.
function intervalMinutesFromTimes(times) {
  let min = 0;
  for (let i = 1; i + 1 < times.length; i += 2) min += (times[i + 1] - times[i]) / 60000;
  return min;
}

function showStatus(text, type = "info") {
  const box = $("#statusBox");
  box.textContent = text;
  box.className = `status ${type}`;
  box.classList.remove("hidden");
}
function hideStatus() {
  $("#statusBox").classList.add("hidden");
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
    : `Batidas de ${date.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })}`;
  $("#backToTodayBtn").classList.toggle("hidden", isToday);
  $("#workedLabel").textContent = isToday ? "Trabalhado hoje" : "Normal";
  $("#remainingLabel").textContent = isToday ? "Falta trabalhar" : "Faltando";

  // tags do dia
  const tags = [];
  if (ponto?.temAbonoOuAjusteRegistrado) tags.push(`<span class="tag purple">Ajuste/abono${ponto.statusSolicitacao ? " · " + ponto.statusSolicitacao.toLowerCase() : ""}</span>`);
  if (ponto?.falta === "SIM") tags.push('<span class="tag red">Falta</span>');
  if (ponto?.consistente === "NAO") tags.push('<span class="tag red">Inconsistente</span>');
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
      el.title = `${b.marcacaoFmt || ""}${isBatidaManual(b) ? ` · ${b.tipoRegistroFmt}` : ""} · Clique pra marcar como pendente de exclusão.`;
      el.onclick = () => markPunchPendingDeletion(key, seq, b);
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
        return p.approxTime
          ? `<div class="pending-item"><span class="dot orange"></span>${p.label} — horário aproximado informado: ${p.approxTime}, falta registrar no Icarus.</div>`
          : `<div class="pending-item"><span class="dot orange"></span>${p.label} — clicado em "ajustar depois" às ${hhmm(p.clickedAt)}, falta registrar no Icarus.</div>`;
      })
      .join("");
    pendingBox.querySelectorAll(".pending-check").forEach((cb) => {
      cb.addEventListener("change", () => IcarusAPI.setPendingDeletionDone(key, Number(cb.dataset.horario), cb.checked));
    });
    pendingBox.querySelectorAll(".pending-cancel").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await showConfirm("A batida volta a aparecer no cartão de batidas.", {
          title: "Cancelar exclusão pendente",
          okLabel: "Cancelar exclusão",
          cancelLabel: "Voltar",
        });
        if (ok) IcarusAPI.resolvePendingDeletion(key, Number(btn.dataset.horario));
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
    $("#workedToday").textContent = ponto?.tempoNormal || "--:--";
    $("#remainingToday").textContent = ponto?.tempoFaltando || "--:--";
    $("#workedToday").parentElement.classList.remove("running");
    if (ponto) {
      const diaPendingComHorarioSel = diaPendingMissing.filter((p) => p.approxTime);
      const mergedTimesSel = mergedPunchesForDay(key, ordenadasVisiveis, diaPendingComHorarioSel).map((item) => item.timeMs);
      $("#intervalToday").textContent = minutesToHHMM(intervalMinutesFromTimes(mergedTimesSel));
    } else {
      $("#intervalToday").textContent = "--:--";
    }
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
    "de ajustes pendentes. Isso não mexe no Icarus — solicite a exclusão de verdade no site; dá pra cancelar o " +
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

  const trabalhadoApiBase = ponto
    ? (ponto.minutoNormalDiurno || 0) +
      (ponto.minutoNormalNoturno || 0) +
      (ponto.minutoExtraTP1 || 0) +
      (ponto.minutoExtraTP2 || 0) +
      (ponto.minutoExtraTP3 || 0)
    : 0;
  const metaMin = ponto ? trabalhadoApiBase + (ponto.minutoFaltante || 0) : DEFAULT_JORNADA_MIN;

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
  const intervalEl = $("#intervalToday");
  const remainingEl = $("#remainingToday");
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
    workedEl.parentElement.classList.remove("running");
    if (punch4) punch4.classList.remove("predicted");
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

  // sequência cronológica só dos instantes (reais visíveis + pendentes com
  // horário) — usada pro intervalo sempre (o Icarus não expõe esse número)
  // e pro trabalhado quando não dá pra confiar no total pronto do Icarus.
  const mergedTimes = mergedPunchesForDay(key, ordenadasVisiveis, diaPendingComHorario).map((item) => item.timeMs);

  let workedMin;
  let emAndamento;
  if (diaPendingComHorario.length || diaPendingDelete.length) {
    // total pronto do Icarus não serve aqui: ou falta uma batida que só
    // existe localmente, ou sobra uma que precisa sair da conta.
    workedMin = 0;
    for (let i = 0; i + 1 < mergedTimes.length; i += 2) {
      workedMin += (mergedTimes[i + 1] - mergedTimes[i]) / 60000;
    }
    emAndamento = mergedTimes.length % 2 === 1;
    if (emAndamento) workedMin += (Date.now() - mergedTimes[mergedTimes.length - 1]) / 60000;
  } else {
    emAndamento = ordenadas.length % 2 === 1;
    const decorridoAberto = emAndamento ? (Date.now() - ordenadas[ordenadas.length - 1].horario) / 60000 : 0;
    workedMin = trabalhadoApiBase + decorridoAberto;
  }

  const remainingMin = Math.max(0, metaMin - workedMin);
  workedEl.textContent = minutesToHHMM(workedMin);
  intervalEl.textContent = minutesToHHMM(intervalMinutesFromTimes(mergedTimes));
  remainingEl.textContent = minutesToHHMM(remainingMin);
  workedEl.parentElement.classList.toggle("running", emAndamento);

  // previsão de saída (4ª batida) — só enquanto o 4º slot ainda está vazio
  // e as 3 primeiras já aconteceram (real ou digitada); é uma estimativa
  // ("se eu continuar trabalhando sem mais pausa, termino às..."), nunca
  // uma batida — some assim que a batida real (ou uma pendente) ocupar o slot.
  if (punch4 && mergedTimes.length === 3 && punch4.classList.contains("fillable")) {
    punch4.classList.add("predicted");
    punch4.querySelector(".value").textContent = `~${hhmm(Date.now() + remainingMin * 60000)}`;
    punch4.title = "Previsão de saída (estimativa, não é uma batida real). Clique pra informar o horário quando bater de verdade.";
  } else if (punch4) {
    punch4.classList.remove("predicted");
  }
}

// ---------- registrar ponto ----------

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
    setTimeout(fetchMonth, 1200);
  } catch (err) {
    showStatus(`Erro ao registrar ponto: ${err.message}`, "error");
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
  $("#refreshBtn").addEventListener("click", () => { fetchMonth(); });

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
  renderCalendar();
  renderDayPanel();
  loadPendingAdjustments();
  // 3) só então dispara a busca real (assíncrona) que atualiza os dias
  fetchMonth();
});
