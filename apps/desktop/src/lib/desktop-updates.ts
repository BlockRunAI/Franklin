export interface DesktopUpdateState {
  status: "idle" | "checking" | "current" | "available" | "downloading" | "downloaded" | "opening" | "error" | "disabled" | "unsupported";
  currentVersion: string;
  platform: string;
  version?: string;
  releaseUrl?: string;
  progress?: number;
  checkedAt?: number;
  openedAt?: number;
  error?: string;
}

export const updateCopy = {
  en: {
    title: "Desktop updates", check: "Check for updates", checking: "Checking for updates…", available: "Update available",
    current: "You're up to date", currentVersion: "Current version", newVersion: "New version", later: "Later", close: "Close",
    download: "Download update", downloading: "Downloading update…", install: "Open installer", opening: "Opening installer…", cancel: "Cancel download", notes: "Release notes",
    description: "Download the official installer, then follow the installation steps. Franklin won't restart automatically.",
    mac: "After downloading, quit Franklin, replace the app in Applications using the disk image, then reopen Franklin.",
    win: "Open the installer, then close Franklin and follow the installation steps. Reopen Franklin when installation finishes.",
    opened: "The installer has been opened. Follow the installation steps to finish updating.",
    busy: "Finish or stop active tasks before opening the installer.",
    disabled: "Update checks are available in installed Desktop builds.", unsupported: "No installer is currently available for this operating system and processor.",
    error: "Couldn't check or download the update. Check your connection and try again.", verification: "The download couldn't be verified. Check for updates and download it again.",
    rateLimit: "GitHub's update service is temporarily rate limited. Try again later.", feed: "The release information is incomplete. Try again later.", open: "Couldn't open the installer. Try opening it again.",
  },
  zh: {
    title: "Desktop 更新", check: "检查更新", checking: "正在检查更新…", available: "有新版本可用",
    current: "已是最新版本", currentVersion: "当前版本", newVersion: "新版本", later: "稍后", close: "关闭",
    download: "下载更新", downloading: "正在下载更新…", install: "打开安装包", opening: "正在打开安装包…", cancel: "取消下载", notes: "更新说明",
    description: "下载官方安装包后，按提示完成安装。Franklin 不会自动重启。",
    mac: "下载完成后，请退出 Franklin，通过磁盘映像替换「应用程序」中的 Franklin，再重新打开。",
    win: "打开安装包后，请关闭 Franklin 并按提示完成安装，再重新打开。",
    opened: "已打开安装包，请按安装步骤完成更新。", busy: "请先完成或停止正在运行的任务，再打开安装包。",
    disabled: "请在已安装的 Desktop 中检查更新。", unsupported: "目前没有适用于此系统和处理器的安装包。",
    error: "暂时无法检查或下载更新，请检查网络后重试。", verification: "安装包校验失败，请重新检查并下载更新。",
    rateLimit: "GitHub 更新服务暂时限流，请稍后重试。", feed: "新版发布信息尚不完整，请稍后重试。", open: "安装包未能打开，请重试。",
  },
  es: {
    title: "Actualizaciones de Desktop", check: "Buscar actualizaciones", checking: "Buscando actualizaciones…", available: "Actualización disponible",
    current: "Estás al día", currentVersion: "Versión actual", newVersion: "Nueva versión", later: "Más tarde", close: "Cerrar",
    download: "Descargar actualización", downloading: "Descargando actualización…", install: "Abrir instalador", opening: "Abriendo instalador…", cancel: "Cancelar descarga", notes: "Notas de la versión",
    description: "Descarga el instalador oficial y sigue los pasos de instalación. Franklin no se reiniciará automáticamente.",
    mac: "Tras descargar, cierra Franklin, reemplaza la app en Aplicaciones desde la imagen de disco y vuelve a abrirla.",
    win: "Abre el instalador, cierra Franklin y sigue los pasos. Vuelve a abrir Franklin al terminar.",
    opened: "Se ha abierto el instalador. Sigue los pasos para completar la actualización.", busy: "Termina o detén las tareas activas antes de abrir el instalador.",
    disabled: "La búsqueda está disponible en las versiones instaladas de Desktop.", unsupported: "No hay instalador para este sistema y procesador.",
    error: "No se pudo buscar o descargar la actualización. Comprueba la conexión e inténtalo de nuevo.", verification: "No se pudo verificar la descarga. Busca actualizaciones y vuelve a descargarla.",
    rateLimit: "El servicio de GitHub está limitado temporalmente. Inténtalo más tarde.", feed: "La información de la versión está incompleta. Inténtalo más tarde.", open: "No se pudo abrir el instalador. Inténtalo de nuevo.",
  },
};
