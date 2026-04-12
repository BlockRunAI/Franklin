/**
 * franklin panel — launch the local web dashboard.
 */
import chalk from 'chalk';
import { createPanelServer } from '../panel/server.js';
export async function panelCommand(options) {
    const port = parseInt(options.port || '3100', 10);
    const server = createPanelServer(port);
    server.listen(port, () => {
        console.log('');
        console.log(chalk.bold('  Franklin Panel'));
        console.log(chalk.dim(`  http://localhost:${port}`));
        console.log('');
        console.log(chalk.dim('  Press Ctrl+C to stop.'));
        console.log('');
        // Try to open browser
        const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        import('node:child_process').then(({ exec }) => {
            exec(`${open} http://localhost:${port}`);
        }).catch(() => { });
    });
    // Graceful shutdown
    const shutdown = () => {
        server.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
