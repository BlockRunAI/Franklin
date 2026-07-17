/**
 * Hook discovery and validation.
 *
 * Sources, in load order:
 *   1. ~/.blockrun/hooks/*.json         — user scope, always trusted
 *   2. <project>/.franklin/hooks/*.json — project scope, loads ONLY when the
 *      project dir is trusted (same trusted-projects.json marker that gates
 *      project .mcp.json — one mental model for "this repo may run code").
 *
 * Malformed files or entries warn once and are skipped; unknown event names
 * are ignored so config files can carry events from other harnesses or
 * future versions without breaking.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  HOOK_EVENTS,
  LIFECYCLE_EVENTS,
  type HookConfigFile,
  type HookEvent,
  type HookMatcherDef,
  type LoadedHook,
} from './types.js';

export function userHooksDir(): string {
  return path.join(BLOCKRUN_DIR, 'hooks');
}

export function projectHooksDir(workDir: string): string {
  return path.join(workDir, '.franklin', 'hooks');
}

/** Same trust marker that gates project .mcp.json (see src/mcp/config.ts). */
export function isProjectTrusted(workDir: string): boolean {
  const trustMarker = path.join(BLOCKRUN_DIR, 'trusted-projects.json');
  try {
    if (fs.existsSync(trustMarker)) {
      const trustedDirs = JSON.parse(fs.readFileSync(trustMarker, 'utf-8'));
      return Array.isArray(trustedDirs) && trustedDirs.includes(workDir);
    }
  } catch {
    /* unreadable marker = not trusted */
  }
  return false;
}

export function loadHooks(workDir: string): LoadedHook[] {
  const loaded: LoadedHook[] = [];
  collectDir(userHooksDir(), 'user', loaded);

  const projDir = projectHooksDir(workDir);
  if (fs.existsSync(projDir)) {
    if (isProjectTrusted(workDir)) {
      collectDir(projDir, 'project', loaded);
    } else {
      logger.info(
        `[hooks] Skipping untrusted project hooks in ${projDir} — run /mcp trust to enable`
      );
    }
  }
  return loaded;
}

function collectDir(dir: string, scope: 'user' | 'project', out: LoadedHook[]): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  } catch {
    return; // dir missing — nothing to load
  }

  for (const file of entries) {
    const sourceFile = path.join(dir, file);
    let parsed: HookConfigFile;
    try {
      parsed = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
    } catch (err) {
      logger.warn(`[hooks] Skipping malformed hook file ${sourceFile}: ${(err as Error).message}`);
      continue;
    }
    if (!parsed || typeof parsed.hooks !== 'object' || parsed.hooks === null) {
      logger.warn(`[hooks] Skipping ${sourceFile}: missing top-level "hooks" object`);
      continue;
    }

    for (const [eventName, matchers] of Object.entries(parsed.hooks)) {
      if (!HOOK_EVENTS.has(eventName)) continue; // foreign/future event — ignore
      const event = eventName as HookEvent;
      if (!Array.isArray(matchers)) {
        logger.warn(`[hooks] ${sourceFile}: "${eventName}" must be an array — skipped`);
        continue;
      }
      for (const entry of matchers) {
        collectMatcherEntry(entry, event, sourceFile, scope, out);
      }
    }
  }
}

function collectMatcherEntry(
  entry: HookMatcherDef,
  event: HookEvent,
  sourceFile: string,
  scope: 'user' | 'project',
  out: LoadedHook[]
): void {
  if (!entry || !Array.isArray(entry.hooks)) {
    logger.warn(`[hooks] ${sourceFile}: entry for ${event} lacks a "hooks" array — skipped`);
    return;
  }

  let matcher: RegExp | undefined;
  if (typeof entry.matcher === 'string' && entry.matcher.length > 0) {
    if (LIFECYCLE_EVENTS.has(event)) {
      logger.warn(
        `[hooks] ${sourceFile}: ${event} carries no tool context — matcher "${entry.matcher}" rejected, entry skipped`
      );
      return;
    }
    try {
      matcher = new RegExp(entry.matcher);
    } catch (err) {
      logger.warn(
        `[hooks] ${sourceFile}: invalid matcher regex "${entry.matcher}" for ${event}: ${(err as Error).message} — entry skipped`
      );
      return;
    }
  }

  for (const handler of entry.hooks) {
    if (!handler || handler.type !== 'command' || typeof handler.command !== 'string' || !handler.command.trim()) {
      logger.warn(`[hooks] ${sourceFile}: handler for ${event} must be {type:"command", command:"..."} — skipped`);
      continue;
    }
    out.push({ event, matcher, handler, sourceFile, scope });
  }
}
