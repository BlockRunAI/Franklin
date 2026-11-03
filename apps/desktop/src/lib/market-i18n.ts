import type { TryLang } from "./i18n";

const en = {
  tradingMode: "Trading Mode", tradingModeDescription: "Focus on markets and AI research. Hide creative tools, gallery and projects.", exitMode: "Exit Trading Mode", modeWait: "Finish or stop the current task before switching modes.", modeSettings: "Trading settings", backToTrading: "Back to Trading Mode",
  referenceAdded: "View draft reference", referenceKept: "Original snapshot kept. Remove it from the draft to capture again.", researchGuard: "Use fresh data and explain uncertainty. Do not place orders or sign transactions.", nextDraft: "You can draft your next question while Franklin replies. Send after this reply finishes.",
  workspace: "Trading workspace", workspaceHint: "A conversation with the market in view", layout: "Workspace layout", split: "Side by side", conversation: "Conversation", chartFocus: "Market", closeWorkspace: "Close market workspace", resize: "Resize conversation and market panels", rail: "Workspace navigation", currentChart: "Viewing", contextHint: "Use Reference market to add a dated snapshot to your draft.", deskTitle: "Think it through with Franklin", deskIntro: "Keep the chart beside your conversation. Explore an idea, question it, and decide what to do next.", trendStarter: "Analyze this trend", riskStarter: "What could I be missing?", compareStarter: "Compare BTC and ETH", trendPrompt: "Analyze the trend and key price levels for", riskPrompt: "Explain the uncertainty and main risks for", comparePrompt: "Compare BTC/USD and ETH/USD using fresh market data. Explain the evidence, differences and uncertainty. Do not place orders or sign transactions.",
  title: "Markets", subtitle: "Follow Bitcoin and Ethereum. Bring the context into your next conversation.",
  source: "Kraken spot · USD", live: "Live", connecting: "Connecting / reconnecting", polling: "Public API · 15s polling", offline: "Connection unavailable",
  change: "24h", unavailable: "Unavailable", loading: "Loading market data…", stale: "Stale", received: "Received", retry: "Reconnect",
  historyError: "Candle history could not be refreshed. Any visible candles are the last available snapshot.",
  quoteError: "Prices could not be refreshed. Reconnecting automatically.",
  noCandles: "No candle data yet. Check your connection and retry.",
  interval: "Candle interval", day: "1D", high: "24h high", low: "24h low", volume: "24h volume", candleVolume: "Candle volume",
  chart: "Candlestick chart", open: "Open", close: "Close", candleHigh: "High", candleLow: "Low", time: "Time (UTC)",
  table: "View candle data", lastRows: "Latest 20 candles · UTC", latestCandle: "Latest candle", candleReceived: "Candles received",
  note: "The current candle is still forming. Recent history is limited to 720 candles. Gaps can occur when there are no trades.",
  priceNote: "A single exchange’s spot price; on-chain swap quotes include their own liquidity, fees and slippage.",
  changeNote: "24h change is available from the live stream. It may be unavailable while polling.",
  analyze: "Reference market", analyzeNote: "Adds a dated snapshot to your draft. Your chart stays open.",
  footer: "Public market data from Kraken", chartBy: "Charts by TradingView", seconds: "s ago", never: "Waiting for data", selected: "Selected",
};
type Copy = { [K in keyof typeof en]: string };
const zh: Copy = {
  tradingMode: "交易模式", tradingModeDescription: "专注行情与 AI 研究，隐藏创作工具、作品库和项目入口。", exitMode: "退出交易模式", modeWait: "请等待当前任务完成，或停止后再切换模式。", modeSettings: "交易设置", backToTrading: "返回交易模式",
  referenceAdded: "查看已引用草稿", referenceKept: "保留首次快照；从草稿删除这段引用后可重新获取。", researchGuard: "请使用最新数据并解释不确定性。不要下单或签署交易。", nextDraft: "回复中也能准备下一问，回复结束后再发送。",
  workspace: "交易工作台", workspaceHint: "边看行情，边和 Franklin 交流", layout: "工作台布局", split: "双栏", conversation: "对话", chartFocus: "看盘", closeWorkspace: "关闭行情工作台", resize: "调整对话与行情面板宽度", rail: "工作区导航", currentChart: "当前查看", contextHint: "点「引用当前行情」将带时间的快照加入草稿。", deskTitle: "和 Franklin 一起看盘", deskIntro: "图表留在旁边，对话连续进行。先理解行情，再验证想法，最后决定下一步。", trendStarter: "分析当前走势", riskStarter: "有哪些被忽略的风险？", compareStarter: "对比 BTC 和 ETH", trendPrompt: "请分析走势、关键价位与证据：", riskPrompt: "请解释不确定性和主要风险：", comparePrompt: "请使用最新行情对比 BTC/USD 和 ETH/USD，解释证据、差异和不确定性。不要下单或签署交易。",
  title: "市场", subtitle: "关注比特币和以太坊行情，把市场信息带入下一次对话。",
  source: "Kraken 现货 · USD", live: "实时", connecting: "正在连接 / 重连", polling: "公开接口 · 每 15 秒刷新", offline: "连接不可用",
  change: "24 小时", unavailable: "暂无", loading: "正在加载行情…", stale: "数据已过期", received: "行情接收于", retry: "重新连接",
  historyError: "K 线历史刷新失败。当前显示的 K 线为上次可用的快照。", quoteError: "行情刷新失败，正在自动重连。",
  noCandles: "暂无 K 线数据，请检查网络后重试。", interval: "K 线周期", day: "日线", high: "24 小时最高", low: "24 小时最低", volume: "24 小时成交量", candleVolume: "单根成交量",
  chart: "K 线图", open: "开盘", close: "收盘", candleHigh: "最高", candleLow: "最低", time: "时间（UTC）",
  table: "查看 K 线数据", lastRows: "最近 20 根 K 线 · UTC", latestCandle: "最新一根 K 线", candleReceived: "K 线接收于",
  note: "当前 K 线尚未收盘。最多提供最近 720 根历史 K 线；无成交时可能出现间隔。",
  priceNote: "此处为单一交易所现货价格。链上兑换报价另受流动性、费用和滑点影响。",
  changeNote: "24 小时涨跌幅来自实时流，轮询时可能暂不提供。",
  analyze: "引用当前行情", analyzeNote: "把带时间的快照加入个人草稿，图表继续保留。",
  footer: "公开行情由 Kraken 提供", chartBy: "图表由 TradingView 提供", seconds: "秒前", never: "等待数据", selected: "已选择",
};
const es: Copy = {
  tradingMode: "Modo de trading", tradingModeDescription: "Céntrate en mercados e investigación con IA. Oculta creación, galería y proyectos.", exitMode: "Salir del modo de trading", modeWait: "Termina o detén la tarea actual antes de cambiar de modo.", modeSettings: "Ajustes de trading", backToTrading: "Volver al modo de trading",
  referenceAdded: "Ver referencia en borrador", referenceKept: "Captura original conservada. Elimínala del borrador para capturar de nuevo.", researchGuard: "Usa datos recientes y explica la incertidumbre. No coloques órdenes ni firmes transacciones.", nextDraft: "Puedes preparar tu próxima pregunta durante la respuesta y enviarla cuando termine.",
  workspace: "Espacio de trading", workspaceHint: "Conversa con el mercado a la vista", layout: "Diseño del espacio", split: "En paralelo", conversation: "Conversación", chartFocus: "Mercado", closeWorkspace: "Cerrar espacio de mercado", resize: "Ajustar paneles de conversación y mercado", rail: "Navegación del espacio", currentChart: "Viendo", contextHint: "Usa Referenciar mercado para añadir una captura fechada al borrador.", deskTitle: "Analiza con Franklin", deskIntro: "Mantén el gráfico junto a la conversación. Explora una idea, cuestiónala y decide el siguiente paso.", trendStarter: "Analizar tendencia", riskStarter: "¿Qué riesgos faltan?", compareStarter: "Comparar BTC y ETH", trendPrompt: "Analiza la tendencia y niveles clave de", riskPrompt: "Explica la incertidumbre y los riesgos de", comparePrompt: "Compara BTC/USD y ETH/USD con datos recientes. Explica las pruebas, diferencias e incertidumbre. No coloques órdenes ni firmes transacciones.",
  title: "Mercados", subtitle: "Sigue Bitcoin y Ethereum. Lleva el contexto a tu próxima conversación.",
  source: "Kraken al contado · USD", live: "En vivo", connecting: "Conectando / reconectando", polling: "API pública · cada 15 s", offline: "Conexión no disponible",
  change: "24 h", unavailable: "No disponible", loading: "Cargando datos…", stale: "Datos desactualizados", received: "Recibido", retry: "Reconectar",
  historyError: "No se pudo actualizar el historial. Las velas visibles son la última captura disponible.", quoteError: "No se pudieron actualizar los precios. Reconectando automáticamente.",
  noCandles: "Aún no hay velas. Comprueba la conexión e inténtalo de nuevo.", interval: "Intervalo", day: "1D", high: "Máximo 24 h", low: "Mínimo 24 h", volume: "Volumen 24 h", candleVolume: "Volumen de la vela",
  chart: "Gráfico de velas", open: "Apertura", close: "Cierre", candleHigh: "Máximo", candleLow: "Mínimo", time: "Hora (UTC)",
  table: "Ver datos de velas", lastRows: "Últimas 20 velas · UTC", latestCandle: "Última vela", candleReceived: "Velas recibidas",
  note: "La vela actual está en formación. El historial se limita a 720 velas recientes. Puede haber huecos si no hay operaciones.",
  priceNote: "Precio al contado de un solo exchange. Las cotizaciones on-chain tienen su propia liquidez, comisiones y deslizamiento.",
  changeNote: "La variación de 24 h proviene del flujo en vivo. Puede no estar disponible durante el sondeo.",
  analyze: "Referenciar mercado", analyzeNote: "Añade una captura fechada al borrador. El gráfico sigue abierto.",
  footer: "Datos públicos de Kraken", chartBy: "Gráficos de TradingView", seconds: "s atrás", never: "Esperando datos", selected: "Seleccionado",
};
export const marketCopy: Record<TryLang, Copy> = { en, zh, es };
export const marketLocale: Record<TryLang, string> = { en: "en-US", zh: "zh-CN", es: "es-ES" };
