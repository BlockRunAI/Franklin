"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type TryLang = "en" | "zh" | "es";

export const TRY_LANGS: { id: TryLang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" },
  { id: "es", label: "Español" },
];

export interface TryDict {
  newChat: string;
  noConversations: string;
  pinned: string;
  recent: string;
  projects: string;
  agents: string;
  newProject: string;
  noProjects: string;
  connectingProjects: string;
  createOrJoinProject: string;
  enableTeamMode: string;
  teamModeOff: string;
  pinConversation: string;
  unpinConversation: string;
  deleteConversation: string;
  connectWallet: string;
  connecting: string;
  installWallet: string;
  baseNetwork: string;
  switchToBase: string;
  noWalletFound: string;
  openInWalletApp: string;
  image: string;
  video: string;
  music: string;
  ratio: string;
  resolution: string;
  attachImage: string;
  attachChatOnly: string;
  attachRef: string;
  attachSeed: string;
  actionLike: string;
  actionDislike: string;
  actionRetry: string;
  actionCopy: string;
  language: string;
  theme: string;
  themeGold: string;
  themeLight: string;
  themeDark: string;
  installCli: string;
  cli: string;
  cliTitle: string;
  cliSub: string;
  cliStepInstall: string;
  cliStepRun: string;
  cliCopy: string;
  copied: string;
  phone: string;
  tools: string;
  skills: string;
  gallery: string;
  wallet: string;
  marketplace: string;
  marketplaceTitle: string;
  tryIt: string;
  poweredBy: string;
  examples: string;
  toolsTitle: string;
  toolsSub: string;
  skillsTitle: string;
  skillsSub: string;
  galleryTitle: string;
  galleryEmpty: string;
  galleryDelete: string;
  galleryDeleteConfirm: string;
  walletTitle: string;
  balance: string;
  topUp: string;
  costByModel: string;
  receipts: string;
  walletEmpty: string;
  searchChats: string;
  noResults: string;
  today: string;
  yesterday: string;
  last7days: string;
  older: string;
  signIn: string;
  more: string;
  settings: string;
  officialSite: string;
  rename: string;
  about: string;
  docs: string;
  blog: string;
  casePrediction: string;
  casePrediction2: string;
  // Additional prediction-market starter prompts — broad, evergreen,
  // live-data queries that always return something regardless of the calendar
  // (no specific event named, so they don't go stale after a market resolves).
  // Three distinct angles: 24h momentum, sports vertical, AI/tech vertical.
  caseMovers: string;
  caseSports: string;
  caseTech: string;
  casePrice: string;
  caseSearch: string;
  caseMusic: string;
  caseProductPhotos: string;
  caseScreenshotDemo: string;
  caseFranklinSpeaker: string;
  caseStartupVisuals: string;
  caseCatHedgeFund: string;
  caseHeadshots: string;
  // empty-state titles (the word "Franklin" is highlighted at render time)
  emptyChat: string;
  emptyImage: string;
  emptyVideo: string;
  emptyMusic: string;
  // composer placeholders
  phMessage: string;
  phImage: string;
  phVideo: string;
  phMusic: string;
  phConnect: string;
  focusPrediction: string;
  focusSearch: string;
  focusPrice: string;
  phPrediction: string;
  phSearch: string;
  phPrice: string;
  // wallet hints
  hintImage: string;
  hintVideo: string;
  hintMusic: string;
  hintChat: (model: string) => string;
  hintToolWallet: string;
  // status
  statusSigning: string;
  statusWorking: string;
  statusImage: string;
  statusVideo: string;
  // media links
  openFull: string;
  downloadMp4: string;
  downloadAudio: string;
  reasoning: string;
  spent: string;
  requests: (n: number) => string;
  toolRunning: (tool: string) => string;
  activitySearched: (queries: number, sources: number) => string;
  activityUsed: (n: number) => string;
  // suggestions
  sugChat: string[];
  sugImage: string[];
  sugVideo: string[];
  sugMusic: string[];
}

const en: TryDict = {
  newChat: "New chat",
  noConversations: "No conversations yet.",
  pinned: "Pinned",
  recent: "Recent",
  projects: "Projects",
  agents: "Agents",
  newProject: "New project",
  noProjects: "No projects",
  connectingProjects: "Connecting…",
  createOrJoinProject: "Create or join a project",
  enableTeamMode: "Enable Team Mode in Agents",
  teamModeOff: "Team Mode is off · Manage modules",
  pinConversation: "Pin conversation",
  unpinConversation: "Unpin conversation",
  deleteConversation: "Delete conversation",
  connectWallet: "Connect wallet",
  connecting: "Connecting…",
  installWallet: "Install a wallet",
  baseNetwork: "Base",
  switchToBase: "Switch to Base",
  noWalletFound: "No wallet found",
  openInWalletApp: "Open in the MetaMask or Coinbase Wallet app browser.",
  image: "Image",
  video: "Video",
  music: "Music",
  ratio: "Ratio",
  resolution: "Resolution",
  attachImage: "Attach an image",
  attachChatOnly: "Attachments work in Chat mode",
  attachRef: "Attach a reference image (image-to-image)",
  attachSeed: "Attach a seed image (image-to-video)",
  actionLike: "Good response",
  actionDislike: "Bad response",
  actionRetry: "Regenerate",
  actionCopy: "Copy",
  language: "Language",
  theme: "Theme",
  themeGold: "Gold",
  themeLight: "Light",
  themeDark: "Dark",
  installCli: "Install from npm",
  cli: "Install CLI",
  cliTitle: "Run Franklin in your terminal",
  cliSub: "Install the open-source CLI and give your agent a wallet — pay per call in USDC, 60+ models, tools and trading data. No API keys.",
  cliStepInstall: "1. Install",
  cliStepRun: "2. Run it",
  cliCopy: "Copy command",
  copied: "Copied",
  phone: "Phone",
  tools: "Tools",
  skills: "Skills",
  gallery: "Gallery",
  wallet: "Wallet",
  marketplace: "Marketplace",
  marketplaceTitle: "Marketplace",
  tryIt: "Try",
  poweredBy: "Powered by",
  examples: "Examples",
  toolsTitle: "What Franklin can do",
  toolsSub: "Chat, generation, and live tools — pay per request in USDC, no subscription. Tools marked \u201cauto\u201d are called by Franklin automatically when useful.",
  skillsTitle: "Skills",
  skillsSub: "Quick-start a task — pick a skill and Franklin sets up the prompt.",
  galleryTitle: "Gallery",
  galleryEmpty: "Images and videos you generate will show up here.",
  galleryDelete: "Delete",
  galleryDeleteConfirm: "Delete this from your gallery? It will also be removed from the conversation.",
  walletTitle: "Wallet",
  balance: "Balance",
  topUp: "Send USDC on Base to your connected wallet to top up.",
  costByModel: "Cost by model",
  receipts: "Receipts",
  walletEmpty: "Connect your wallet to see your balance and spend.",
  searchChats: "Search chats",
  noResults: "No matches.",
  today: "Today",
  yesterday: "Yesterday",
  last7days: "Last 7 days",
  older: "Older",
  signIn: "Sign in",
  more: "More",
  settings: "Settings",
  officialSite: "Official site",
  rename: "Rename",
  about: "About",
  docs: "Docs",
  blog: "Blog",
  casePrediction: "Show me Fed rate-cut odds on Polymarket vs Kalshi.",
  casePrediction2: "Show me where smart money is positioning on Polymarket.",
  caseMovers: "Show me Polymarket's biggest 24-hour odds movers right now.",
  caseSports: "What are Polymarket's hottest sports markets right now?",
  caseTech: "Show me Polymarket's most-active AI and tech markets right now.",
  casePrice: "Pull a live BTC research brief with cited on-chain sources.",
  caseSearch: "Tell me who owns this wallet — VC, whale, or market maker?",
  caseMusic: "Score my short video with an original 3-minute track.",
  caseProductPhotos: "Generate premium product photos for my coffee brand.",
  caseScreenshotDemo: "Turn this screenshot into a polished product demo image.",
  caseFranklinSpeaker: "Generate a photo of Benjamin Franklin speaking at a crypto conference.",
  caseStartupVisuals: "Create marketing visuals for an AI startup landing page.",
  caseCatHedgeFund: "Create a hyper-realistic image of my cat running a hedge fund.",
  caseHeadshots: "Turn my selfie into 5 LinkedIn headshots.",
  emptyChat: "What should Franklin do?",
  emptyImage: "What should Franklin draw?",
  emptyVideo: "What should Franklin film?",
  emptyMusic: "What should Franklin compose?",
  phMessage: "Message Franklin…",
  phImage: "Describe an image…",
  phVideo: "Describe a video…",
  phMusic: "Describe music to compose…",
  phConnect: "Connect a wallet to begin…",
  focusPrediction: "Prediction",
  focusSearch: "Web search",
  focusPrice: "Prices",
  phPrediction: "Ask about prediction-market odds…",
  phSearch: "Search the web…",
  phPrice: "Ask for a live price…",
  hintImage: "Connect a wallet to generate images.",
  hintVideo: "Connect a wallet to generate videos.",
  hintMusic: "Connect a wallet to generate music.",
  hintChat: (m) => `Connect a wallet to use ${m}, or switch to a free model.`,
  hintToolWallet: "Franklin needs a paid tool (web search, prediction markets, …). Connect your wallet to continue.",
  statusSigning: "Sign the payment in your wallet…",
  statusWorking: "Franklin is working…",
  statusImage: "Painting your image…",
  statusVideo: "Rendering your video (this can take a minute)…",
  openFull: "Open full size",
  downloadMp4: "Download MP4",
  downloadAudio: "Download audio",
  reasoning: "Thoughts",
  spent: "Spent",
  requests: (n) => `${n} request${n===1?"":"s"}`,
  toolRunning: (tool) => ({web_search:"Searching the web…",get_market_price:"Checking live prices…",search_prediction_markets:"Checking prediction markets…",generate_music:"Composing music…",make_phone_call:"Placing the call…"}[tool] || "Using a tool…"),
  activitySearched: (q, s) => `Searched ${q} ${q === 1 ? "keyword" : "keywords"}${s ? ` · ${s} ${s === 1 ? "source" : "sources"}` : ""}`,
  activityUsed: (n) => `Used ${n} ${n === 1 ? "tool" : "tools"}`,
  sugChat: [
    "Keep the same AI character across 5 promo clips.",
  ],
  sugImage: [
    "Turn my selfie into 5 LinkedIn headshots.",
  ],
  sugVideo: [
    "Shoot an 8-second product ad with synced sound.",
    "Keep the same AI character across 5 promo clips.",
  ],
  sugMusic: [
    "Lo-fi hip hop, mellow piano, rainy afternoon vibes, 60 seconds.",
    "Cinematic orchestral build-up — strings and brass, epic and hopeful.",
    "Synthwave instrumental with a driving 80s drum beat, neon-night mood.",
  ],
};

const zh: TryDict = {
  newChat: "新对话",
  noConversations: "还没有对话。",
  pinned: "已置顶",
  recent: "最近",
  projects: "项目",
  agents: "智能体",
  newProject: "新建项目",
  noProjects: "暂无项目",
  connectingProjects: "连接中…",
  createOrJoinProject: "创建或加入项目",
  enableTeamMode: "在「智能体」中开启团队模式",
  teamModeOff: "团队模式已关闭 · 管理模块",
  pinConversation: "置顶对话",
  unpinConversation: "取消置顶",
  deleteConversation: "删除对话",
  connectWallet: "连接钱包",
  connecting: "连接中…",
  installWallet: "安装钱包",
  baseNetwork: "Base",
  switchToBase: "切换到 Base",
  noWalletFound: "未检测到钱包",
  openInWalletApp: "请在 MetaMask 或 Coinbase Wallet 应用的内置浏览器中打开。",
  image: "图像",
  video: "视频",
  music: "音乐",
  ratio: "比例",
  resolution: "清晰度",
  attachImage: "添加图片",
  attachChatOnly: "附件仅在对话模式可用",
  attachRef: "添加参考图（图生图）",
  attachSeed: "添加首帧图（图生视频）",
  actionLike: "赞",
  actionDislike: "踩",
  actionRetry: "重新生成",
  actionCopy: "复制",
  language: "语言",
  theme: "主题",
  themeGold: "金色",
  themeLight: "浅色",
  themeDark: "深色",
  installCli: "从 npm 安装",
  cli: "安装 CLI",
  cliTitle: "在终端里运行 Franklin",
  cliSub: "安装开源 CLI，给你的 agent 一个钱包——按次用 USDC 付费，60+ 模型、工具与行情数据。无需 API key。",
  cliStepInstall: "1. 安装",
  cliStepRun: "2. 运行",
  cliCopy: "复制命令",
  copied: "已复制",
  phone: "电话",
  tools: "工具",
  skills: "技能",
  gallery: "作品库",
  wallet: "钱包",
  marketplace: "应用市场",
  marketplaceTitle: "应用市场",
  tryIt: "试用",
  poweredBy: "技术支持",
  examples: "示例",
  toolsTitle: "Franklin 能做什么",
  toolsSub: "对话、生成、实时工具——按次用 USDC 付费，无订阅。标「auto」的工具由 Franklin 在需要时自动调用。",
  skillsTitle: "技能",
  skillsSub: "快速开始——选一个技能，Franklin 帮你搭好提示词。",
  galleryTitle: "图库",
  galleryEmpty: "你生成的图片和视频会显示在这里。",
  galleryDelete: "删除",
  galleryDeleteConfirm: "从图库删除这张?它也会从对话里一并移除。",
  walletTitle: "钱包",
  balance: "余额",
  topUp: "在 Base 上把 USDC 转到你连接的钱包即可充值。",
  costByModel: "按模型花费",
  receipts: "账单",
  walletEmpty: "连接钱包以查看余额和花费。",
  searchChats: "搜索对话",
  noResults: "无匹配结果。",
  today: "今天",
  yesterday: "昨天",
  last7days: "最近 7 天",
  older: "更早",
  signIn: "登录",
  more: "更多",
  settings: "设置",
  officialSite: "官网",
  rename: "重命名",
  about: "关于",
  docs: "文档",
  blog: "博客",
  casePrediction: "Polymarket 和 Kalshi 上美联储降息的赔率分别是多少？",
  casePrediction2: "Polymarket 上聪明钱正在往哪儿押注？",
  caseMovers: "看看 Polymarket 上 24 小时内赔率变动最大的市场。",
  caseSports: "Polymarket 上当下最火的体育市场有哪些？",
  caseTech: "看看 Polymarket 上现在最活跃的 AI 和科技类市场。",
  casePrice: "拉一份实时 BTC 研究简报，附上链上数据来源。",
  caseSearch: "告诉我这个钱包属于谁 —— VC、巨鲸，还是做市商？",
  caseMusic: "给我这段短视频配一首 3 分钟原创配乐。",
  caseProductPhotos: "为我的咖啡品牌生成高端产品图。",
  caseScreenshotDemo: "把这张截图做成精修的产品演示图。",
  caseFranklinSpeaker: "生成一张富兰克林在加密大会上演讲的照片。",
  caseStartupVisuals: "为 AI 创业公司的落地页设计营销视觉图。",
  caseCatHedgeFund: "生成一张写实风格的「我家猫在管对冲基金」。",
  caseHeadshots: "把我的自拍变成 5 张 LinkedIn 职业头像。",
  emptyChat: "让 Franklin 做点什么？",
  emptyImage: "让 Franklin 画点什么？",
  emptyVideo: "让 Franklin 拍点什么？",
  emptyMusic: "让 Franklin 作点什么音乐？",
  phMessage: "给 Franklin 发消息…",
  phImage: "描述一张图片…",
  phVideo: "描述一段视频…",
  phMusic: "描述你想要的音乐…",
  phConnect: "连接钱包后开始…",
  focusPrediction: "预测市场",
  focusSearch: "联网搜索",
  focusPrice: "实时行情",
  phPrediction: "问问预测市场的赔率…",
  phSearch: "联网搜索…",
  phPrice: "查询实时价格…",
  hintImage: "连接钱包以生成图片。",
  hintVideo: "连接钱包以生成视频。",
  hintMusic: "连接钱包以生成音乐。",
  hintChat: (m) => `连接钱包以使用 ${m}，或切换到免费模型。`,
  hintToolWallet: "Franklin 需要调用付费工具（联网搜索、预测市场等）。请连接钱包以继续。",
  statusSigning: "请在钱包中签名付款…",
  statusWorking: "Franklin 正在处理…",
  statusImage: "正在绘制图片…",
  statusVideo: "正在渲染视频（可能需要一会儿）…",
  openFull: "查看原图",
  downloadMp4: "下载 MP4",
  downloadAudio: "下载音频",
  reasoning: "推理过程",
  spent: "已花费",
  requests: (n) => `${n} 次请求`,
  toolRunning: (tool) => ({web_search:"正在联网搜索…",get_market_price:"正在查实时行情…",search_prediction_markets:"正在查预测市场…",generate_music:"正在生成音乐…",make_phone_call:"正在拨打电话…"}[tool] || "正在调用工具…"),
  activitySearched: (q, s) => `搜索 ${q} 个关键词${s ? `，参考 ${s} 篇资料` : ""}`,
  activityUsed: (n) => `调用了 ${n} 个工具`,
  sugChat: [
    "在 5 段宣传短片里保持同一个 AI 角色。",
  ],
  sugImage: [
    "把我的自拍变成 5 张 LinkedIn 职业头像。",
  ],
  sugVideo: [
    "拍一支 8 秒的产品广告，带同步音效。",
    "在 5 段宣传短片里保持同一个 AI 角色。",
  ],
  sugMusic: [
    "低保真 Hip-Hop，柔和的钢琴，雨天午后氛围，60 秒。",
    "电影感管弦乐渐进——弦乐和铜管，史诗且充满希望。",
    "Synthwave 纯音乐，80 年代鼓点驱动，霓虹夜晚的氛围。",
  ],
};

const es: TryDict = {
  newChat: "Nuevo chat",
  noConversations: "Aún no hay conversaciones.",
  pinned: "Fijados",
  recent: "Recientes",
  projects: "Proyectos",
  agents: "Agentes",
  newProject: "Nuevo proyecto",
  noProjects: "Sin proyectos",
  connectingProjects: "Conectando…",
  createOrJoinProject: "Crear o unirse a un proyecto",
  enableTeamMode: "Activa el Modo Equipo en Agentes",
  teamModeOff: "Modo Equipo desactivado · Gestionar módulos",
  pinConversation: "Fijar conversación",
  unpinConversation: "Dejar de fijar",
  deleteConversation: "Eliminar conversación",
  connectWallet: "Conectar billetera",
  connecting: "Conectando…",
  installWallet: "Instalar billetera",
  baseNetwork: "Base",
  switchToBase: "Cambiar a Base",
  noWalletFound: "No se encontró billetera",
  openInWalletApp: "Ábrelo en el navegador de la app MetaMask o Coinbase Wallet.",
  image: "Imagen",
  video: "Video",
  music: "Música",
  ratio: "Proporción",
  resolution: "Resolución",
  attachImage: "Adjuntar una imagen",
  attachChatOnly: "Los adjuntos funcionan en modo Chat",
  attachRef: "Adjunta una imagen de referencia (imagen a imagen)",
  attachSeed: "Adjunta una imagen inicial (imagen a video)",
  actionLike: "Buena respuesta",
  actionDislike: "Mala respuesta",
  actionRetry: "Regenerar",
  actionCopy: "Copiar",
  language: "Idioma",
  theme: "Tema",
  themeGold: "Dorado",
  themeLight: "Claro",
  themeDark: "Oscuro",
  installCli: "Instalar desde npm",
  cli: "Instalar CLI",
  cliTitle: "Ejecuta Franklin en tu terminal",
  cliSub: "Instala la CLI de código abierto y dale una billetera a tu agente — pago por uso en USDC, 60+ modelos, herramientas y datos de mercado. Sin API keys.",
  cliStepInstall: "1. Instala",
  cliStepRun: "2. Ejecuta",
  cliCopy: "Copiar comando",
  copied: "Copiado",
  phone: "Teléfono",
  tools: "Herramientas",
  skills: "Habilidades",
  gallery: "Galería",
  wallet: "Cartera",
  marketplace: "Mercado",
  marketplaceTitle: "Mercado",
  tryIt: "Probar",
  poweredBy: "Con tecnología de",
  examples: "Ejemplos",
  toolsTitle: "Qué puede hacer Franklin",
  toolsSub: "Chat, generación y herramientas en vivo — pago por uso en USDC, sin suscripción. Las marcadas «auto» las usa Franklin automáticamente.",
  skillsTitle: "Habilidades",
  skillsSub: "Empieza rápido — elige una habilidad y Franklin prepara el prompt.",
  galleryTitle: "Galería",
  galleryEmpty: "Las imágenes y videos que generes aparecerán aquí.",
  galleryDelete: "Eliminar",
  galleryDeleteConfirm: "¿Eliminar esto de tu galería? También se quitará de la conversación.",
  walletTitle: "Billetera",
  balance: "Saldo",
  topUp: "Envía USDC en Base a tu billetera conectada para recargar.",
  costByModel: "Costo por modelo",
  receipts: "Recibos",
  walletEmpty: "Conecta tu billetera para ver saldo y gastos.",
  searchChats: "Buscar chats",
  noResults: "Sin resultados.",
  today: "Hoy",
  yesterday: "Ayer",
  last7days: "Últimos 7 días",
  older: "Anteriores",
  signIn: "Iniciar sesión",
  more: "Más",
  settings: "Ajustes",
  officialSite: "Sitio oficial",
  rename: "Renombrar",
  about: "Acerca de",
  docs: "Docs",
  blog: "Blog",
  casePrediction: "Muéstrame las probabilidades de recorte de tipos de la Fed en Polymarket vs Kalshi.",
  casePrediction2: "Muéstrame dónde se está posicionando el smart money en Polymarket.",
  caseMovers: "Muéstrame los mayores movers de Polymarket de las últimas 24 horas.",
  caseSports: "¿Cuáles son los mercados deportivos más calientes ahora mismo en Polymarket?",
  caseTech: "Muéstrame los mercados de IA y tecnología más activos ahora en Polymarket.",
  casePrice: "Tráeme un brief de investigación en vivo sobre BTC con fuentes on-chain citadas.",
  caseSearch: "Dime quién es el dueño de esta wallet — VC, whale o market maker.",
  caseMusic: "Pónle a mi video corto una pista original de 3 minutos.",
  caseProductPhotos: "Genera fotos premium de producto para mi marca de café.",
  caseScreenshotDemo: "Convierte esta captura en una imagen de demo de producto pulida.",
  caseFranklinSpeaker: "Genera una foto de Benjamin Franklin dando un discurso en una conferencia cripto.",
  caseStartupVisuals: "Crea visuales de marketing para la landing de una startup de IA.",
  caseCatHedgeFund: "Crea una imagen hiperrealista de mi gato dirigiendo un hedge fund.",
  caseHeadshots: "Convierte mi selfie en 5 fotos de perfil para LinkedIn.",
  emptyChat: "¿Qué debería hacer Franklin?",
  emptyImage: "¿Qué debería dibujar Franklin?",
  emptyVideo: "¿Qué debería filmar Franklin?",
  emptyMusic: "¿Qué debería componer Franklin?",
  phMessage: "Escribe a Franklin…",
  phImage: "Describe una imagen…",
  phVideo: "Describe un video…",
  phMusic: "Describe la música a componer…",
  phConnect: "Conecta una billetera para empezar…",
  focusPrediction: "Predicción",
  focusSearch: "Búsqueda web",
  focusPrice: "Precios",
  phPrediction: "Pregunta por probabilidades de mercados de predicción…",
  phSearch: "Busca en la web…",
  phPrice: "Pide un precio en vivo…",
  hintImage: "Conecta una billetera para generar imágenes.",
  hintVideo: "Conecta una billetera para generar videos.",
  hintMusic: "Conecta una billetera para generar música.",
  hintChat: (m) => `Conecta una billetera para usar ${m}, o cambia a un modelo gratuito.`,
  hintToolWallet: "Franklin necesita una herramienta de pago (búsqueda web, mercados de predicción…). Conecta tu billetera para continuar.",
  statusSigning: "Firma el pago en tu billetera…",
  statusWorking: "Franklin está trabajando…",
  statusImage: "Pintando tu imagen…",
  statusVideo: "Renderizando tu video (puede tardar un minuto)…",
  openFull: "Ver tamaño completo",
  downloadMp4: "Descargar MP4",
  downloadAudio: "Descargar audio",
  reasoning: "Razonamiento",
  spent: "Gastado",
  requests: (n) => `${n} solicitud${n===1?"":"es"}`,
  toolRunning: (tool) => ({web_search:"Buscando en la web…",get_market_price:"Consultando precios…",search_prediction_markets:"Consultando mercados de predicción…",generate_music:"Componiendo música…",make_phone_call:"Realizando la llamada…"}[tool] || "Usando una herramienta…"),
  activitySearched: (q, s) => `Buscó ${q} ${q === 1 ? "palabra clave" : "palabras clave"}${s ? ` · ${s} ${s === 1 ? "fuente" : "fuentes"}` : ""}`,
  activityUsed: (n) => `Usó ${n} ${n === 1 ? "herramienta" : "herramientas"}`,
  sugChat: [
    "Mantén el mismo personaje IA en 5 clips promocionales.",
  ],
  sugImage: [
    "Convierte mi selfie en 5 retratos profesionales para LinkedIn.",
  ],
  sugVideo: [
    "Filma un anuncio de producto de 8 segundos con sonido sincronizado.",
    "Mantén el mismo personaje IA en 5 clips promocionales.",
  ],
  sugMusic: [
    "Lo-fi hip hop, piano suave, vibras de tarde lluviosa, 60 segundos.",
    "Crescendo orquestal cinematográfico — cuerdas y metales, épico y esperanzador.",
    "Synthwave instrumental con batería ochentera, ambiente de noche neón.",
  ],
};

const DICTS: Record<TryLang, TryDict> = { en, zh, es };
const STORAGE_KEY = "franklin-try-ui-lang";

interface Ctx {
  lang: TryLang;
  setLang: (l: TryLang) => void;
  t: TryDict;
}
const TryLangCtx = createContext<Ctx>({ lang: "en", setLang: () => {}, t: en });

export function TryLangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<TryLang>("en");
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as TryLang | null;
    if (saved && DICTS[saved]) setLangState(saved);
  }, []);
  const setLang = useCallback((l: TryLang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  return <TryLangCtx.Provider value={{ lang, setLang, t: DICTS[lang] }}>{children}</TryLangCtx.Provider>;
}

export function useTryLang() {
  return useContext(TryLangCtx);
}
