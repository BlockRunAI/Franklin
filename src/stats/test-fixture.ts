/**
 * Test-fixture model detection.
 *
 * Tests in `test/local.mjs` run `interactiveSession()` in-process with
 * model names like `local/test-model` and `local/test`. The agent loop
 * persists every successful turn to `~/.blockrun/franklin-audit.jsonl`,
 * `franklin-stats.json`, and the session store — which means tests
 * pollute the user's real telemetry. Verified on a real machine:
 * 2326 of 3969 audit entries (58.6%) and 84 of 1000 stats entries
 * (8.4%) were `local/test*` test fixtures.
 *
 * The fix is to skip persistence when the model name follows the
 * convention. Test prefixes are reserved (`local/test*` won't ever ship
 * as a real model on the BlockRun gateway), so this is safe.
 *
 * Local LLMs that real users run (`local/llamafile`, `local/ollama`,
 * `local/lmstudio`, etc.) are intentionally NOT filtered — only the
 * `local/test` prefix.
 */

const TEST_FIXTURE_PREFIXES = [
  'local/test',
];

export function isTestFixtureModel(model: string | undefined | null): boolean {
  if (!model) return false;
  for (const prefix of TEST_FIXTURE_PREFIXES) {
    if (model.startsWith(prefix)) return true;
  }
  return false;
}
