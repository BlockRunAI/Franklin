import path from 'node:path';
import { startServer } from '../serve/server.js';

interface ServeOptions {
  port?: string;
  workDir?: string;
  debug?: boolean;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  const parsedPort = options.port == null ? 3737 : Number(options.port);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
    ? parsedPort
    : 3737;
  const workDir = options.workDir ? path.resolve(options.workDir) : process.cwd();
  await startServer({ port, workDir, debug: !!options.debug });
}
