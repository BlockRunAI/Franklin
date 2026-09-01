export function safeExternalHttpUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
