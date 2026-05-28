/**
 * Schema flatten — ported from reasonix (MIT) and adapted to Franklin's
 * CapabilitySchema shape. Deep / wide schemas get dropped or hallucinated
 * by some models (DeepSeek R1, smaller Llamas, some Qwen variants); present
 * them as dot-paths and re-nest before dispatch.
 *
 * Pure functions; no side effects. Wire into a tool registry via
 * analyzeSchema(spec.input_schema) at registration time, then call
 * flattenSchema() on the spec sent to the model and nestArguments() on
 * the parsed call arguments before invoking the handler.
 */
import type { CapabilitySchema } from '../types.js';

/** Loose recursive schema — properties of a CapabilitySchema are typed
 *  `unknown`, but in practice they are JSON-Schema-like objects. */
export interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  [k: string]: unknown;
}

export interface FlattenDecision {
  shouldFlatten: boolean;
  leafCount: number;
  maxDepth: number;
}

/** Caller defines the trigger thresholds; reasonix's defaults are 10/2. */
const DEFAULT_LEAF_LIMIT = 10;
const DEFAULT_DEPTH_LIMIT = 2;

export function analyzeSchema(
  schema: SchemaNode | CapabilitySchema | undefined,
  opts: { leafLimit?: number; depthLimit?: number } = {},
): FlattenDecision {
  if (!schema) return { shouldFlatten: false, leafCount: 0, maxDepth: 0 };
  const leafLimit = opts.leafLimit ?? DEFAULT_LEAF_LIMIT;
  const depthLimit = opts.depthLimit ?? DEFAULT_DEPTH_LIMIT;
  let leafCount = 0;
  let maxDepth = 0;
  walk(schema as SchemaNode, 0, (depth, isLeaf) => {
    if (isLeaf) leafCount++;
    if (depth > maxDepth) maxDepth = depth;
  });
  return {
    shouldFlatten: leafCount > leafLimit || maxDepth > depthLimit,
    leafCount,
    maxDepth,
  };
}

export function flattenSchema(schema: SchemaNode | CapabilitySchema): CapabilitySchema {
  const flatProps: Record<string, SchemaNode> = {};
  const required: string[] = [];
  collect('', schema as SchemaNode, flatProps, required, true);
  return {
    type: 'object',
    properties: flatProps as Record<string, unknown>,
    required,
  };
}

export function nestArguments(flatArgs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flatArgs)) {
    setByPath(out, key.split('.'), value);
  }
  return out;
}

function walk(
  schema: SchemaNode,
  depth: number,
  visit: (depth: number, isLeaf: boolean) => void,
): void {
  if (schema.type === 'object' && schema.properties) {
    for (const child of Object.values(schema.properties)) {
      walk(child, depth + 1, visit);
    }
    return;
  }
  if (schema.type === 'array' && schema.items) {
    walk(schema.items, depth + 1, visit);
    return;
  }
  visit(depth, true);
}

function collect(
  prefix: string,
  schema: SchemaNode,
  out: Record<string, SchemaNode>,
  required: string[],
  isRootRequired: boolean,
): void {
  if (schema.type === 'object' && schema.properties) {
    const requiredSet = new Set(schema.required ?? []);
    for (const [key, child] of Object.entries(schema.properties)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      const childRequired = isRootRequired && requiredSet.has(key);
      collect(nextPrefix, child, out, required, childRequired);
    }
    return;
  }
  out[prefix] = schema;
  if (isRootRequired) required.push(prefix);
}

function setByPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (typeof next !== 'object' || next === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}
