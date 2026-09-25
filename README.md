# IcarusWings

![Painel Ponto Icarus](docs/screenshot.png)

[Glossário de UI/UX do painel](https://claude.ai/artifact/SgRp8FNLiHYsce8GjiGkHZ?sk=4h8lWiYWX7Ta9_4Qx3gmgQ)

Extensão de Chrome (painel lateral) que te dá uma visão rápida e prática
do seu ponto no [Ponto Icarus](https://web.pontoicarus.com.br/ponto) —
calendário do mês, batidas do dia, saldo de horas e lembretes — sem
precisar ficar entrando no site toda hora.

## Por que existe

O Icarus não tem uma API pública nem um app com notificações úteis. Esta
extensão resolve isso ficando "por cima" do próprio site: ela não
reimplementa a API dele (não temos acesso a isso, nem deveríamos), ela só
automatiza a interface que você já usa manualmente — de um jeito que
**nunca lê, pede ou armazena seu usuário/senha**.

## O que a extensão faz hoje (e onde encontrar cada coisa)

### Tour guiado (onboarding)

Na primeira instalação (e de novo sempre que uma atualização trouxer
recursos novos) a extensão abre um tour passo a passo, destacando cada
feature do painel com uma explicação curta — navegue com **Avançar**/
**Voltar**, ou saia a qualquer momento com **Pular tour**. Um update que só
adiciona um recurso novo mostra **só o passo novo**, não o tour inteiro de
novo. Pra rever o tour completo quando quiser, clique no botão 🪽 fixo no
canto inferior direito do painel.

### Barra superior

- **Nome do colaborador** — aprendido sozinho na primeira vez que a aba do
  Icarus carrega, sem você digitar nada.
- **Botão Atualizar (⟳)** — busca dados novos na aba do Icarus na hora.
  Ao terminar, o próprio botão pisca verde e mostra um ✓ por 3 segundos
  (não usa mais um aviso separado pra isso).
- **Botão de engrenagem (⚙)** — abre um popup com:
  - Checkbox "Faço intervalo de 1h no almoço"
  - Checkbox "8:48 hoje" (mirar na jornada contratada cheia hoje, em vez de
    usar o abono diário — ver "Flexibilização do mês" abaixo)
  - Checkbox "Eu trabalho 6:00h/dia" (jornada reduzida, sem abono — ver
    "Flexibilização do mês" abaixo)
  - "+ Férias / Folgas / Abono" — marca um período no calendário (rosa),
    só visual, não manda nada pro Icarus
  - A versão instalada da extensão, com aviso de nova versão disponível
    quando houver uma
  - A largura desse popup acompanha o tamanho do painel, então ele nunca
    fica desproporcional se você redimensionar o side panel.

### Botão "Bater o ponto agora!"

Clica no botão real de "Registrar Ponto" da tela do Icarus, no horário
atual — pede confirmação antes (é uma ação real e irreversível). Ao
concluir com sucesso, o texto do botão dá lugar a um 👍 por 2 segundos,
com uma animação, antes de voltar ao normal.

### Calendário do mês

Colorido por dia:
- 🟢 verde — dia com horas trabalhadas
- 🔴 vermelho — falta ou inconsistência apontada pelo próprio Icarus
- 🟣 roxo — dia com ajuste manual ou abono já registrado no Icarus
- 🩷 rosa — férias/folga/abono marcado manualmente (só visual)
- ⬜ cinza — feriado
- 🟠 ponto laranja no canto — dia com um "ajuste pendente" só da extensão
  (ver abaixo)

A legenda abaixo do calendário é só quadradinhos coloridos, sem texto —
passe o mouse em cada um pra ver o que aquela cor significa.

### Painel "Batidas de hoje" (ou de um dia selecionado)

Clique num dia do calendário pra ver os detalhes dele no mesmo lugar, sem
popup — o título mostra o dia da semana por extenso (ex.: "Batidas de
quarta-feira, 16/09").

- as 4 batidas (1ª a 4ª), com asterisco/roxo pra batidas que foram ajuste
  manual no Icarus (mostra o motivo escrito no ajuste) — essas sempre vêm
  direto do Icarus, é a fonte da verdade do horário real
- trabalhado / intervalo / falta trabalhar — de **qualquer dia**, não só
  hoje, sempre calculado a partir das batidas + ajustes anotados na
  extensão, nunca do total pronto do Icarus (que pode não bater com a meta
  que você está mirando naquele dia — ver "8:48 hoje" abaixo). Quando é
  hoje, é **ao vivo**: se o turno está aberto (número ímpar de batidas),
  conta o tempo corrido desde a última batida; o intervalo soma só as
  pausas entre batidas (ex.: o almoço), nunca o trecho ainda em aberto
- previsão de horário de saída (em cinza, "~HH:MM") na 4ª batida, enquanto
  ela ainda não aconteceu de verdade — some assim que a batida real (ou
  pendente) ocupar o lugar
- tags do dia (falta, inconsistente, ajuste/abono, ajustes pendentes)
- nota do dia, se houver
- **lista de ajustes pendentes** — cada um tem um "✕" pra remover de vez
  (o slot volta a aparecer como batida não registrada), além do checkbox
  "já conferi"/"já ajustei no Icarus" que só risca o texto

### Card "Flexibilização do mês"

Essa é a parte que mais gera dúvida, então vamos com calma, do zero:

A jornada contratada é **8h48/dia**, mas o RH dá um abono fixo de
**48min/dia** que perdoa a diferença se você trabalhar só 8h — sem
descontar salário nem banco de horas. É uma escolha sua, dia a dia: pode
mirar em 8h (usando o abono) ou nos 8h48 completos (e aí guardar essa
diferença como folga). Só que esse abono tem um limite mensal, senão
alguém poderia "usar" ele todo santo dia: no Icarus, seu "período de
apuração" não é o mês do calendário — vai do dia **26 de um mês até o dia
25 do mês seguinte** —, e o limite (**teto**) é somado dentro desse
período.

O teto é calculado assim: **48 minutos × quantidade de dias úteis do
período**. Por exemplo, num período com 22 dias úteis, o teto é
22 × 48min = 17h36min de abono disponíveis pra usar no mês inteiro.

No card você vê:
- **Teto Abono Mês** — o limite calculado pro período que está sendo
  exibido no calendário (se você navegar pro mês passado ou pro próximo,
  o card recalcula sozinho pra aquele período).
- **Saldo de horas** — vem direto do próprio Icarus (campo já calculado
  por ele, que leva em conta a flexibilidade de 10min de entrada/saída que
  a extensão não tem como reproduzir sozinha).
- **Abono estimado** — o máximo de horas de abono que você pode usar até
  agora: soma de 48min por dia útil já decorrido no período, limitado ao
  teto do mês inteiro.

Passe o mouse em "Saldo de horas" pra ver uma nota explicando de onde vem
esse valor.

**Trabalha 6h/dia?** Quem tem jornada reduzida não tem direito a abono.
Marcando "Eu trabalho 6:00h/dia" nas configurações (⚙): o Teto e o Abono
estimado ficam zerados, e a previsão de saída passa a considerar 3h de
trabalho antes do almoço e 3h depois (em vez de 4h+4h). O checkbox é
exclusivo com "8:48 hoje" — marcar um desmarca o outro.

### Avisos flutuantes (balões)

Toda mensagem de status (busca em andamento, erro, nova versão
disponível) aparece como um balão colorido saindo do botão de onde ela se
originou — **Atualizar** pros avisos de busca/erro, **engrenagem** pro
aviso de nova versão — com uma setinha indicando de qual botão ele veio.
Se tiver mais de um ao mesmo tempo, eles empilham um abaixo do outro,
sempre alinhados pela borda direita. Avisos rápidos (tipo "buscando...")
somem sozinhos; os demais ficam até você clicar no "✕".

### Erros de busca (e detecção de "não logado")

Se a busca falhar, o balão diz a causa específica em vez de um erro
genérico — por exemplo "Você não está logado no Icarus" (com um link
"Clique aqui pra fazer login" que foca a aba do Icarus na sua janela
atual, sem logar sozinho), "A aba do Icarus não está na tela de Registro
de Ponto", ou "O Icarus pode ter mudado o layout". Assim que uma busca
funcionar de novo, o aviso some sozinho.

### Lembretes de bater ponto

Notificação do navegador, mesmo com o painel fechado — só pras batidas
**2ª, 3ª e 4ª** (saída/volta do almoço, saída final). O horário previsto
de cada uma é calculado a partir do horário **real** da sua 1ª entrada
(mais a meta do dia — 8h ou 8h48 — e o intervalo de almoço configurado),
não um horário fixo de relógio. Avisa 10 e depois 5 minutos antes do
horário previsto, discretamente (sem travar a tela) — e só se aquela
batida ainda não tiver acontecido.

Não existe mais lembrete pra 1ª entrada — ela pode acontecer a qualquer
hora, sem avisos repetidos.

### Exclusão pendente de batida

Clique numa batida real do cartão pra marcar como "pendente de
exclusão": ela some do cartão na hora (a próxima batida ocupa o lugar
dela) e passa a aparecer na lista de ajustes pendentes, com um checkbox
"já conferi" (só risca o texto, não tira da lista) e um botão pra
cancelar. Não mexe no Icarus — é só um lembrete até você solicitar a
exclusão de verdade no site; some de vez sozinho quando o gestor aprovar
e a batida sumir dos dados do Icarus.

### Horário aproximado de batida faltante

Se uma batida esperada está atrasada (ou se você clicar num slot vazio),
a extensão te pergunta a que horas ela aconteceu de verdade. Ao digitar o
horário, calcula em tempo real quanto você já trabalhou e quanto ainda
falta — marcando em laranja no painel/calendário como lembrete visual de
que ainda falta ajustar aquilo de verdade no Icarus. Limpar o campo e
salvar remove o ajuste pendente de vez.

### Confirmações dentro do painel

Registrar ponto, marcar ou cancelar uma exclusão pendente etc. abrem um
modal no próprio painel, nunca uma caixa de diálogo do navegador.

### Painel nunca abre vazio

Guarda os últimos dados vistos e mostra na hora ao reabrir, atualizando
por trás assim que a busca real responde.

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
E ao fechar o painel, a extensão fecha essa aba sozinha — útil pra quem
trabalha com várias janelas do navegador abertas e não quer abas do
Icarus se acumulando espalhadas.

## Como instalar (modo desenvolvedor)

Clone este repositório (ou baixe o ZIP e extraia)

**Via git (recomendado, atualizar depois é só um `git pull`):**
```bash
git clone https://github.com/thalesinacioo/IcarusWings.git
```
Depois, em `chrome://extensions` → "Modo do desenvolvedor" → "Carregar sem compactação" → selecione a pasta clonada. Pra atualizar pra próxima versão, só rode dentro da pasta:
```bash
git pull
```
e recarregue a extensão (ícone ⟳ em chrome://extensions).

**Via Zip**
1. Abra `chrome://extensions`
2. Ative **"Modo do desenvolvedor"** (canto superior direito)
3. Clique em **"Carregar sem compactação"** e selecione a pasta do
   projeto
4. Abra `https://web.pontoicarus.com.br/ponto` e faça login normalmente
5. Clique no ícone da extensão pra abrir o painel lateral

Na primeira vez, deixe a tela de Registro de Ponto carregar por completo
— é assim que a extensão aprende sua matrícula (`idColaborador`), sem
você digitar nada.

Depois de qualquer atualização de código: recarregue a extensão em
`chrome://extensions` (ícone ⟳) e dê F5 na aba do Icarus.

## Como reportar um problema (Issues)

Encontrou algo que não funciona como devia? Abra uma
[issue no GitHub](https://github.com/thalesinacioo/IcarusWings/issues/new)
seguindo esse padrão — quanto mais completo, mais rápido dá pra entender
e corrigir:

1. **O quê** — o que você estava fazendo e o que aconteceu. Seja
   específico: qual botão clicou, em qual tela, o que apareceu (ou não
   apareceu).
2. **Print** — uma captura de tela (ou um vídeo curto) mostrando o
   problema acontecendo. Se for algo que só aparece em certo momento
   (tipo uma notificação), tente capturar bem esse momento.
3. **Resultado esperado** — o que deveria ter acontecido em vez disso, na
   sua visão.

Exemplo de uma boa issue:

> **O quê:** cliquei no botão "Atualizar" e o calendário não mudou,
> mesmo depois de eu ter batido o ponto no site.
> **Print:** [captura da tela mostrando o calendário sem o dia atualizado]
> **Resultado esperado:** o dia de hoje deveria aparecer verde depois de
> clicar em Atualizar.
