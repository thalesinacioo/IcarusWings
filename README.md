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
- **Notas** — adiciona uma nota/anotação real no Icarus pra um dia
- **Lembretes de bater ponto** (notificação do navegador, mesmo com o
  painel fechado) nos horários padrão 08:00 / 12:00 / 13:00 / 17:00.
  Só aparece se aquela batida ainda não foi feita — se você já bateu
  antes do horário (ex.: voltou do almoço em 30min), o lembrete nem
  aparece.
  - Botão **"Ajustar depois"** na notificação: marca aquele horário como
    pendente (cinza) em vez de te interromper.
- **Horário aproximado de batida faltante** — se uma batida esperada
  está atrasada (ou se você clicar num slot vazio), a extensão te
  pergunta a que horas ela aconteceu de verdade e guarda isso em cinza no
  painel/calendário, como lembrete visual de que ainda falta ajustar
  aquilo de verdade no Icarus.

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
| **Bater Ponto** (real) | endpoint ainda não capturado — falta clicar uma vez no botão real com a extensão observando o tráfego |
| **Registrar Ponto / Ajuste de Ponto** | formulário mapeado, envio não testado (gera solicitação real de aprovação pro gestor) |
| **Justificar (Abono)** | idem acima |
| Heurística de "ajuste manual" no calendário | já confirmada contra dados reais (`ponto.temAbonoOuAjusteRegistrado`) |

### Como destravar as ações pendentes

`inject.js` já observa passivamente todo tráfego pra
`backendicarus.pontoicarus.com.br`. Basta usar a função normalmente **uma
vez** direto no site (com a extensão instalada): a URL e o método
aparecem na aba **"Depuração — endpoints observados"** do painel. A
partir daí, dá pra automatizar via clique real no botão (mesmo padrão de
`uiAddNota` em `inject.js`), sem nunca precisar adivinhar payload.

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
api.js + sidepanel.js → UI: calendário, painel do dia, notas, lembretes
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
