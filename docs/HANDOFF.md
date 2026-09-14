# Air-Deck — passagem de contexto (14/09/2026)

Documento para retomar o trabalho em uma sessão nova sem perder nada. Descreve onde o projeto está, por que as coisas são como são, o que os testes com câmera real mostraram e o que falta.

> Nada foi commitado ainda. Todo o código abaixo está no working tree (`git status` mostra tudo como não rastreado, exceto README e .gitattributes).

---

## 1. O produto

Air-Deck transforma um PDF em apresentação controlada por gestos da mão, 100% no navegador (sem backend, sem upload). Público: professores e palestrantes. Deploy previsto na Vercel. O app deve parecer uma **ferramenta em tela cheia**, não um site — o portfólio do autor vai linkar para ela.

Prioridades declaradas pelo usuário, em ordem: **fluidez/baixa latência**, **elegância**, **não misturar funções** (um gesto nunca pode disparar outro), **acessibilidade** (não exigir precisão da mão, que treme).

Idioma: toda a UI em pt-BR. Identidade visual em `brand/` (kit em `brand/brand-kit.html`, tokens em `brand/tokens.css`, importados pelo app).

## 2. Stack e como rodar

- Vite 8 + React 19 + TypeScript 6, `motion` (Framer Motion) para animações.
- `@mediapipe/tasks-vision` 1.0.1 (Hand Landmarker) rodando num **Web Worker** (`src/workers/hands.worker.ts`), com fallback para a thread principal.
- `pdfjs-dist` 6 para renderizar páginas em `ImageBitmap`.
- Modelo da mão servido pelo próprio app: `public/models/hand_landmarker.task` (7,8 MB).
- Testes: Vitest (`npm test`), 48 testes em `src/lib/gestures.test.ts` e `src/lib/shapes.test.ts`.

```bash
npm install
npm run dev      # o usuário roda em http://localhost:5173
npm test
npm run build    # tsc -b && vite build
```

## 3. Mapa do código

| Arquivo | Papel |
|---|---|
| `src/App.tsx` | Alterna entre Home e Presenter |
| `src/components/Home.tsx` | Tela inicial em tela cheia: soltar PDF, prévia, lista de gestos, abrir treino |
| `src/components/Presenter.tsx` | Apresentação: slides, zoom (spring), tinta, HUD, menu, teclado, mouse |
| `src/components/Trainer.tsx` | Modal de registro da mão (3 passos) + treino com desafios |
| `src/components/ToolMenu.tsx` | Menu de ferramentas + `MenuDwell` (apontar e segurar) + `menuOptionAt` |
| `src/components/Hud.tsx`, `SettingsPanel.tsx`, `HelpDialog.tsx`, `GestureCards.tsx`, `SlideCanvas.tsx`, `Icon.tsx`, `Brand.tsx` | UI de apoio |
| `src/lib/gestures.ts` | **Motor de gestos**: classificação de pose, máquina de estados, constantes `GESTURE` |
| `src/lib/controller.ts` | Liga saída do motor ao cursor, à tinta e às ações do host; seleção/edição de formas; chips de forma |
| `src/lib/shapes.ts` | Reconhecimento de formas, alças, mover/redimensionar, forma a partir de caixa |
| `src/lib/ink.ts` | Camada de tinta em unidades do slide (acompanha zoom), por página; desenha seleção, alças e chips |
| `src/lib/overlay.ts` | Camada de tela: cursores (laser, lupa, caneta, borracha), chevrons de deslize, anel de segurar, marcador de zoom |
| `src/lib/tracker.ts` | Câmera + worker compartilhados (ref-count), `requestVideoFrameCallback`, estatísticas de latência |
| `src/lib/oneEuro.ts` | One Euro Filter + `PointSmoother` (zona morta suave, velocidade para extrapolação) |
| `src/lib/pip.ts` | Miniatura da câmera com a mão desenhada no estilo da marca |
| `src/lib/prefs.ts` | Preferências e perfil da mão no `localStorage` |
| `src/lib/glyphs.ts` | Ícones de gestos (SVG) e atalhos de teclado |
| `src/lib/debug.ts` + plugin em `vite.config.ts` | Log de diagnóstico (só em dev) para `debug/session.jsonl` |

## 4. Vocabulário de gestos atual (v4 + formas editáveis)

| Gesto | Ação |
|---|---|
| 1 dedo (indicador) | Ferramenta do dedo escolhida no menu: **Laser** (padrão), **Zoom** (lupa que segue o dedo) ou **Borracha** (maior, apaga o traço/forma inteiro que toca) |
| Pinça polegar + indicador | **Caneta** com estabilizador. Traço reto (≥ 6% da largura do slide) vira linha limpa ao soltar ou ao segurar parado |
| Pinça polegar + médio | **Retângulo**: arrastar de canto a canto, ou dar a volta (vira a caixa do traço) |
| Pinça polegar + anelar | **Círculo/elipse**: arrastar de canto a canto como o retângulo (a elipse preenche a caixa; mudado a pedido do usuário, antes o início era o centro), ou dar a volta (ajuste de elipse por mínimos quadrados, completa volta não fechada; só vira círculo perfeito se razão ≥ 0,9) |
| Pinça polegar + mindinho | **Seta**: nasce onde a pinça começou, ponta onde soltou (encaixa na horizontal/vertical a 6°) |
| Polegar para baixo parado 0,9 s | **Limpar** a tinta do slide (Z desfaz) |
| Polegar para cima 0,8 s | **OK global** (`ThumbsUpHold` em `gestures.ts`, compartilhado). No treino aperta o botão principal da etapa (Continuar/Pular, Continuar ou Usar padrão no alcance, Concluir treino, Voltar à apresentação), que enche enquanto segura. Na apresentação fecha o que estiver aberto (menu, ajuda, ajustes), com anel "OK"; sem nada aberto não arma. Precisa baixar o polegar para confirmar de novo. Evento `thumbs-up` no log |
| Três dedos para cima parados 0,8 s | **Desfazer** (tinta: traço, forma, ajuste de alça, borracha em uma passada, limpeza; histórico por slide, 60 passos). Anel "Desfazer"; só arma com algo para desfazer. Leitura estrita: dedos claramente esticados, mindinho bem dobrado, apontando para cima (±35°). Mindinho meio dobrado com o polegar na ponta é a pinça da seta |
| Quatro dedos para cima, polegar dobrado, 0,8 s | **Refazer**. Palma aberta (polegar para fora) continua sendo o menu. Teclado: Z desfaz, Y ou Shift+Z refaz |
| Pinça do indicador em alça/contorno da forma recém-desenhada (5 s) | Redimensiona ou move. Os outros dedos sempre desenham, para não agarrar a caixa anterior |
| "Arminha" de dois dedos (indicador + médio) apontando para o lado | Segurar 300 ms (≤ 35° da horizontal): direita avança, esquerda volta. Um slide por vez: precisa relaxar ou mudar de lado para o próximo. Chevron do lado apontado enche durante a espera. Com menu/painel aberto, fecha. Pedido do usuário em 14/09: mão aberta cansava e o deslize/tapa confundia (log: abanar dava 4 avanços em 2 s). Arminha de um dedo continua sendo laser. Evento `nav-point` no log. Risco: laser apontando de lado com o classificador piscando para "two" por 300 ms |
| Palma aberta parada 0,7 s | Abre o menu |
| No menu: apontar e segurar 0,7 s, ou pinça | Escolhe opção: 1 Laser · 2 Zoom · 3 Borracha · 4 Quadro · 5 Limpar tinta |
| Punho subindo/descendo, ou pinça com a outra mão | Zoom no último ponto do laser |
| Duas mãos abertas | Zoom volta a 1× |

Anti-tremor (após teste real em 14/09: "está pegando muito a tremedeira"): `SteadyPoint` em `controller.ts` = pincel preguiçoso + deslize exponencial + assentamento lento quando a mão para. Caneta `PEN_STEADY` (raio 1,1% do menor lado da tela, 40 ms, 260 ms) e suavização [1,2,1] do traço ao soltar; formas e seta `SHAPE_STEADY` (2,2%, 70 ms, 420 ms) e início = média dos primeiros 100 ms. Se ficar "mole" demais, reduzir o raio antes de mexer nos tempos. No mesmo log a separação dos dedos foi ótima (margem 0,45–0,7 palma), mas a pinça do mindinho abria no meio da seta; anelar e mindinho agora só soltam acima de 0,55 palma.

Pinças de forma (médio, anelar, mindinho) apontam com a ponta do indicador, como o laser (antes usavam o meio polegar-dedo, que pulava e caía fora da área de alcance). Elas começam mirando: cursor com anel que enche; segurar parado 350 ms (raio 1,8% da tela) fixa o início e só então a forma é desenhada; soltar antes cancela (`shape-aim-cancelled`).

Enquanto uma pinça de forma está fechada, a prévia da forma limpa aparece ao vivo e o cursor mostra um selo com a forma (como a caneta). Ao soltar, os últimos 180 ms são descartados (abrir os dedos arrasta o ponto da pinça). Chips ○ ▭ ― e o reconhecimento de laço pela caneta foram removidos: cada dedo já diz qual forma é.

Classificação das pinças (`classifyPose`): a ponta mais próxima do polegar precisa estar a < 0,28 palma e 0,08 palma mais perto que a segunda; para médio/anelar/mindinho o indicador tem que estar esticado e nenhum outro dedo dobrado (senão "apontar com o polegar apoiado no médio" virava retângulo). A ferramenta fica travada do começo ao fim do traço. Deslize logo após soltar uma pinça (400 ms) é ignorado. O log registra `pinchGap.<ferramenta>` e `pinchMargin.<ferramenta>` nas estatísticas e `shape-drawn` nos eventos — **nunca testado com mão real: conferir se anelar e mindinho se separam bem na câmera do usuário.**

Teclado: setas/espaço/PageUp-Down navegam, M menu, 1–5 no menu, B quadro, E limpar tinta, Z desfaz limpeza, +/− e 0 zoom, L laser/caneta no mouse, C câmera, T treino, F tela cheia, ? ajuda, Esc sai.

Quadro branco: slide limpo com marca "airdeck" pequena no canto inferior esquerdo (marketing pedido pelo usuário).

## 5. Linha do tempo das decisões (e por quê)

1. **Brainstorm original:** fechar/abrir mão para passar slide, altura da mão para zoom, indicador como laser. Rejeitado pelo usuário: abrir/fechar confunde.
2. **v2:** 2 dedos para cima + apontar para o lado navega, formas desenhadas com o laser, 3 dedos para quadro, 4 dedos para fechar, menu escolhido contando dedos (1–5). Ideias do usuário.
3. **Primeira sessão com câmera real (log):** contagem de dedos se mostrou inviável (ver seção 6). Virou **v4**: deslizar com mão aberta tolerante a oscilação de pose, menu por apontar e segurar (padrão Ultraleap "Hover & Hold" / Vision Pro), formas pela caneta (padrão Freeform/Procreate), 3 e 4 dedos sem ação.
4. **Segunda sessão:** navegação e menu passaram a funcionar. Problema restante: formas. O usuário deixou claro que **não dá para exigir círculo perfeito**: a mão treme e sempre há cauda.
5. **Formas tolerantes + edição:** reconhecimento robusto (várias voltas, cauda aparada por percentis), reconhecimento ao soltar a pinça, forma fica selecionada com alças para ajustar.
6. **Última mudança (não testada com mão real):** chips ○ ▭ ― aparecem após qualquer traço (reconhecido ou não) para o usuário escolher a forma; alças maiores; seleção dura 8 s.

Pesquisa usada: Ultraleap TouchFree (zona de interação, Air Push, Hover & Hold), Apple Vision Pro/Keynote (pinça para desenhar), pesquisa acadêmica de apontar no ar (modo relativo com "embreagem"), Logitech Spotlight (movimento relativo + estabilização), projetos Air-Canvas com MediaPipe.

## 6. Dados das sessões de treino (câmera real do usuário)

**Hardware observado:** webcam anuncia 60 fps mas entrega **30 fps** (33,5 ms entre quadros). Inferência no worker ~9,5 ms; captura → resultado ~16 ms. **A latência que sobra vem da câmera, não do código.** Tremor medido: 0,48% da palma por quadro → suavização "Responsivo".

**Sessão 1 (v2, 185 s):**
- Pose trocou 14 vezes/min; 2 e 3 dedos aparecendo 30 s sem intenção.
- "3 dedos" ligou o Quadro 7 vezes sem querer; menu por contagem escolheu opções erradas (1 no lugar de 3; 5 depois de queda de rastreamento).
- Navegação: 2 avanços, 0 voltar — o deslize era zerado quando a pose oscilava entre 2 dedos e mão aberta.
- Laser gerou 16 formas acidentais; nenhum alvo do laser acertado.
- Caneta subiu 2 vezes porque a pinça foi lida como punho.

**Sessão 2 (v4, ~250 s):**
- Navegação: 4 avanços, 3 voltar; 4 deslizes de retorno ignorados corretamente.
- 0 formas acidentais, 0 quadros acidentais. Laser: 3 alvos em 14 s. Menu por apontar funcionou.
- Formas: de 8 traços soltos, 4 viraram elipse, 4 não foram reconhecidos, nenhum retângulo detectado, 1 ajuste (mover). O "segurar parado" nunca disparou (tremor passava do limite).
- 3 quedas de rastreamento de 0,47–0,8 s, todas com a mão saindo do quadro da câmera.
- Desafio da Borracha travou porque exigia apagar toda a tinta do slide (corrigido).

## 5b. Interface (reformulada em 14/09)

- **Toda a interface em inglês** (portfólio internacional). Documentos internos continuam em pt-BR.
- **Direção visual "papel e marcador":** fundo quadriculado (`.paper`), folhas com sombra, títulos em Bricolage condensada, anotações desenhadas à mão que se animam (`src/components/Scribble.tsx`: elipse, sublinhado, caixa, seta, check). Ícones de gesto com mão a lápis (grafite) e ação em âmbar. Palco escuro só na apresentação; menu, ajustes e ajuda são folhas de papel sobre o palco.
- **Início:** título com "hands" circulado, folha de soltar PDF com slide de demonstração que se anota sozinho (`SlideDemo.tsx`, aparece quando a folha tem ≥ 660 px), lista de gestos numerada numa folha à direita (duas colunas quando larga), passos 1-2-3 riscados ao concluir, "Continuar de onde parou".
- **Treino:** tela de papel inteira; passos no topo com o atual circulado; na prática, trilha de 14 marcadores + cartão do desafio atual (sem lista com rolagem) + "Up next".
- **Persistência:** `prefs.ts` guarda `onboarded`, `pointerTool`, perfil validado; progresso do treino em `airdeck:practice:v1`; último PDF e slide no IndexedDB (`src/lib/recent.ts`, até 80 MB); "Delete my data" apaga tudo. O treino de primeira vez aparece uma vez só.
- **Cor da tinta "Auto" (padrão):** `src/lib/contrast.ts` mede o brilho de cada slide e usa âmbar em slides escuros e vermelhão `#E5432A` em claros (laser incluído).
- **Laser parado:** a projeção pela velocidade some e o deslize fica mais lento quando a mão está parada (`REST_FOLLOW_MS` em `overlay.ts`), para não tremer.
- **Capturas automáticas:** script CDP com Chromium sem janela e câmera falsa (estava no scratchpad da sessão; recriar se precisar).

## 6a. Alcance (corrigido em 14/09)

Log: área salva com 36% da largura da câmera e 85% da altura (x 0,64–1,0). Um passo pequeno para o lado jogava o cursor para a borda. Causas e correções:
- Só gravava amostras na pose "apontar"; ao ir para um lado o punho gira e a pose cai. Agora grava a ponta do indicador sempre que há mão.
- Encolhia duas vezes (percentis 4–96% e ×0,84). Agora só percentis 3–97%.
- `balanceReach` (em `gestures.ts`) aumenta o lado curto da área até a sensibilidade horizontal e vertical ficarem iguais para a câmera e a tela atuais. O motor aplica a cada quadro, então perfis antigos e o padrão também são corrigidos. O treino mostra a área já equilibrada e dá dicas ("vá mais para os lados"). Pronto exige 30% de largura e 20% de altura.

## 6b. Ajuste de latência (confirmado pelo usuário: "ficou muito melhor")

Log mostrou câmera ~37 fps, captura→resultado 15 ms, zero quadros descartados: o atraso estava no filtro e no cursor. Mudanças:

- `SMOOTHING` em `src/lib/oneEuro.ts`: Responsivo 6 Hz / β 0,12 / antecipação 24 ms; Equilibrado 3,5 Hz / β 0,06 / zona morta 0,0004 / 16 ms; Estável 1,8 Hz / β 0,025 / 0,0012 / 8 ms.
- `PointSmoother` usa `dCutoff` 3 Hz (era 1 Hz) para o filtro abrir logo no início do movimento.
- `src/lib/overlay.ts`: `FOLLOW_MS` 4 (era 10), `MAX_LEAD_MS` 56 (era 48), idade da amostra considerada até 48 ms; laser **e lupa** são extrapolados; caneta e borracha não (precisam ficar sobre a tinta).

Riscos a observar: um pouco mais de tremor parado e leve ultrapassagem ao parar um movimento rápido. Se piorar, voltar um passo nesses números antes de mexer em outra coisa.

## 7. Problemas conhecidos e pendências

**Precisa de teste com mão real (implementado, nunca visto rodando):**
- Chips ○ ▭ ― e seleção de traços não reconhecidos (posição dos chips, tempo de 0,6 s, pinça no chip não iniciar traço).
- Alças maiores (raio de toque 0,04 em unidades do slide; desenho 0,016).
- Reconhecimento mais tolerante (varredura ≥ 1,4π, redondeza ≤ 0,45 no modo robusto) — pode gerar falsos positivos em escrita à mão (ex.: letra "o").

**Problemas abertos:**
- Mão saindo do quadro da câmera derruba a ferramenta após 0,45 s (0,8 s para caneta). Ideia pesquisada e não implementada: cursor relativo com "embreagem" (a mão sai e volta e o cursor continua de onde parou) e/ou avisar quando a ponta do dedo se aproxima da borda da câmera.
- Detecção de retângulo praticamente não acontece em traço à mão; hoje o caminho confiável é o chip ▭.
- Deslizes rápidos em sequência podem disparar avanços extras (houve avanço 1,5 s depois de outro na sessão 2; verificar se era intencional).
- Zoom com punho não foi exercitado nas sessões (o desafio foi completado com a lupa).
- `brand/brand-kit.html` ainda mostra o vocabulário antigo de gestos.
- Mouse no Presenter: laser e desenho com botão, sem reconhecimento de forma nem chips.
- Tamanho do bundle: aviso de chunk > 500 kB (pdf.js + motion); não tratado.
- Nada commitado; sem deploy ainda.

**Constantes para ajustar (todas em `src/lib/gestures.ts` → `GESTURE`, e no topo de `controller.ts`):** tempos de confirmação de pose, deslize (distância 1 palma em 320 ms, retorno ignorado por 900 ms), menu (700 ms), lupa (solta após 400 ms), caneta (segurar 600 ms, velocidade parada 0,12), tolerância de perda de rastreamento, raio de alça, tempo do chip (600 ms), duração da seleção (8 s), raio do estabilizador (0,007).

## 8. Como diagnosticar com o usuário praticando

Em `npm run dev`, o app envia eventos para `debug/session.jsonl` (fora do git). Tipos úteis:

- `camera-ready` (backend, resolução, fps anunciado), `stats` a cada 1 s (`detectMs`, `captureToResultMs`, `frameGapMs`, `hands`, `pinchGap`, `tipU/tipY`, `outsideReach`, `poseDisagree`)
- `pose` (transições), `tracking`, `pen-down`/`pen-up`, `gap-hold`/`gap-recovered`/`gap-dropped`
- `event` (next, prev, menu-open/close/click, zoom-reset, pen-hold), `swipe-ignored`
- `pen-up-shape`, `pen-hold`, `shape-chip` (kind, via dwell/pinch), `shape-edited`, `shape-check`
- `menu-select`, `trainer-step`, `hold-reset`, `hand-registered`, `reach-saved`, `challenge`

Monitorar só o essencial (evita excesso de notificações):

```bash
tail -n0 -F debug/session.jsonl | grep -E --line-buffered '"type":"(event|gap-dropped|pen-hold|pen-up-shape|shape-chip|shape-edited|challenge|shape-check|swipe-ignored|menu-select|trainer-step|camera-ready|backend-fallback)"'
```

Depois, analisar o arquivo inteiro (transições de pose, tempo em cada pose, estatísticas agregadas) com um script Python curto.

## 9. Próximos passos sugeridos

1. Usuário testa formas com chips e alças; analisar `shape-chip`, `pen-up-shape` e `shape-edited` no log e ajustar tempos/posições.
2. Decidir sobre cursor relativo com embreagem para resolver a mão saindo do quadro.
3. Atualizar `brand/brand-kit.html` para o vocabulário atual.
4. Commit inicial organizado e primeiro deploy na Vercel (preview).
5. Ideias de produto levantadas e ainda não feitas: modo apresentador em segunda tela, visão geral de slides, controle pelo celular via QR code, gravação da apresentação, comandos de voz, mapa de atenção do laser, votação da plateia.
