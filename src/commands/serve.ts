import path from 'node:path';
import { startServer } from '../serve/server.js';

interface ServeOptions {
  port?: string;
  workDir?: string;
  debug?: boolean;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  const port = Number(options.port) || 3737;
  const workDir = options.workDir ? path.resolve(options.workDir) : process.cwd();
  await startServer({ port, workDir, debug: !!options.debug });
}
