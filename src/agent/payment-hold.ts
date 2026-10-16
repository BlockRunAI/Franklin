/**
 * Payment hold — the code half of the "Ambiguous payment outcomes" rule.
 *
 * The system prompt tells the model that a timeout or 5xx after a send means
 * UNKNOWN, not failed. An external audit (EmberTail, Franklin 3.49.6, 37
 * sessions) showed the model does not reliably apply it: after a timeout or
 * a 502 it rewrote the payment script and sent again (three double payments),
 * or recorded the invoice as unpaid without checking. The exact-command dedup
 * caught one resend out of four because it compares command text, and a
 * rewritten script is different text.
 *
 * This module keys on what a Bash run DOES, not what it says:
 *   1. A Bash run whose command — or the script file it runs — sends a
 *      transaction or payment is a payment attempt.
 *   2. If that attempt ends in a timeout, a 5xx, a dropped connection, a
 *      missing receipt, an error after a tx hash was printed, or detaches to
 *      the background, its outcome is UNKNOWN. The tool result is annotated
 *      so the model sees that before it decides anything.
 *   3. While an attempt is unknown, any new send that could pay the same
 *      recipient is held and goes to the user for an explicit decision; no
 *      approval surface (headless) = held. Rewording the script cannot get
 *      around this.
 *   4. While an attempt is unknown and no read-only reconciliation (receipt,
 *      nonce, balance, status lookup) has run since, recording it as
 *      failed/unpaid is refused: the outcome has not been established.
 *
 * Pure detection helpers are exported for tests; SessionToolGuard owns the
 * per-session state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';

// ─── Detection ─────────────────────────────────────────────────────────────

/**
 * Code that signs-and-sends a transaction or pays for a request. Matched on
 * the Bash command and on the script files it runs. Deliberately broad on
 * the send side: a false positive costs one user prompt after an ambiguous
 * failure; a false negative costs a second settlement.
 */
const SEND_PATTERNS: RegExp[] = [
  // viem / ethers / web3.js / solana-web3
  /\bsend(?:Raw)?Transaction\s*\(/,
  /\bwriteContract\s*\(/,
  /\bsendAndConfirm(?:Raw)?Transaction\s*\(/,
  /\bsendUserOperation\s*\(/,
  /\beth_send(?:Raw)?Transaction\b/,
  // ERC-20 transfer through a contract object or a writeContract call
  /\.\s*(?:transfer|transferFrom)\s*\(/,
  /functionName\s*:\s*['"`](?:transfer|transferFrom|approve)['"`]/,
  // web3.py
  /\bsend_(?:raw_)?transaction\s*\(/,
  /\.transact\s*\(/,
  // CLIs
  /\bcast\s+(?:send|publish)\b/,
  /\bspl-token\s+transfer\b/,
  /\bsolana\s+(?:transfer|pay)\b/,
  // x402 / paid HTTP
  /\bwrapFetchWithPayment\b/,
  /\bwithPaymentInterceptor\b/,
  /\bcreatePaymentHeader\b/,
  /['"`]x-payment['"`]/i,
  /\bx-payment\s*:/i,
];

/** Read-only chain lookups that count as an attempt to reconcile. */
const RECONCILE_PATTERNS: RegExp[] = [
  /\bgetTransactionReceipt\b/,
  /\bwaitForTransactionReceipt\b/,
  /\bgetTransaction\s*\(/,
  /\bgetTransactionCount\b/,
  /\bgetBalance\b/,
  /\bbalanceOf\b/,
  /\bgetSignatureStatus(?:es)?\b/,
  /\bgetParsedTransaction\b/,
  /\beth_getTransaction(?:Receipt|ByHash|Count)\b/,
  /\bget_transaction(?:_receipt|_count)?\s*\(/,
  /\bcast\s+(?:receipt|tx|nonce|balance|call)\b/,
  /\bspl-token\s+balance\b/,
  /\bsolana\s+(?:balance|confirm)\b/,
];

/**
 * Outcome text that means "the response was lost", not "it failed". Kept
 * specific: a bare `\b5\d\d\b` would fire on "500 USDC".
 */
const AMBIGUOUS_OUTCOME_RE = new RegExp(
  [
    'TimeoutError',
    '\\btim(?:ed|e)\\s*out\\b',
    '\\btimeout\\b',
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'ECONNRESET',
    'ECONNABORTED',
    'ECONNREFUSED',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_\\w+',
    'socket hang up',
    'other side closed',
    'fetch failed',
    'network error',
    'HTTP\\s*/?\\s*(?:\\d(?:\\.\\d)?\\s+)?5\\d\\d',
    'status(?:\\s*code)?\\s*[:=]?\\s*5\\d\\d',
    '\\b5\\d\\d\\s+(?:Bad Gateway|Internal Server Error|Service Unavailable|Gateway Time-?out)',
    'Bad Gateway',
    'Service Unavailable',
    'Gateway Time-?out',
    'upstream response lost',
    'response (?:was )?(?:unavailable|lost)',
    'TransactionReceiptNotFound',
    'WaitForTransactionReceiptTimeout',
    'receipt (?:not found|unavailable)',
    'command killed',
  ].join('|'),
  'i',
);

const TX_HASH_RE = /\b0x[0-9a-fA-F]{64}\b/g;
const EVM_ADDRESS_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const QUOTED_BASE58_RE = /['"`]([1-9A-HJ-NP-Za-km-z]{32,44})['"`]/g;

/**
 * Token / program contracts. They appear in nearly every payment script, so
 * they say nothing about WHO is being paid and must not make two unrelated
 * payments look like the same obligation.
 */
const NON_RECIPIENT_ADDRESSES = new Set<string>([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC (Base)
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // USDC (Base Sepolia)
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT (Base)
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC (Polygon)
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e (Polygon)
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC (Ethereum)
  '0x4200000000000000000000000000000000000006', // WETH (Base)
  '0x0000000000000000000000000000000000000000',
  'epjfwdd5aufqssqem2qn1xzybapc8g4wegggkzwytdt1v', // USDC (Solana)
  'es9vmfrzacerbmjfrf4h2fyd4kconky11mcce8benwnyb', // USDT (Solana)
  'tokenkegqfezyinwajbnbgkpfxcwubvf9ss623vq5da', // SPL Token program
  '11111111111111111111111111111111', // System program
]);

const SCRIPT_EXT_RE = /\.(?:m?[jt]s|cjs|cts|py|sh|bash)$/;
const SHELL_SCRIPT_RE = /\.(?:sh|bash)$/;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_SHELL_DEPTH = 3;

/** Commands that run the script file (or stdin) they are given. */
const INTERPRETERS = new Set([
  'node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node', 'ts-node-esm', 'esno', 'vite-node',
  'python', 'python2', 'python3', 'py', 'pypy', 'pypy3',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'source', '.',
]);
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'source', '.']);

/** Prefixes that run the command after them: `timeout 30 node pay.mjs`. */
const WRAPPERS = new Set([
  'env', 'sudo', 'doas', 'exec', 'time', 'nohup', 'setsid', 'daemonize', 'nice', 'ionice', 'stdbuf',
  'timeout', 'npx', 'bunx', 'xargs', 'command',
]);
/**
 * Wrapper options that take a value (`env -u NAME`, `timeout --signal TERM`),
 * so the value is not mistaken for the wrapped program.
 */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-U', '--other-user', '-r', '--role', '-t', '--type', '-T', '--command-timeout']),
  doas: new Set(['-u', '-C']),
  xargs: new Set(['-I', '-i', '-n', '--max-args', '-P', '--max-procs', '-L', '-l', '--max-lines', '-d', '--delimiter', '-E', '-e', '-s', '--max-chars', '-a', '--arg-file']),
  npx: new Set(['-p', '--package']),
  bunx: new Set(['-p', '--package']),
};
/** Wrapper options that change directory before running the program. */
const CHDIR_FLAGS: Record<string, Set<string>> = {
  env: new Set(['-C', '--chdir']),
  sudo: new Set(['-D', '--chdir']),
};
/** Wrapper options whose value is itself a shell command: `env -S "node pay.mjs"`, `npx -c "…"`. */
const WRAPPER_COMMAND_FLAGS: Record<string, Set<string>> = {
  env: new Set(['-S', '--split-string']),
  npx: new Set(['-c', '--call']),
};

/** Two-word prefixes: `pnpm dlx tsx pay.ts`, `uv run python pay.py`. */
const WRAPPER_PAIRS = new Set(['pnpm dlx', 'pnpm exec', 'npm exec', 'yarn dlx', 'yarn exec', 'uv run', 'poetry run', 'pipenv run', 'bun run', 'deno run']);

function isInterpreter(word: string): boolean {
  const base = path.basename(word);
  return INTERPRETERS.has(base) || /^python\d+(?:\.\d+)?$/.test(base);
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
}

interface SimpleCommand {
  /** Words in order, quotes removed, redirect targets excluded. */
  words: string[];
  /** Files redirected into stdin: `node < pay.mjs`. */
  stdinFiles: string[];
  /** Here-strings fed to stdin: `node <<< "code"`. */
  hereStrings: string[];
  /** The command whose output is piped into this one: `cat pay.mjs | node`. */
  pipedFrom: SimpleCommand | null;
  /** Ended by a lone `&`: the shell returns before it finishes. */
  background: boolean;
  /** Has an output redirect to a file (`> f`, `>> f`, `&> f`). */
  writesFile: boolean;
  /** The files those output redirects write. */
  outFiles: string[];
}

/**
 * Split shell text into simple commands, honoring single/double quotes and
 * backslash escapes. Separators: newline ; & && | || ( ) $( ` . Output
 * redirects drop their target word (`> pay.mjs` writes the file, it does not
 * run it); input redirects and pipes are kept, because an interpreter reading
 * stdin runs whatever arrives there.
 */
export function splitShellCommands(text: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const fresh = (pipedFrom: SimpleCommand | null = null): SimpleCommand =>
    ({ words: [], stdinFiles: [], hereStrings: [], pipedFrom, background: false, writesFile: false, outFiles: [] });
  let current = fresh();
  let word = '';
  let inWord = false;
  let target: 'word' | 'skip' | 'stdin' | 'herestring' | 'outfile' = 'word';
  const endWord = () => {
    if (inWord) {
      if (target === 'word') current.words.push(word);
      else if (target === 'stdin') current.stdinFiles.push(word);
      else if (target === 'herestring') current.hereStrings.push(word);
      else if (target === 'outfile') current.outFiles.push(word);
      target = 'word';
    }
    word = '';
    inWord = false;
  };
  const endCommand = (opts: { pipe?: boolean; background?: boolean } = {}) => {
    endWord();
    target = 'word';
    current.background = Boolean(opts.background);
    const done = current.words.length || current.stdinFiles.length || current.hereStrings.length ? current : null;
    if (done) commands.push(done);
    current = fresh(opts.pipe ? done : null);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      if (text[i + 1] !== '\n') word += text[i + 1];
      inWord = true;
      i++;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      word += text.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) i++;
        word += text[i];
        i++;
      }
      inWord = true;
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if (c === '|') {
      if (text[i + 1] === '|') { i++; endCommand(); }
      else { if (text[i + 1] === '&') i++; endCommand({ pipe: true }); }
    } else if (c === '&') {
      if (text[i + 1] === '&') { i++; endCommand(); }
      else if (text[i + 1] === '>') {
        // `&>file` / `&>>file`: redirect both streams to a file.
        endWord();
        while (text[i + 1] === '>') i++;
        target = 'outfile';
        current.writesFile = true;
      } else {
        endCommand({ background: true });
      }
    } else if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '`') {
      endCommand();
    } else if (c === '$' && text[i + 1] === '(') {
      endCommand();
      i++;
    } else if (c === '>' || c === '<') {
      // `2>` / `0<`: a bare fd number glued to the operator is not a word.
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false; }
      endWord();
      let run = 1;
      while (text[i + 1] === c) { i++; run++; }
      if (text[i + 1] === '&') {
        // `>&2` duplicates a descriptor; there is no file target.
        i++;
        while (/\d/.test(text[i + 1] ?? '')) i++;
      } else if (c === '<') {
        // `<` stdin file, `<<` heredoc delimiter (body handled separately), `<<<` here-string.
        target = run === 1 ? 'stdin' : run === 2 ? 'skip' : 'herestring';
      } else {
        target = 'outfile';
        current.writesFile = true;
      }
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** Files a command writes or replaces through its own arguments. */
function filesWrittenBy(words: string[]): string[] {
  const base = path.basename(words[0] ?? '');
  const args = words.slice(1);
  const positional = args.filter(w => !w.startsWith('-'));
  if (base === 'tee') return positional;
  if (base === 'cp' || base === 'mv' || base === 'install' || base === 'ln' || base === 'rsync') return positional.slice(-1);
  if (base === 'sed' && args.some(w => /^-i/.test(w) || w === '--in-place')) return positional.slice(1);
  if (base === 'curl' || base === 'wget') {
    const out: string[] = [];
    args.forEach((w, k) => {
      if ((w === '-o' || w === '--output' || w === '-O' || w === '--output-document') && args[k + 1]) out.push(args[k + 1]);
    });
    return out;
  }
  return [];
}

/** An HTTP CLI call that sends a body or uses a write method. */
function isHttpWrite(words: string[]): boolean {
  const base = path.basename(words[0] ?? '');
  if (base === 'curl') {
    return words.some((w, k) =>
      /^(?:-d|--data(?:-raw|-binary|-urlencode)?|--json|-F|--form|-T|--upload-file)$/.test(w) ||
      /^--(?:data|json)/.test(w) ||
      ((w === '-X' || w === '--request') && /^(?:POST|PUT|PATCH)$/i.test(words[k + 1] ?? '')) ||
      /^-X(?:POST|PUT|PATCH)$/i.test(w));
  }
  if (base === 'wget') return words.some(w => /^--(?:post|body)-(?:data|file)/.test(w) || /^--method=(?:POST|PUT|PATCH)$/i.test(w));
  if (base === 'http' || base === 'https' || base === 'xh') return words.some(w => /^(?:POST|PUT|PATCH)$/i.test(w) || /[:=]=?/.test(w) && !/^https?:/.test(w));
  return false;
}

/** Commands that pass a file's contents through to stdout unchanged. */
const FILE_PASSTHROUGH = new Set(['cat', 'head', 'tail', 'tac', 'less', 'more']);

/**
 * Commands that only read or print. Their arguments are not a record unless
 * the output is redirected into a file: `grep unpaid ledger.json` reads,
 * `echo unpaid > ledger.txt` writes.
 */
const NON_RECORDING = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'ls', 'find',
  'jq', 'yq', 'sort', 'uniq', 'cut', 'diff', 'file', 'stat', 'echo', 'printf', 'test', '[', 'true',
  'false', 'pwd', 'which', 'type', 'date', 'git',
]);

/** Commands that detach what they run from the shell call. */
const DETACHERS = new Set(['nohup', 'setsid', 'disown', 'daemonize']);

/** Subcommands of chain CLIs that sign and send. */
const CLI_SEND_SUBCOMMANDS: Record<string, string[]> = {
  cast: ['send', 'publish'],
  solana: ['transfer', 'pay'],
  'spl-token': ['transfer'],
};

/** CLIs whose arguments are a chain or RPC lookup in their own right. */
const CHAIN_CLIS = new Set(['cast', 'solana', 'spl-token', 'curl', 'wget', 'http', 'https', 'xh']);

/** Interpreter flags whose next word is a value, not the script. */
const VALUE_FLAGS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '--input-type', '--conditions', '-C',
  '-W', '-X', '--env-file',
]);
/** Interpreter flags whose next word is inline code. */
const INLINE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

interface CommandRun {
  /** Script files it runs (unresolved). */
  scripts: string[];
  /** Interpreter that reads stdin / the script, if any. */
  interpreter: string | null;
  /** Inline program text: `node -e CODE`, `python3 -c CODE`. */
  inlineCode: string[];
  /** Inline shell text: `bash -c CMD`, `eval CMD`. */
  inlineShell: string[];
  /** A chain CLI invocation (`cast receipt …`), as text. */
  cli: string | null;
  /** Directory a wrapper switches to first: `env -C dir`, `sudo -D dir`. */
  chdir: string | null;
}

/** What one simple command runs, after env assignments and wrappers like `timeout` or `npx`. */
function analyzeCommand(words: string[]): CommandRun {
  const run: CommandRun = { scripts: [], interpreter: null, inlineCode: [], inlineShell: [], cli: null, chdir: null };
  let i = 0;
  const skipAssignmentsAndFlags = () => {
    while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || words[i].startsWith('-'))) i++;
  };
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
  for (let guard = 0; guard < 8 && i < words.length; guard++) {
    const base = path.basename(words[i]);
    if (WRAPPER_PAIRS.has(`${base} ${words[i + 1] ?? ''}`)) {
      i += 2;
      skipAssignmentsAndFlags();
      continue;
    }
    if (WRAPPERS.has(base)) {
      i++;
      // Options (and their values), assignments and bare numbers:
      // `timeout --signal TERM 30`, `nice -n 5`, `env -u X FOO=1`, `sudo -u bob --`.
      const valueFlags = WRAPPER_VALUE_FLAGS[base];
      const commandFlags = WRAPPER_COMMAND_FLAGS[base];
      while (i < words.length) {
        const w = words[i];
        if (w === '--') { i++; break; }
        if (commandFlags?.has(w)) {
          if (words[i + 1] !== undefined) run.inlineShell.push(words[i + 1]);
          return run;
        }
        const eq = /^(--?[\w-]+)=([\s\S]*)$/.exec(w);
        if (eq && commandFlags?.has(eq[1])) {
          run.inlineShell.push(eq[2]);
          return run;
        }
        if (eq && CHDIR_FLAGS[base]?.has(eq[1])) { run.chdir = eq[2]; i++; continue; }
        if (valueFlags?.has(w)) {
          if (CHDIR_FLAGS[base]?.has(w) && words[i + 1] !== undefined) run.chdir = words[i + 1];
          i += 2;
          continue;
        }
        // Glued short option with value: `-uNODE_OPTIONS`, `-n5`, `-oL`.
        if (/^[A-Za-z_]\w*=/.test(w) || w.startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(w)) { i++; continue; }
        break;
      }
      continue;
    }
    break;
  }
  const cmd = words[i];
  if (!cmd) return run;
  const base = path.basename(cmd);
  if (base === 'eval') {
    run.inlineShell.push(words.slice(i + 1).join(' '));
    return run;
  }
  if (CHAIN_CLIS.has(base)) {
    // Global options can sit between the CLI and its subcommand
    // (`solana --url mainnet-beta transfer …`). Name the money-moving
    // subcommand explicitly so the send patterns see `solana transfer`.
    const args = words.slice(i + 1);
    const sub = CLI_SEND_SUBCOMMANDS[base]?.find(name => args.includes(name));
    run.cli = (sub ? `${base} ${sub}\n` : '') + words.slice(i).join(' ');
    return run;
  }
  if (SCRIPT_EXT_RE.test(cmd)) {
    run.scripts.push(cmd);
    return run;
  }
  if (!isInterpreter(cmd)) return run;
  run.interpreter = base;
  const isShell = SHELL_INTERPRETERS.has(base);
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j];
    // `bash -lc CMD`, `sh -ec CMD`: a short-flag cluster ending in c.
    const shellInline = isShell && /^-[a-zA-Z]*c$/.test(w);
    if (shellInline || INLINE_CODE_FLAGS.has(w)) {
      const code = words[j + 1];
      if (code !== undefined) (isShell ? run.inlineShell : run.inlineCode).push(code);
      return run;
    }
    const eq = /^(--eval|--print)=([\s\S]*)$/.exec(w);
    if (eq) {
      run.inlineCode.push(eq[2]);
      return run;
    }
    // `python3 -m pkg`: a module, not a file.
    if (w === '-m') return run;
    if (VALUE_FLAGS.has(w)) { j++; continue; }
    if (w.startsWith('-')) continue;
    // The first positional is the program; later ones are its arguments.
    if (SCRIPT_EXT_RE.test(w) || isShell) run.scripts.push(w);
    return run;
  }
  return run;
}

interface Heredoc {
  /** Shell text before the `<<` marker on its line, back to the previous separator. */
  head: string;
  /** Shell text after the marker on its line. */
  tail: string;
  body: string;
}

/** Pull heredoc bodies out so their contents are not mistaken for shell. */
function extractHeredocs(text: string): { shell: string; heredocs: Heredoc[] } {
  const lines = text.split('\n');
  const out: string[] = [];
  const heredocs: Heredoc[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const markers = [...line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g)];
    for (const m of markers) {
      const stripTabs = m[1] === '-';
      const delim = m[3];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const candidate = stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
        if (candidate === delim) break;
        body.push(lines[i]);
        i++;
      }
      const before = line.slice(0, m.index);
      const head = before.split(/;|&&|\|\||\||\(|\$\(/).pop() ?? '';
      heredocs.push({ head, tail: line.slice((m.index ?? 0) + m[0].length), body: body.join('\n') });
    }
  }
  return { shell: out.join('\n'), heredocs };
}

function readScript(resolved: string): string | null {
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return null;
    return fs.readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
}

interface Collected {
  /** Text the command writes or prints rather than runs (echo/printf/tee
   *  arguments, heredocs written to files). Used for outcome records. */
  data: string[];
  /** Something ran detached from the shell call (`&`, nohup, setsid, …). */
  detached: boolean;
  /** Only code that actually executes: inline programs, interpreted
   *  heredocs, script files, chain CLI calls. Sends and lookups are judged on
   *  this, so `grep 'sendTransaction(' f` or a lookup merely printed into a
   *  file (`printf '…getTransactionReceipt…' > c.mjs`) never counts. */
  code: string[];
}

function collect(command: string, cwd: string, depth: number, out: Collected, seen: Set<string>): void {
  const { shell, heredocs } = extractHeredocs(command);

  // A heredoc is code when an interpreter reads it (`node <<EOF`, `cat <<EOF | python3`).
  // Otherwise it is data — usually a file being written (`cat > pay.mjs <<EOF`),
  // which counts as code if this same command then runs that file.
  const writtenFiles = new Map<string, string>();
  for (const doc of heredocs) {
    const headRun = analyzeCommand(splitShellCommands(doc.head).pop()?.words ?? []);
    const pipeRun = /\|/.test(doc.tail)
      ? analyzeCommand(splitShellCommands(doc.tail.replace(/^[^|]*\|/, '')).shift()?.words ?? [])
      : null;
    const interp = headRun.interpreter ?? pipeRun?.interpreter ?? null;
    if (interp) {
      if (SHELL_INTERPRETERS.has(interp)) {
        if (depth < MAX_SHELL_DEPTH) collect(doc.body, cwd, depth + 1, out, seen);
        else out.code.push(doc.body);
      } else {
        out.code.push(doc.body);
      }
      continue;
    }
    out.data.push(doc.body);
    const target = /(?:>>?|\btee\s+(?:-a\s+)?)\s*(['"]?)([^\s'";&|<>]+)\1/.exec(doc.head + doc.tail);
    if (target) writtenFiles.set(path.basename(expandHome(target[2])), doc.body);
  }

  const commands = splitShellCommands(shell);
  // Files this same command writes or replaces before (or while) running
  // things: their on-disk contents are stale, so the command text that writes
  // them is evidence too.
  const modified = new Set<string>([...writtenFiles.keys()]);
  for (const c of commands) {
    for (const f of c.outFiles) modified.add(path.basename(expandHome(f)));
    for (const f of filesWrittenBy(c.words)) modified.add(path.basename(expandHome(f)));
  }

  for (const simple of commands) {
    const { words } = simple;
    if (words[0] === 'cd' || words[0] === 'pushd') {
      const dir = words.slice(1).find(w => !w.startsWith('-'));
      cwd = dir ? path.resolve(cwd, expandHome(dir)) : (process.env.HOME ?? cwd);
      continue;
    }
    const run = analyzeCommand(words);
    const runsSomething = Boolean(
      run.interpreter || run.cli || run.scripts.length || run.inlineCode.length || run.inlineShell.length,
    );
    if (simple.background || words.some(w => DETACHERS.has(path.basename(w)))) out.detached = true;
    if (!runsSomething && (simple.writesFile || !NON_RECORDING.has(path.basename(words[0] ?? '')))) {
      out.data.push(words.join(' '));
    }
    // A program whose output goes into a file writes what it prints
    // (`node -e 'console.log("unpaid")' > ledger.txt`), and an HTTP call
    // with a body or a write method sends what it carries. A send's own
    // text is left out: its error messages are not outcome records.
    const httpWrite = Boolean(run.cli && isHttpWrite(words));
    if (runsSomething && (simple.writesFile || httpWrite)) {
      const own = [words.join(' '), ...run.inlineCode];
      for (const t of own) if (!isPaymentSend(t)) out.data.push(t);
    }
    // An interpreter with no program argument runs its stdin: `node < pay.mjs`,
    // `cat pay.mjs | node`, `python3 <<< "code"`.
    if (run.interpreter && !run.scripts.length && !run.inlineCode.length && !run.inlineShell.length) {
      run.scripts.push(...simple.stdinFiles);
      const source = simple.pipedFrom;
      if (source && FILE_PASSTHROUGH.has(path.basename(source.words[0] ?? ''))) {
        run.scripts.push(...source.words.slice(1).filter(w => !w.startsWith('-') && !/^\d+$/.test(w)));
      }
      for (const hs of simple.hereStrings) {
        if (SHELL_INTERPRETERS.has(run.interpreter)) run.inlineShell.push(hs);
        else run.inlineCode.push(hs);
      }
    }
    const runDir = run.chdir ? path.resolve(cwd, expandHome(run.chdir)) : cwd;
    for (const code of run.inlineCode) out.code.push(code);
    if (run.cli) out.code.push(run.cli);
    for (const inner of run.inlineShell) {
      // `bash -c "node pay.mjs"` runs in the caller's directory.
      if (depth < MAX_SHELL_DEPTH) collect(inner, runDir, depth + 1, out, seen);
      else out.code.push(inner);
    }
    for (const script of run.scripts) {
      const name = expandHome(script);
      const fresh = writtenFiles.get(path.basename(name));
      if (fresh !== undefined) out.code.push(fresh);
      else if (modified.has(path.basename(name))) out.code.push(command);
      const resolved = path.resolve(runDir, name);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const content = readScript(resolved);
      if (content === null) {
        // Not on disk yet (written earlier in this same command by echo,
        // printf or a heredoc): the whole command is the best evidence.
        if (fresh === undefined) out.code.push(command);
        continue;
      }
      if (SHELL_SCRIPT_RE.test(resolved) || (run.interpreter && SHELL_INTERPRETERS.has(run.interpreter))) {
        // `bash scripts/run.sh` runs with the CALLER's working directory, not
        // the script's own: relative paths inside resolve from here.
        if (depth < MAX_SHELL_DEPTH) collect(content, runDir, depth + 1, out, seen);
        else out.code.push(content);
      } else {
        out.code.push(content);
        if (simple.writesFile && !isPaymentSend(content)) out.data.push(content);
      }
    }
  }
}

export interface BashExecution {
  /** Only code that executes. Payment-send and reconciliation detection. */
  code: string;
  /** What it writes or prints rather than runs. Outcome-record detection. */
  data: string;
  /** Part of it keeps running after the Bash call returns. */
  detached: boolean;
}

/**
 * What a Bash run will actually execute: the shell text, heredocs an
 * interpreter reads, inline programs (`node -e`, `bash -c`, `eval`), chain
 * CLI calls, and the contents of every local script file it runs — resolved
 * through `cd`, quoting and wrappers like `timeout` or `npx`. A model that
 * writes `pay.mjs` and then runs `bash -c 'node "pay scripts/pay.mjs"'` must
 * not slip past a check that only reads the command line; a command that
 * merely reads or writes a script (`cat pay.mjs`, `printf … > check.mjs`)
 * must not count as running it.
 */
export function analyzeBash(command: string, workingDir: string): BashExecution {
  const out: Collected = { code: [], data: [], detached: false };
  collect(command, workingDir, 0, out, new Set());
  return { code: out.code.join('\n'), data: out.data.join('\n'), detached: out.detached };
}

export function bashExecutedText(command: string, workingDir: string): string {
  return analyzeBash(command, workingDir).code;
}

export function isPaymentSend(text: string): boolean {
  return SEND_PATTERNS.some(re => re.test(text));
}

export function isReconciliation(text: string): boolean {
  return !isPaymentSend(text) && RECONCILE_PATTERNS.some(re => re.test(text));
}

/** Addresses that may identify who is being paid, lower-cased. */
export function extractRecipients(text: string, ownAddresses: string[] = []): string[] {
  const own = new Set(ownAddresses.map(a => a.toLowerCase()));
  const found = new Set<string>();
  for (const m of text.matchAll(EVM_ADDRESS_RE)) found.add(m[0].toLowerCase());
  for (const m of text.matchAll(QUOTED_BASE58_RE)) found.add(m[1].toLowerCase());
  return [...found].filter(a => !NON_RECIPIENT_ADDRESSES.has(a) && !own.has(a));
}

/**
 * Why a payment attempt's outcome is unknown, or null when the result is
 * conclusive (clean success, or an error with no sign anything was sent).
 */
export function ambiguousOutcomeReason(
  output: string,
  isError: boolean | undefined,
  ranInBackground: boolean,
): string | null {
  if (ranInBackground) return 'it was detached to the background, so its result was never observed';
  const marker = AMBIGUOUS_OUTCOME_RE.exec(output);
  if (marker) return `the run ended with "${marker[0].trim()}"`;
  if (isError && TX_HASH_RE.test(output)) {
    TX_HASH_RE.lastIndex = 0;
    return 'it errored after a transaction hash was produced';
  }
  TX_HASH_RE.lastIndex = 0;
  return null;
}

export function extractTxHashes(output: string): string[] {
  return [...new Set([...output.matchAll(TX_HASH_RE)].map(m => m[0]))];
}

/**
 * Recording an outcome as failed / unpaid. Matched against the input of
 * non-read tools (an outcome tool, a ledger write, a memory note) while an
 * attempt is unknown.
 */
const NEGATIVE_OUTCOME_RE = new RegExp(
  [
    '\\bunpaid\\b',
    '\\bnot\\s+(?:been\\s+)?paid\\b',
    '\\b(?:payment|transfer|transaction|tx|send)\\s+(?:has\\s+|was\\s+)?failed\\b',
    '\\bfailed\\s+(?:payment|transfer|transaction)\\b',
    '["\']?(?:status|outcome|result|state)["\']?\\s*[:=]\\s*["\']?(?:failed|failure|unpaid|not_paid|not paid)\\b',
  ].join('|'),
  'i',
);

export function recordsNegativeOutcome(text: string): boolean {
  return NEGATIVE_OUTCOME_RE.test(text);
}

/** Code that persists something: a file, a database row, or a write request. */
const PERSIST_RE = new RegExp(
  [
    '\\b(?:writeFile|appendFile)(?:Sync)?\\b',
    '\\bcreateWriteStream\\b',
    '\\bfs\\.(?:promises\\.)?write',
    '\\.write(?:_text|_bytes)?\\s*\\(',
    '\\bopen\\s*\\([^)]*[\'"][wax]\\+?b?[\'"]',
    '\\bjson\\.dump\\s*\\(',
    '\\bINSERT\\s+INTO\\b',
    '\\bUPDATE\\s+\\w+\\s+SET\\b',
    'method\\s*:\\s*[\'"](?:POST|PUT|PATCH)[\'"]',
    '\\brequests\\.(?:post|put|patch)\\s*\\(',
    '\\baxios\\.(?:post|put|patch)\\s*\\(',
  ].join('|'),
  'i',
);

/**
 * Whether code a Bash run executes records a failed/unpaid outcome: it
 * persists something AND carries a negative outcome. A lookup that merely
 * prints `paid` / `unpaid` writes nothing and passes; a ledger script that
 * writes `{"status":"unpaid"}` does not.
 */
export function codeRecordsNegativeOutcome(code: string): boolean {
  return PERSIST_RE.test(code) && NEGATIVE_OUTCOME_RE.test(code);
}

// ─── State ─────────────────────────────────────────────────────────────────

export interface PaymentAttempt {
  id: number;
  turn: number;
  at: number;
  /** One-line preview of the command that sent it. */
  command: string;
  /** Candidate recipients; empty = could not tell, so it matches any send. */
  recipients: string[];
  /** The paying wallet(s), so a sender nonce/balance lookup counts as a check. */
  senders: string[];
  reason: string;
  txHashes: string[];
  /** Set once a read-only receipt/nonce/balance lookup ran after it. */
  reconciled: boolean;
  /** Set when the user explicitly allowed a new payment despite it. */
  overriddenByUser: boolean;
}

export function attemptsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const set = new Set(a);
  return b.some(x => set.has(x));
}

export function commandPreview(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? flat.slice(0, 157) + '...' : flat;
}

export function describeAttempt(a: PaymentAttempt): string {
  const who = a.recipients.length ? a.recipients.join(', ') : 'recipient not identifiable';
  const hashes = a.txHashes.length ? `; tx hash(es) seen: ${a.txHashes.join(', ')}` : '; no tx hash was printed';
  return `#${a.id} (${who}) — ${a.reason}${hashes}. Command: ${a.command}`;
}

export function unknownOutcomeNotice(a: PaymentAttempt): string {
  return [
    '',
    '',
    `[Franklin payment guard] OUTCOME UNKNOWN — payment attempt ${describeAttempt(a)}`,
    'This is NOT a failure. The transaction may have been broadcast and may settle (or already have settled).',
    '- Do not send another payment for this obligation. Franklin will hold any new send to the same recipient until the user decides.',
    '- Reconcile first with READ-ONLY checks: the receipt for any tx hash above, the sender\'s nonce, and the sender/recipient token balances (or the venue\'s status endpoint).',
    '- Do not record this payment as failed or unpaid unless a reconciliation proves it did not settle. If you cannot establish the outcome, record it as UNKNOWN and tell the user exactly what is unknown.',
  ].join('\n');
}

// ─── Persistence ───────────────────────────────────────────────────────────
//
// An unknown outcome must survive the process: `franklin --resume` rebuilds
// the guard, and a hold that lived only in memory would let the very next
// rewritten send through. One JSON file per session id.

export function paymentHoldsDir(): string {
  return path.join(BLOCKRUN_DIR, 'payment-holds');
}

function holdsPath(sessionId: string): string {
  return path.join(paymentHoldsDir(), `${sessionId.replace(/[^\w.-]/g, '_')}.json`);
}

export function loadPaymentAttempts(sessionId: string): PaymentAttempt[] {
  try {
    const raw = JSON.parse(fs.readFileSync(holdsPath(sessionId), 'utf-8')) as { attempts?: unknown };
    if (!Array.isArray(raw.attempts)) return [];
    return raw.attempts.filter((a): a is PaymentAttempt =>
      !!a && typeof a === 'object' && typeof (a as PaymentAttempt).id === 'number' && Array.isArray((a as PaymentAttempt).recipients),
    ).map(a => ({ ...a, senders: Array.isArray(a.senders) ? a.senders : [], txHashes: Array.isArray(a.txHashes) ? a.txHashes : [] }));
  } catch {
    return [];
  }
}

export function savePaymentAttempts(sessionId: string, attempts: PaymentAttempt[]): void {
  try {
    fs.mkdirSync(paymentHoldsDir(), { recursive: true });
    const file = holdsPath(sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessionId, attempts }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort: the in-memory hold still applies for this process */
  }
}
