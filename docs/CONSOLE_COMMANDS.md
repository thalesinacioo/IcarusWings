# Comandos de teste pelo console

Como usar: abra o painel lateral da extensão, clique com o botão direito em qualquer lugar dele → **Inspecionar**, vá na aba **Console** e cole o comando. Todas essas funções já existem soltas em `sidepanel.js` (sem módulos/exports), então ficam acessíveis direto no console da página do painel — não precisa de nenhum "modo dev" especial.

Comandos marcados com ⚠️ dependem de `chrome.*`/`IcarusAPI` de verdade (só funcionam dentro da extensão real, carregada via `chrome://extensions`, não num preview estático fora dela).

## Tooltips (balão escuro instantâneo)

| Comando | O que faz |
|---|---|
| `initTooltips()` | Liga o sistema de tooltips (hover/foco em qualquer elemento com `data-tooltip`). Já roda sozinho no boot — só precisa chamar de novo se estiver testando fora do fluxo normal. |
| `showTooltip(document.querySelector('#refreshBtn'))` | Mostra na hora o tooltip de um elemento específico (troque o seletor por qualquer coisa com `data-tooltip`, ex: `.legend-swatch.red`, `#abonoEstimadoBox`). |
| `hideTooltip()` | Esconde o tooltip que estiver visível no momento. |

## Balão de status / notificações flutuantes (saem do botão Atualizar)

| Comando | O que faz |
|---|---|
| `showStatus("Buscando na aba do Icarus…", "info", 3000)` | Mostra um aviso verde-claro que some sozinho depois de 3000ms (3ª argumento = tempo em ms; omitir = fica até fechar). |
| `showStatus("Erro ao buscar: teste", "error")` | Mostra um aviso vermelho-claro, com botão "✕" (fica até clicar em fechar). |
| `hideStatus()` | Esconde o aviso de status atual. |
| `showUpdateNotice("9.9.9", "https://github.com/thalesinacioo/IcarusWings/releases")` | Mostra o aviso de "Nova versão disponível" com link clicável, empilhado junto dos outros avisos. |
| `hideNotificationRow("update")` | Fecha só o aviso de nova versão (a chave `"status"` fecha o de status). |
| `showNotificationRow("teste", { text: "Qualquer coisa", type: "info", closable: true })` | Cria um aviso genérico avulso (pra testar o empilhamento com 3+ avisos ao mesmo tempo). |

## Popup de configurações (engrenagem)

| Comando | O que faz |
|---|---|
| `openSettingsPopup()` | Abre o popup da engrenagem (checkboxes de almoço/8:48, botão de férias, versão). |
| `closeSettingsPopup()` | Fecha o popup. |
| `toggleSettingsPopup()` | Alterna aberto/fechado. |

## Animações dos botões

| Comando | O que faz |
|---|---|
| `playBaterPontoSuccessAnimation()` | Toca a animação de sucesso do botão "Bater o ponto agora!" (texto vira 👍 por 2s) — sem registrar ponto de verdade. |
| `playRefreshSuccessAnimation()` | Toca a animação do botão "Atualizar" (pisca verde, mostra ✓ por 3s, volta ao ⟳) — sem buscar dados de verdade. |

## Modais

| Comando | O que faz |
|---|---|
| `showConfirm("Mensagem de teste", { title: "Título", okLabel: "Confirmar", cancelLabel: "Cancelar" })` | Abre o modal de confirmação genérico. Retorna uma Promise que resolve `true`/`false` conforme o botão clicado. |
| `closeConfirm(true)` / `closeConfirm(false)` | Fecha o modal de confirmação como se tivesse clicado em OK/Cancelar. |
| `openPunchTimeModal("2026-09-17", 2, "1ª saída (almoço)", "12:10")` | Abre o modal de horário aproximado pra uma batida (params: `dateKey`, `seq`, `label`, horário existente ou `null`). |
| `closePunchTimeModal()` | Fecha o modal de horário sem salvar. |
| `savePunchTimeModal()` | Salva o que estiver digitado no campo do modal (equivalente a clicar "Salvar"). |
| `clearPunchTimeInput()` | Limpa o campo de horário do modal (equivalente ao botão "✕" dentro dele). |
| `openFeriasFolgasModal()` | Abre o modal de "+ Férias / Folgas / Abono". |
| `closeFeriasFolgasModal()` | Fecha o modal de férias/folgas. |
| `saveFeriasFolgasModal()` | Salva o período preenchido no modal de férias/folgas. |

## Calendário

| Comando | O que faz |
|---|---|
| `renderCalendar()` | Redesenha a grade do calendário com o que já estiver em `registrosPorDia`/`pendingAdjustments` (sem buscar nada novo). |
| `selectDay(new Date(2026, 8, 16))` | Seleciona um dia específico no calendário (mês é 0-indexado: 8 = setembro) — atualiza "Batidas de..." pra esse dia. |
| `loadMonth()` ⚠️ | Recarrega o mês atual (`currentMonth`/`currentYear`): redesenha o calendário e dispara buscas reais (Flexibilização + Icarus). |
| `currentMonth++; loadMonth();` | Avança um mês e recarrega tudo (é o que os botões ‹ › fazem). |

## Painel do dia / ajustes pendentes

| Comando | O que faz |
|---|---|
| `renderDayPanel()` | Redesenha o cartão "Batidas de hoje" (ou do dia selecionado) com o que já estiver em cache. |
| `IcarusAPI.removePendingAdjustment("2026-09-17", 2)` ⚠️ | Remove de vez um ajuste manual pendente daquele dia/posição (equivalente ao "✕" na lista). |
| `IcarusAPI.resolvePendingDeletion("2026-09-17", 123456)` ⚠️ | Cancela uma exclusão pendente (a batida volta a aparecer normal). |
| `IcarusAPI.setPendingAdjustmentDone("2026-09-17", 2, true)` ⚠️ | Marca/desmarca "já ajustei no Icarus" (risca o texto) num ajuste manual. |
| `IcarusAPI.setPendingDeletionDone("2026-09-17", 123456, true)` ⚠️ | Marca/desmarca "já conferi" numa exclusão pendente. |

## Flexibilização do mês

| Comando | O que faz |
|---|---|
| `showFlexibilizacaoInstant()` | Recalcula e redesenha Saldo de Horas / Abono estimado / Horas do Mês / período+teto, a partir do mês em exibição (`currentMonth`/`currentYear`) e do que já estiver em cache. |
| `fetchFlexibilizacao()` ⚠️ | Igual acima, mas também busca dados novos na aba do Icarus. |

## Diversos

| Comando | O que faz |
|---|---|
| `tickLive()` | Recalcula "Trabalhado hoje" / "Falta trabalhar" e as previsões de horário das próximas batidas (roda sozinho a cada minuto). |
| `checkForUpdate()` ⚠️ | Confere a versão instalada contra a última release do GitHub; se houver uma mais nova, atualiza o popup da engrenagem e dispara `showUpdateNotice(...)` sozinho. |
| `loadNomeColaborador()` ⚠️ | Recarrega o nome do colaborador exibido na barra superior. |

## Simular dados de teste (sem depender da extensão)

Pra testar visualmente sem uma aba do Icarus de verdade, popule os dados direto e redesenhe:
```js
const todayKey = dateKey(new Date());
registrosPorDia[todayKey] = {
  pontosHorariosBatidasOrdenados: [
    { horario: new Date().setHours(8, 6, 0, 0), horarioFormatadoSemData: "08:06", marcacaoFmt: "Entrada" },
  ],
};
pendingAdjustments[todayKey] = [
  { seq: 2, label: "1ª saída (almoço)", clickedAt: Date.now(), approxTime: "12:10" },
];
renderCalendar();
renderDayPanel();
```
