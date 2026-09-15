# IcarusWings

Extensão de Chrome (painel lateral) que te dá uma visão rápida e prática
do seu ponto no [Ponto Icarus](https://web.pontoicarus.com.br/ponto) —
calendário do mês, batidas do dia, saldo de horas e lembretes — sem
precisar ficar entrando no site toda hora.

> ⚠️ **Projeto em andamento.** Algumas ações (bater ponto de verdade,
> registrar ajuste/abono) ainda não estão ligadas — veja
> [O que falta](#o-que-falta) abaixo.

## Por que existe

O Icarus não tem uma API pública nem um app com notificações úteis. Esta
extensão resolve isso ficando "por cima" do próprio site: ela não
reimplementa a API dele (não temos acesso a isso, nem deveríamos), ela só
automatiza a interface que você já usa manualmente — de um jeito que
**nunca lê, pede ou armazena seu usuário/senha**.

## O que a extensão faz hoje

- **Calendário do mês**, colorido por dia:
  - 🟢 verde — dia com horas trabalhadas
  - 🔴 vermelho — falta ou inconsistência apontada pelo próprio Icarus
  - 🟣 roxo — dia com ajuste manual ou abono já registrado no Icarus
  - ⚪ ponto cinza no canto — dia com um "ajuste pendente" só da extensão
    (ver abaixo)
- **Painel do dia** (por padrão mostra hoje; clique num dia do calendário
  pra ver os detalhes dele no mesmo lugar, sem popup):
  - as 4 batidas (1ª a 4ª), com asterisco/roxo pra batidas que foram
    ajuste manual no Icarus (mostra o motivo escrito no ajuste)
  - trabalhado / falta trabalhar — **ao vivo**, quando é hoje: se o turno
    está aberto (número ímpar de batidas), conta o tempo corrido desde a
    última batida
  - tags do dia (falta, inconsistente, ajuste/abono, ajustes pendentes)
  - nota do dia, se houver
- **Registrar Ponto** — clica no ícone real de registrar ponto da tela do
  Icarus (com confirmação antes, já que é uma ação real e irreversível),
  confirma o modal "Deseja realmente efetuar a batida de ponto?" e
  atualiza o painel logo em seguida. **Testado contra a página real em
  15/09/2026.**
- **Lembretes de bater ponto** (notificação do navegador, mesmo com o
  painel fechado) nos horários padrão 08:00 / 12:00 / 13:00 / 17:00.
  Só aparece se aquela batida ainda não foi feita — se você já bateu
  antes do horário (ex.: voltou do almoço em 30min), o lembrete nem
  aparece.
  - Botão **"Ajustar depois"** na notificação: marca aquele horário como
    pendente (laranja) em vez de te interromper.
- **Horário aproximado de batida faltante** — se uma batida esperada
  está atrasada (ou se você clicar num slot vazio), a extensão te
  pergunta a que horas ela aconteceu de verdade. Ao digitar o horário,
  calcula em tempo real quanto você já trabalhou e quanto ainda falta —
  marcando em laranja no painel/calendário como lembrete visual de que
  ainda falta ajustar aquilo de verdade no Icarus.

## Como funciona por baixo (sem tocar em credenciais)

Tentamos, a princípio, fazer a extensão chamar a API do Icarus
diretamente (`fetch`). O Chrome bloqueou — o backend exige um token que o
próprio app do Icarus gerencia sozinho (lido do `localStorage` dele). Ler
esse token nós mesmos seria exatamente o tipo de dado sensível que esta
extensão se recusa a tocar.

Por isso a extensão **aciona os elementos reais da tela** do Icarus
(preenche o período e clica em "Pesquisar", clica em "Notas" e preenche o
formulário, etc.) — é o próprio Icarus que autentica essas ações, com o
token dele. Em paralelo, a extensão só **observa passivamente** as
respostas que o site já recebe, pra extrair os dados pro painel.

Você não precisa abrir/gerenciar essa aba: quando o painel (ou um
lembrete) precisa de dados e não há nenhuma aba do Icarus aberta, a
própria extensão abre uma, fixada e em segundo plano, sem tirar seu foco.

## Como instalar (modo desenvolvedor)

1. Clone este repositório (ou baixe o ZIP e extraia)
2. Abra `chrome://extensions`
3. Ative **"Modo do desenvolvedor"** (canto superior direito)
4. Clique em **"Carregar sem compactação"** e selecione a pasta do
   projeto
5. Abra `https://web.pontoicarus.com.br/ponto` e faça login normalmente
6. Clique no ícone da extensão pra abrir o painel lateral

Na primeira vez, deixe a tela de Registro de Ponto carregar por completo
— é assim que a extensão aprende sua matrícula (`idColaborador`), sem
você digitar nada.

Depois de qualquer atualização de código: recarregue a extensão em
`chrome://extensions` (ícone ⟳) e dê F5 na aba do Icarus.

## O que falta

| Ação | Status |
|---|---|
| **Registrar Ponto** (real) | ✅ testado contra a página real (15/09/2026) — o botão real é um ícone sem texto no topo (tooltip "Registrar Ponto", diferente do botão de mesmo nome da tela de pesquisa), que abre o modal "Deseja realmente efetuar a batida de ponto?" com botão "Sim" |
| **Excluir/editar batida existente** | automação (`removerBatida` em `inject.js`/`api.js`) já mapeada e com 3 bugs corrigidos no teste ao vivo (ver abaixo), mas a **UI foi removida temporariamente** (sem lápis/popup no painel) — o Icarus **exige um número par de registros por dia** (mensagem real: *"A quantidade de registros de pontos precisa ser par"*), então excluir só 1 batida de um dia com 2 não funciona sozinho; falta decidir a UX certa pra isso (ex.: exigir excluir em pares, ou editar em vez de excluir) antes de reativar |
| **Notas** | automação (`addNota`) mantida em `inject.js`/`api.js`, mas sem botão na UI por enquanto (removido junto com o card de ações) |
| **Justificar (Abono)** | mapeado o primeiro passo (mesmo modal "O Que Deseja Solicitar?"), fluxo completo não testado |
| Heurística de "ajuste manual" no calendário | já confirmada contra dados reais (`ponto.temAbonoOuAjusteRegistrado`) |

### Bugs corrigidos no teste ao vivo da exclusão de batida (15/09/2026)

1. **`api.js`** — quando `inject.js` retornava `ok:false` (erro), o código sempre
   **resolvia a promise como sucesso**, nunca rejeitava. Qualquer erro real
   ficava engolido em silêncio (aparecia como "nada aconteceu" no painel).
2. **`inject.js` — `findButtonByText`** — só olhava `textContent`. Botões de
   ação da linha ("Notas", "Justificar Ponto", "Reprocessar Ponto") **não
   têm texto nenhum**, só ícone com tooltip no atributo `title`. Corrigido
   pra cair no `title`/`aria-label` quando o texto não bate.
3. **`inject.js` — `findAjusteRegistroRow`** — exigia um nó-folha
   (`children.length === 0`) pra achar o horário do registro, mas ele fica
   num `<td class="p-editable-column">` com 1 filho. Corrigido.
4. **Textarea errada** — o campo de Justificativa do Icarus é um MUI
   multiline com **dois** `<textarea>` no DOM: o real (`name="justificativa"`)
   e um `aria-hidden`/`readonly` só pra medir altura (auto-resize). Pegar
   "o último textarea da página" pegava o errado. Corrigido pra mirar
   `textarea[name="justificativa"]`.

### Como destravar as ações pendentes

`inject.js` já observa passivamente todo tráfego pra
`backendicarus.pontoicarus.com.br`. As ações de "Registrar Ponto" e
"Justificar" já seguem o mesmo padrão: clicam os botões reais da página
(sem nunca precisar adivinhar payload ou ler token).

## Arquitetura (resumo)

```
inject.js          (mundo principal da aba do Icarus)
                    → intercepta fetch/XHR pra observar respostas reais
                    → executa ações clicando nos elementos reais da página
        ↕ postMessage
content-bridge.js  (mundo isolado da aba)
                    → repassa mensagens entre a página e a extensão
        ↕ chrome.runtime
background.js      (service worker)
                    → roteia mensagens, guarda estado (registros, pendências)
                    → agenda os lembretes (chrome.alarms) e as notificações
        ↕ chrome.runtime
api.js + sidepanel.js → UI: calendário, painel do dia, lembretes
```

Nenhuma credencial passa por `background.js` nem por `sidepanel.js` — só
o `idColaborador` (a matrícula, não é segredo) e os dados de ponto em si,
que já são visíveis pra você na tela do site.

## Estrutura dos arquivos

```
manifest.json         Configuração da extensão (MV3)
inject.js              Mundo principal da aba — observa e age na página real
content-bridge.js      Ponte entre a aba e a extensão
background.js          Service worker — roteamento, lembretes, storage
api.js                 Wrapper usado pelo painel pra falar com o resto
sidepanel.html/css/js  Interface do painel lateral
icons/                 Ícones da extensão
```
