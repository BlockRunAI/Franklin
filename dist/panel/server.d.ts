/**
 * Franklin Panel — local HTTP server.
 * Serves the dashboard HTML + JSON API endpoints + SSE for real-time updates.
 * Zero external dependencies — uses node:http only.
 */
import http from 'node:http';
export declare function createPanelServer(port: number): http.Server;
