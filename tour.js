// tour.js — onboarding guiado do painel: destaca cada feature em sequência,
// com bolha explicativa e navegação Avançar/Voltar/Pular. Guarda em
// chrome.storage.local quais passos o usuário já viu (por `id`, não por
// versão), então um update que só acrescenta um passo novo mostra só ele —
// não a lista inteira de novo. Autocontido: não depende de nada declarado
// em sidepanel.js.

// Abre/fecha o popup de configurações mexendo direto no DOM (mesma lógica
// de posicionamento de positionSettingsPopup() no sidepanel.js) em vez de
// simular um clique — simular clique depende da ordem de propagação dos
// listeners já registrados lá e, se algo não bater, o popup nem abre e o
// passo aponta pra um botão com display:none (retângulo zerado, spotlight
// e balão vão parar em qualquer canto da tela).
let settingsOpenedByTour = false;
function openSettingsPopupForTour() {
  const popup = document.getElementById("settingsPopup");
  const btn = document.getElementById("settingsBtn");
  if (!popup || !btn) return;
  if (popup.classList.contains("hidden")) {
    popup.classList.remove("hidden");
    settingsOpenedByTour = true;
  }
  const cardRect = (document.getElementById("calendarCard") || popup).getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  popup.style.left = `${Math.round(cardRect.left)}px`;
  popup.style.width = `${Math.round(cardRect.width)}px`;
  popup.style.top = `${Math.round(btnRect.bottom + 8)}px`;
}
function closeSettingsPopupForTour() {
  const popup = document.getElementById("settingsPopup");
  if (popup && settingsOpenedByTour) {
    popup.classList.add("hidden");
    settingsOpenedByTour = false;
  }
}

const TOUR_STEPS = [
  { id: "bater-ponto", selector: "#baterPontoBtn", title: "Bater o ponto", text: "Bata seu ponto direto por aqui, sem precisar abrir o site do Icarus." },
  { id: "atualizar", selector: "#refreshBtn", title: "Atualizar", text: "Busca as batidas mais recentes do Icarus e atualiza o painel." },
  {
    id: "configuracoes",
    selector: "#settingsToggles",
    title: "Configurações",
    text: "Aqui você ajusta se faz 1h de almoço, se hoje é dia de 8:48 ou se sua jornada é de 6h/dia — os cálculos de horário se adaptam a essas opções.",
    onEnter: openSettingsPopupForTour,
    onExit: closeSettingsPopupForTour,
  },
  {
    id: "ferias-folgas",
    selector: "#addFeriasFolgasBtn",
    title: "Férias, folgas e abono",
    text: "Use esse botão pra marcar períodos de férias, folga ou abono no calendário (é só uma anotação sua, não manda nada pro Icarus).",
    onEnter: openSettingsPopupForTour,
    onExit: closeSettingsPopupForTour,
  },
  { id: "calendario", selector: "#calendarCard", title: "Calendário", text: "Clique em qualquer dia pra ver os detalhes daquela data. As cores mostram o status de cada dia." },
  { id: "legenda", selector: ".legend", title: "Legenda", text: "Cada cor tem um significado: erro/falta, ajuste manual, ajuste pendente, feriado, férias, folga ou abono." },
  { id: "dia-painel", selector: "#dayPanelCard", title: "Detalhes do dia", text: "Aqui ficam as batidas do dia selecionado, o total trabalhado, o intervalo e quanto ainda falta." },
  {
    id: "ajuste-batida",
    selector: "#punchesGrid",
    title: "Ajustar uma batida",
    text: "Esqueceu de bater o ponto? Clique na batida vazia (tracejada) pra informar o horário aproximado. Pra corrigir uma batida errada, clique nela pra marcar como pendente de exclusão — depois é só confirmar ou cancelar na lista que aparece logo abaixo.",
  },
  { id: "flexibilizacao", selector: "#flexCard", title: "Flexibilização do mês", text: "Acompanhe seu saldo de horas e o abono estimado disponível no período (função ainda em construção)." },
];

const TOUR_STORAGE_KEY = "icarusTourSeenSteps";

let tourEls = null;
let activeSteps = [];
let activeIndex = 0;

function buildTourEls() {
  if (tourEls) return tourEls;
  const blocker = document.createElement("div");
  blocker.className = "tour-blocker hidden";
  const spotlight = document.createElement("div");
  spotlight.className = "tour-spotlight hidden";
  const bubble = document.createElement("div");
  bubble.className = "tour-bubble hidden";
  bubble.innerHTML = `
    <div class="tour-bubble-step"></div>
    <div class="tour-bubble-title"></div>
    <div class="tour-bubble-text"></div>
    <div class="tour-bubble-actions">
      <button type="button" class="link-btn tour-skip-btn">Pular tour</button>
      <div class="tour-bubble-nav">
        <button type="button" class="secondary-btn tour-back-btn">Voltar</button>
        <button type="button" class="primary-btn tour-next-btn">Avançar</button>
      </div>
    </div>
  `;
  document.body.append(blocker, spotlight, bubble);
  tourEls = {
    blocker,
    spotlight,
    bubble,
    stepEl: bubble.querySelector(".tour-bubble-step"),
    titleEl: bubble.querySelector(".tour-bubble-title"),
    textEl: bubble.querySelector(".tour-bubble-text"),
    backBtn: bubble.querySelector(".tour-back-btn"),
    nextBtn: bubble.querySelector(".tour-next-btn"),
    skipBtn: bubble.querySelector(".tour-skip-btn"),
  };
  // ev.stopPropagation() nos três: sem isso, o clique continua borbulhando
  // até o listener global de "clique fora fecha o popup" que o próprio
  // sidepanel.js registra em document (usado pro popup de configurações) —
  // como o alvo do clique é o balão do tour, não o popup, esse listener
  // via de regra fecharia de novo qualquer coisa que o onEnter tenha
  // acabado de abrir (ex: o popup de férias/folgas/abono), no mesmo clique.
  tourEls.backBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    goToStep(activeIndex - 1);
  });
  tourEls.nextBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (activeIndex >= activeSteps.length - 1) endTour(true);
    else goToStep(activeIndex + 1);
  });
  tourEls.skipBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    endTour(true);
  });
  blocker.addEventListener("click", (ev) => ev.stopPropagation());
  window.addEventListener("resize", () => {
    if (isTourOpen()) positionTourStep();
  });
  return tourEls;
}

function isTourOpen() {
  return !!tourEls && !tourEls.blocker.classList.contains("hidden");
}

async function getSeenSteps() {
  const { [TOUR_STORAGE_KEY]: seen } = await chrome.storage.local.get(TOUR_STORAGE_KEY);
  return Array.isArray(seen) ? seen : [];
}

async function markStepsSeen(ids) {
  const seen = await getSeenSteps();
  const merged = Array.from(new Set([...seen, ...ids]));
  await chrome.storage.local.set({ [TOUR_STORAGE_KEY]: merged });
}

function positionTourStep() {
  const step = activeSteps[activeIndex];
  const els = buildTourEls();
  const target = document.querySelector(step.selector);
  if (!target || target.offsetParent === null) {
    // alvo não existe ou está invisível nessa tela agora (ex: card ainda não
    // renderizado, ou onEnter não conseguiu revelar o elemento) — pula, em
    // vez de destacar um retângulo zerado em qualquer canto da tela.
    if (activeIndex < activeSteps.length - 1) goToStep(activeIndex + 1);
    else endTour(true);
    return;
  }
  target.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = target.getBoundingClientRect();
  const pad = 6;
  els.spotlight.style.left = `${Math.round(rect.left - pad)}px`;
  els.spotlight.style.top = `${Math.round(rect.top - pad)}px`;
  els.spotlight.style.width = `${Math.round(rect.width + pad * 2)}px`;
  els.spotlight.style.height = `${Math.round(rect.height + pad * 2)}px`;

  els.stepEl.textContent = `${activeIndex + 1}/${activeSteps.length}`;
  els.titleEl.textContent = step.title;
  els.textEl.textContent = step.text;
  els.backBtn.disabled = activeIndex === 0;
  els.nextBtn.textContent = activeIndex === activeSteps.length - 1 ? "Concluir" : "Avançar";

  const bubbleRect = els.bubble.getBoundingClientRect();
  const margin = 10;
  let left = Math.round(rect.left + rect.width / 2 - bubbleRect.width / 2);
  left = Math.max(margin, Math.min(left, window.innerWidth - bubbleRect.width - margin));
  let top = Math.round(rect.top - pad - bubbleRect.height - 10);
  if (top < margin) top = Math.round(rect.bottom + pad + 10);
  top = Math.min(top, window.innerHeight - bubbleRect.height - margin);
  els.bubble.style.left = `${left}px`;
  els.bubble.style.top = `${top}px`;
}

function callStepHook(step, hook) {
  if (step && typeof step[hook] === "function") step[hook]();
}

function goToStep(index) {
  callStepHook(activeSteps[activeIndex], "onExit");
  activeIndex = index;
  callStepHook(activeSteps[activeIndex], "onEnter");
  positionTourStep();
}

function startTour(steps) {
  if (!steps || steps.length === 0) return;
  activeSteps = steps;
  activeIndex = 0;
  const els = buildTourEls();
  els.blocker.classList.remove("hidden");
  els.spotlight.classList.remove("hidden");
  els.bubble.classList.remove("hidden");
  document.getElementById("tourFab")?.classList.add("hidden");
  callStepHook(activeSteps[activeIndex], "onEnter");
  positionTourStep();
}

async function endTour(markSeen) {
  callStepHook(activeSteps[activeIndex], "onExit");
  if (markSeen) await markStepsSeen(activeSteps.map((s) => s.id));
  if (tourEls) {
    tourEls.blocker.classList.add("hidden");
    tourEls.spotlight.classList.add("hidden");
    tourEls.bubble.classList.add("hidden");
  }
  document.getElementById("tourFab")?.classList.remove("hidden");
}

function startFullTour() {
  startTour(TOUR_STEPS);
}

async function startAutoTourIfNeeded() {
  const seen = await getSeenSteps();
  const unseen = TOUR_STEPS.filter((s) => !seen.includes(s.id));
  if (unseen.length > 0) startTour(unseen);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("tourFab")?.addEventListener("click", startFullTour);
  startAutoTourIfNeeded();
});

window.IcarusTour = { startFullTour, startAutoTourIfNeeded };
