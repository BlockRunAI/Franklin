import path from 'node:path';
import { startWebuiServer } from '../webui/server.js';

interface WebuiOptions {
  port?: string;
  workDir?: string;
  debug?: boolean;
}

export async function webuiCommand(options: WebuiOptions): Promise<void> {
  const port = Number(options.port) || 3737;
  const workDir = options.workDir ? path.resolve(options.workDir) : process.cwd();
  await startWebuiServer({ port, workDir, debug: !!options.debug });
}
