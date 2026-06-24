/**
 * Bash Risk Classifier — lightweight Guardian for Franklin.
 *
 * Classifies bash commands into three risk levels:
 *   safe      — read-only or standard dev commands → auto-approve
 *   normal    — typical mutations (file writes, installs) → default ask behavior
 *   dangerous — destructive/irreversible operations → always ask, with warning
 *
 * Inspired by OpenAI Codex's Guardian system, but deterministic pattern matching
 * instead of an LLM call. Fast, predictable, zero-cost.
 */

export type BashRiskLevel = 'safe' | 'normal' | 'dangerous';

export interface BashRiskResult {
  level: BashRiskLevel;
  reason?: string; // shown in permission UI for dangerous commands
}

// ─── Dangerous Patterns ──────────────────────────────────────────────────
// Checked first. If ANY pattern matches, the command is dangerous.

const DANGEROUS_PATTERNS: [RegExp, string][] = [
  // Destructive file operations
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+[/~]/, 'recursive delete on root/home'],
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f/, 'forced recursive delete'],
  [/\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, 'forced recursive delete'],
  [/\brm\s+-[a-zA-Z]*f\s+\//, 'forced delete at filesystem root'],
  [/\bmkfs\b/, 'format filesystem'],
  [/\bdd\s+.*of=/, 'raw disk write'],
  [/\btruncate\s+-s\s+0\b/, 'truncate file to zero'],
  [/>\s*\/dev\/(sd|nvme|disk|hd)/, 'write to raw block device'],

  // Silently overwriting with mv/cp
  [/\bmv\s+-f\b/, 'mv -f overwrites target silently'],
  [/\bcp\s+-[a-zA-Z]*f[a-zA-Z]*r/, 'cp -rf can overwrite directory trees silently'],

  // Writes to system-level paths — most agents should NEVER touch these.
  // Redirections (`>`, `>>`) or tee'ing to /etc/, /usr/, /boot/, /var/lib/ etc.
  [/>\s*\/(etc|usr|bin|sbin|boot|lib|lib64|var\/lib|sys|proc)\//, 'write to system path'],
  [/\btee\s+.*\s+\/(etc|usr|bin|sbin|boot|lib|lib64|var\/lib|sys|proc)\//, 'tee to system path'],
  // Extract tar/zip at filesystem root — classic traversal foot-gun.
  [/\btar\s+.*-C\s+\/(?!tmp|var\/tmp|home)/, 'extract archive to system path'],
  [/\bunzip\s+.*-d\s+\/(?!tmp|var\/tmp|home)/, 'unzip to system path'],

  // Shell-out of untrusted text
  [/\beval\s/, 'eval executes arbitrary shell'],
  [/\bexec\s+(bash|sh|zsh)/, 'exec replaces the shell process'],

  // Git irreversible operations
  [/\bgit\s+push\s+.*--force\b/, 'force push'],
  [/\bgit\s+push\s+-f\b/, 'force push'],
  [/\bgit\s+reset\s+--hard\b/, 'hard reset — discards uncommitted changes'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean — deletes untracked files'],
  [/\bgit\s+checkout\s+--\s+\./, 'discard all working changes'],
  [/\bgit\s+branch\s+-D\b/, 'force delete branch'],
  [/\bgit\s+filter-(repo|branch)\b/, 'history rewrite'],

  // Database destructive
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, 'drop database objects'],
  [/\bTRUNCATE\s+TABLE\b/i, 'truncate table'],
  [/\bDELETE\s+FROM\s+\S+\s*;?\s*$/i, 'DELETE without WHERE'],

  // System-level danger
  [/\bchmod\s+(-R\s+)?777\b/, 'world-writable permissions'],
  [/\bchown\s+-R\s+\S+\s+\//, 'recursive chown at root'],
  // Pipe-to-shell: catch sudo/env prefixes and common shell variants (bash/sh/zsh/ksh/dash/fish).
  // The optional `-e`/`-x` flags after the shell binary are intentionally allowed by \b;
  // what we block is the routing of downloaded content into an interpreter.
  [/\bcurl\s+.*\|\s*(sudo\s+)?(env\s+\S*\s*)?(ba|z|k|da|fi)?sh\b/, 'pipe URL to shell'],
  [/\bwget\s+.*\|\s*(sudo\s+)?(env\s+\S*\s*)?(ba|z|k|da|fi)?sh\b/, 'pipe URL to shell'],
  // Command substitution of a downloader into argv — `$(curl …)` or `` `curl …` ``.
  [/\$\(\s*(curl|wget|fetch)\b/, 'command substitution of network downloader'],
  [/`\s*(curl|wget|fetch)\b[^`]*`/, 'backtick substitution of network downloader'],
  // Privilege escalation wrappers to destructive ops — order matters: the
  // specific `sudo rm` pattern is listed first so its tailored message wins.
  [/\bsudo\s+rm\b/, 'sudo delete'],
  [/\b(sudo|doas|su\s+-c)\s+.*\b(mv|dd|chmod|chown|mkfs|shutdown|reboot)\b/, 'privileged destructive op'],

  // sed -i (in-place) on any system path
  [/\bsed\s+-i(\s+'')?\s+.*\/(etc|usr|bin|sbin|boot|lib)\//, 'in-place edit of system path'],

  // Kill/shutdown
  [/\bkill\s+-9\s+-1\b/, 'kill all processes'],
  [/\bkillall\s/, 'killall targets matching processes globally'],
  [/\bshutdown\b/, 'system shutdown'],
  [/\breboot\b/, 'system reboot'],
  [/\bpoweroff\b/, 'system poweroff'],

  // Cryptocurrency key exfiltration / secret exposure
  [/\bcat\s+.*\.env(\.\w+)?\s*\|/, 'env file piped — potential secret exfiltration'],
  [/\bcat\s+.*(\.ssh|\.gnupg)\/.*\s*\|/, 'ssh/gpg key piped — potential secret exfiltration'],
];

// ─── Safe Commands ────────────────────────────────────────────────────────
// If ALL segments use these commands, auto-approve.

const SAFE_COMMANDS = new Set([
  // Filesystem read-only
  'ls', 'cat', 'head', 'tail', 'wc', 'du', 'df', 'file', 'stat', 'tree',
  'find', 'grep', 'rg', 'ag', 'ack', 'which', 'whereis', 'type',
  'echo', 'printf', 'date', 'whoami', 'hostname', 'uname', 'printenv',
  'pwd', 'realpath', 'dirname', 'basename',
  // Text processing (read-only when not redirecting)
  'jq', 'yq', 'sort', 'uniq', 'cut', 'tr', 'diff', 'comm', 'less', 'more',
  'wc',
  // NB: `xargs` and `tee` are intentionally NOT here — xargs executes an
  // arbitrary wrapped command (`... | xargs rm -f`) and tee WRITES files
  // (`echo evil | tee ~/.zshrc`), so neither may auto-approve as "safe".
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote',
  'blame', 'shortlog', 'describe', 'rev-parse', 'rev-list',
  'ls-files', 'ls-tree', 'ls-remote', 'config', 'reflog',
]);

const SAFE_PKG_SUBCOMMANDS = new Set([
  'test', 'run', 'list', 'ls', 'info', 'view', 'show',
  'outdated', 'audit', 'start', 'dev', 'serve', 'lint', 'check',
  'why', 'explain', 'doctor',
]);

const SAFE_CARGO_SUBCOMMANDS = new Set([
  'test', 'check', 'clippy', 'build', 'run', 'bench', 'doc',
  'fmt', 'tree', 'metadata', 'verify-project',
]);

// Env vars that may be stripped as a benign command PREFIX (`LANG=C ls`). These
// only affect locale/display — none change code loading, library injection, or
// interpreter behavior. Anything NOT on this list (BASH_ENV, LD_PRELOAD,
// DYLD_INSERT_LIBRARIES, PERL5OPT, NODE_OPTIONS, PATH, IFS, a custom var, …) is
// treated as an execution-hijack risk and forces a prompt.
const BENIGN_ENV_PREFIXES =
  /^(?:LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|COLUMNS|LINES|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|GREP_COLOR|GREP_COLORS)$/;

// ─── Classifier ──────────────────────────────────────────────────────────

export function classifyBashRisk(command: string): BashRiskResult {
  // 1. Check dangerous patterns first (highest priority)
  for (const [pattern, reason] of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'dangerous', reason };
    }
  }

  // 2. Check if every segment is a known-safe command. Split on ALL bash
  // command separators — &&, ||, ;, |, a lone & (background), and newline/CR —
  // so an injected second command (`pwd\nnpm install evil`, `pwd & node x`) is
  // classified on its own rather than hiding behind a benign first word. (`&&`
  // is matched before the lone `&`; numeric fd dups like `2>&1` have no
  // standalone `&` and are handled per-segment by the redirect check.)
  const segments = command.split(/\s*(?:&&|\|\||[;|]|(?<![>&])&(?![&>])|[\n\r])\s*/);
  let allSafe = true;

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    if (!isSegmentSafe(trimmed)) {
      allSafe = false;
      break;
    }
  }

  if (allSafe && segments.some(s => s.trim().length > 0)) {
    return { level: 'safe' };
  }

  return { level: 'normal' };
}

function isSegmentSafe(segment: string): boolean {
  // The shell strips quotes and backslash-escapes BEFORE opening a path, so a
  // sensitive filename can be spliced to dodge a literal regex: `.block''run`,
  // `.block"run"`, `'.blockrun'`, `.\blockrun` all resolve to `.blockrun` at the
  // OS but read as non-contiguous text to a regex. Match the DENY patterns below
  // against a normalized copy that mimics the shell's quote/escape removal, so no
  // quoting arrangement of a wallet/secret path can reach 'safe'. (Over-matching
  // here only ever prompts — it never blocks.)
  const norm = segment.replace(/\\(.)/g, '$1').replace(/['"]/g, '');

  // Never auto-approve a command that touches the wallet key store. Matching the
  // FILENAME is hopeless — it's trivially obfuscated. So match the DIRECTORY: any
  // reference to ~/.blockrun forces a prompt. (The file Read/Write/Edit tools
  // have a separate canonicalized guard; this is the best-effort net for the shell.)
  if (/\.blockrun/i.test(norm)) {
    return false;
  }
  // Relative reads with no `.blockrun` in the text (e.g. the cwd is the wallet
  // dir): match the known key/secret basenames broadly (any *wallet*.json/.key).
  if (/(?<![\w-])(?:\.solana-session(?:-key2)?|\.session|[\w-]*wallet[\w-]*\.(?:json|key))(?![\w-])/i.test(norm)) {
    return false;
  }
  // Command/process substitution runs an arbitrary INNER command the classifier
  // can't see (`echo $(node evil)`, `cat <(touch x)`) — never safe.
  if (/\$\(|`|<\(|>\(/.test(segment)) {
    return false;
  }
  // ANSI-C (`$'\x6e'`) and locale (`$"..."`) quoting decode/expand to text the
  // classifier can't resolve — and which the dequote pass above can't statically
  // evaluate (`~/.blockru$'\x6e'/.session` → `~/.blockrun/.session`). Match it as
  // an OPENING quote (at a token boundary) or by its tell-tale escape (`$'\`), so
  // a `grep 'foo$'` regex anchor — a `$` before a CLOSING quote — is left safe.
  if (/(?:^|[\s=(:,])\$['"]|\$['"]\\/.test(segment)) {
    return false;
  }
  // Parameter expansion (`$VAR`, `${VAR}`) expands to text the classifier also
  // can't see, so a bare `$HOME` glob can reach the wallet store exactly like
  // `$(...)` — `cat $HOME/.bl*/.s*` evaded the rooted-glob guard below because it
  // starts with `$`, not `~`/`.`/`/`. Treat any `$NAME` / `${NAME}` as opaque.
  // (`$` followed by a non-name char — e.g. a `grep 'foo$'` regex anchor, `$?`,
  // `$5` — is left alone so common read commands still auto-approve.)
  if (/\$\{?[A-Za-z_]/.test(segment)) {
    return false;
  }
  // A glob/brace in an explicit PATH (a token rooted at ~, ., or /) expands AFTER
  // this guard and can reach the wallet store (`cat ~/.b*/.s*`) or a sensitive
  // file. Bare cwd globs (`*.md`, `src/*.ts`) have no such prefix and stay safe.
  if (/(?:^|\s)(?:~|\.|\/)\S*[*?[{]/.test(norm)) {
    return false;
  }
  // Output redirection to a FILE target is a write — block it for EVERY segment,
  // not just SAFE_COMMANDS ones. git/npm/cargo/bun resolve through their own
  // branches below and used to skip the redirect check, so `git status > ~/.bashrc`
  // (overwrite a shell rc → RCE on next shell) and `npm test > attack.sh`
  // auto-approved. Allows numeric fd dups (`2>&1`, `>&2` — a digit follows `>`).
  if (/>[>|&]?\s*[^\s&|0-9]/.test(segment)) {
    return false;
  }
  // Reading host credential stores should PROMPT — mirror the Write tool's
  // dangerous-path block so `cat ~/.ssh/id_rsa`, `cat ~/.aws/credentials`,
  // `cat ~/.gnupg/secring.gpg`, gcloud tokens, `.npmrc`/`.pgpass`/`.netrc`, and
  // docker registry creds don't auto-approve secrets into model context.
  if (/(?:^|[\s/~=])\.(?:ssh|aws|gnupg|kube)(?:\/|$|\s)/i.test(norm)) return false;
  if (/\bid_(?:rsa|dsa|ecdsa|ed25519)\b/i.test(norm)) return false;
  if (/(?:^|[\s/~=])\.(?:npmrc|pgpass|netrc)(?:$|\s)/i.test(norm)) return false;
  if (/gcloud\/(?:credentials|access_tokens|application_default)|\.docker\/config/i.test(norm)) return false;
  // Other plaintext credential / key stores a bare `cat` would dump into context.
  // Denylists lag the real set of secret files, so be generous — over-prompting
  // is safe. Includes the Solana CLI default keypair (`~/.config/solana/id.json`),
  // a SPENDABLE wallet that lives outside Franklin's own ~/.blockrun store.
  if (/(?:^|[\s/~=])\.git-credentials(?:$|\s)/i.test(norm)) return false;
  if (/(?:^|[\s/~=])\.(?:bash|zsh|sh|python|node_repl|mysql|psql|irb)_history(?:$|\s)/i.test(norm)) return false;
  if (/(?:git|gh)\/(?:credentials|hosts\.ya?ml|hosts\.json)\b/i.test(norm)) return false;
  if (/\.cargo\/credentials|rclone\/rclone\.conf|(?:^|[\s/~=])\.config\/solana(?:\/|\b)|solana\/id\.json/i.test(norm)) return false;
  if (/(?:keychain(?:-db)?|\.keychain)\b|\bKeychains\/|\blogins\.json\b/i.test(norm)) return false;

  // Parse into words. An env-assignment PREFIX (`FOO=bar cmd …`) is a real
  // assignment only in the LEADING run before the command word — a later `x=y`
  // is just an argument (`grep x=y file`). Walk the leading run: reject the
  // segment if any assignment names a code-loading / execution-hijack var, so a
  // benign-looking base command can't smuggle one (`BASH_ENV=./rc ls`,
  // `LD_PRELOAD=/x.so cat f`). Only locale/display vars strip silently.
  const rawWords = segment.split(/\s+/).filter(Boolean);
  let envPrefixCount = 0;
  for (const w of rawWords) {
    const eq = w.indexOf('=');
    // Stop at the first token that isn't a `NAME=value` assignment — that's the command.
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(w.slice(0, eq))) break;
    if (!BENIGN_ENV_PREFIXES.test(w.slice(0, eq).toUpperCase())) return false;
    envPrefixCount++;
  }
  const words = rawWords.slice(envPrefixCount);
  let idx = 0;
  let cmd = words[idx] || '';

  // Strip harmless prefixes
  while (['time', 'nice'].includes(cmd) && idx < words.length - 1) {
    cmd = words[++idx] || '';
  }

  // sudo → not safe (even if the underlying command is safe)
  if (cmd === 'sudo') return false;

  const baseName = cmd.split('/').pop() || cmd;
  const argIdx = idx + 1;
  const subCmd = words[argIdx] || '';

  // git
  if (baseName === 'git') {
    if (!SAFE_GIT_SUBCOMMANDS.has(subCmd)) return false;
    // `config` is read-only ONLY in get/list form. A bare `git config key value`
    // WRITES — and `--global` escapes the repo to plant an exec hook via
    // core.pager/core.editor/alias.x (`git config core.pager "node evil.js"`).
    // Count positional args after `config`: 2+ (key + value) is a write; explicit
    // write flags (--add/--unset/…) also force a prompt.
    if (subCmd === 'config') {
      const cfgPositionals = segment
        .replace(/^[^]*?\bconfig\b/, '')
        .split(/\s+/)
        .filter((w) => w && !w.startsWith('-'));
      const writeFlag = /(?:^|\s)--(?:add|unset(?:-all)?|replace-all|remove-section|rename-section|edit|set)\b/.test(segment);
      if (cfgPositionals.length >= 2 || writeFlag) return false;
    }
    // `git remote add/set-url/remove/rename/…` mutate remotes (can point at an
    // attacker repo). Only the read forms (`git remote`, `git remote -v`) are safe.
    if (subCmd === 'remote' && /(?:^|\s)(?:add|set-url|set-head|set-branches|remove|rm|rename|prune|update)\b/.test(segment)) {
      return false;
    }
    // `branch`/`tag` read by default, but their delete/rename/copy/force flags
    // silently mutate refs (lose local commits). `branch -D` is already a
    // dangerous-pattern; gate the rest (incl. lowercase `-d`, `-m`, `-f`) here.
    // Creating a branch/tag (a bare positional) stays safe — only ref destruction prompts.
    if (subCmd === 'branch' && /(?:^|\s)-(?:d|D|m|M|c|C|f)\b|(?:^|\s)--(?:delete|move|copy|force|unset-upstream)\b/.test(segment)) {
      return false;
    }
    if (subCmd === 'tag' && /(?:^|\s)-(?:d|f)\b|(?:^|\s)--(?:delete|force)\b/.test(segment)) {
      return false;
    }
    return true;
  }

  // npm / yarn / pnpm / bun / npx
  if (['npm', 'npx', 'yarn', 'pnpm', 'bun'].includes(baseName)) {
    // "npm run <script>" — safe (dev servers, linters, etc.)
    if (subCmd === 'run') return true;
    return SAFE_PKG_SUBCOMMANDS.has(subCmd);
  }

  // cargo
  if (baseName === 'cargo') {
    return SAFE_CARGO_SUBCOMMANDS.has(subCmd);
  }

  // rtk is a command REWRITER/executor, not a leaf command: `rtk <cmd>` runs
  // <cmd> (e.g. `rtk git status`), and `rtk proxy <cmd>` runs it unfiltered. So
  // its safety equals the WRAPPED command's — a blanket allow turned it into a
  // wildcard exec hole (`rtk node evil.js` auto-approved RCE). Strip the `rtk`
  // token (and a `proxy` passthrough) and recurse, like the time/nice prefix.
  // Read-only meta-subcommands (gain/discover/version) stay safe.
  if (baseName === 'rtk') {
    const next = words[argIdx] || '';
    if (next === '' || next === 'gain' || next === 'discover' || /^-/.test(next)) return true;
    const restWords = words.slice(next === 'proxy' ? argIdx + 1 : argIdx);
    const rest = restWords.join(' ').trim();
    if (!rest) return true;
    return isSegmentSafe(rest);
  }

  // `find` is read-only EXCEPT its action predicates, which execute arbitrary
  // commands or delete files (`find / -name id_rsa -exec cat {} +`, `find . -delete`).
  // Same arbitrary-exec hazard that excludes xargs — force a prompt.
  if (baseName === 'find' && /(?:^|\s)-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/.test(segment)) {
    return false;
  }

  // Known safe base command
  if (SAFE_COMMANDS.has(baseName)) {
    // sed -i is not read-only
    if (baseName === 'sed' && segment.includes(' -i')) return false;
    // (Output redirection is now blocked for every segment near the top of this
    // function, so the per-command redirect check that used to live here is gone.)
    // Coreutils with a hidden write mode the redirect check can't see:
    if ((baseName === 'sort' || baseName === 'uniq' || baseName === 'tree') && /(?:^|\s)(?:-o(?:[=\s]|$)|--output\b)/.test(segment)) return false;
    // `uniq IN OUT` overwrites the 2nd positional file.
    if (baseName === 'uniq' && words.slice(argIdx).filter((w) => w && !w.startsWith('-')).length >= 2) return false;
    // `yq -i` / `jq` in-place edits.
    if ((baseName === 'yq' || baseName === 'jq') && /(?:^|\s)(?:-i\b|--in-?place\b)/.test(segment)) return false;
    return true;
  }

  // Version/help checks are always safe
  if (/\s+(-v|--version|-V)\s*$/.test(segment)) return true;
  if (/\s+(-h|--help)\s*$/.test(segment)) return true;

  // gh (GitHub CLI) read-only commands
  if (baseName === 'gh') {
    const ghAction = words.slice(argIdx, argIdx + 2).join(' ');
    if (/^(pr|issue|repo|release|run)\s+(view|list|status|diff|checks|comments)/.test(ghAction)) return true;
    // `gh api` DEFAULTS to GET (read-only) but `-X/--method` and write-body
    // flags (-f/-F/--field/--input) make it a mutation (delete repo, merge PR,
    // etc.). Match the flag in EVERY form gh accepts — `-X POST`, `-XDELETE`,
    // `--method=POST`, `-ftitle=v`, `-f k=v` — and auto-approve only when none
    // is present (a plain GET). The space-only regex was bypassable with `=` /
    // glued forms.
    if (subCmd === 'api') {
      if (/(?:^|\s)-X/.test(segment)) return false;                       // -X POST / -XPOST / -XDELETE
      if (/(?:^|\s)--method\b/i.test(segment)) return false;             // --method POST / --method=POST
      if (/(?:^|\s)-[fF][A-Za-z0-9_]*=/.test(segment)) return false;     // -ffield=val (glued)
      if (/(?:^|\s)-[fF](?:\s|$)/.test(segment)) return false;          // -f / -F (spaced value)
      if (/(?:^|\s)--(?:field|raw-field|input)\b/.test(segment)) return false;
      return true;
    }
    if (subCmd === 'auth' && words[argIdx + 1] === 'status') return true;
    return false;
  }

  // docker/podman read-only
  if (baseName === 'docker' || baseName === 'podman') {
    if (['ps', 'images', 'inspect', 'logs', 'stats', 'top', 'port', 'version', 'info'].includes(subCmd)) return true;
    return false;
  }

  return false;
}
