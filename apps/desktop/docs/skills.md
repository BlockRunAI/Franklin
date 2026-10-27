# Local Desktop Skills

Open Skills from the sidebar's More menu, then Add skill. Paste a complete
SKILL.md or choose a Markdown file (up to 256 KiB). The server validates YAML
frontmatter with name and description, a nonempty instruction body, a lowercase
kebab-case name, and name collisions. Nested third-party metadata is accepted
as data. Duplicate names never overwrite an existing Skill.

The registry includes bundled, learned, user and project Skills. Imported files
are stored in the user Skills directory. Changes to enabled state persist and
apply to the next user message; an active conversation need not restart.
Use in chat prepares `/name ` for review. Removal only applies to imported user
Skills with no additional supporting files. Built-in and project content remains
managed at its original source.

Imports save instructions only. API examples (including curl), npx installation
documentation and optional dependency metadata do not block importing an API
Skill. The importer never executes those instructions or installs dependencies.
References to local scripts and supporting files are flagged because a single
SKILL.md upload cannot include the files. Tools, credentials and execution
approvals are checked by the normal agent runtime. Frontmatter does not create
new tool access or an API connection.

The real agent expands `/name arguments` using the current registry. Arguments
replace `$ARGUMENTS` when present; otherwise they are appended as the user
request. `skills.resolve` exposes the same pure resolver for zero-cost readiness
checks and does not invoke a model, an API or a tool.

Verification from the repository root:

```sh
npm ci
npm run build
node --test test/skills.local.mjs test/skills-management.local.mjs test/serve-security.local.mjs
npm test --workspace @blockrun/franklin-desktop
npm run test:skills --workspace @blockrun/franklin-desktop
```

The native test uses a disposable home/profile and real local Skills RPCs.
Wallet/catalog responses are stubbed and inference sends fail the test. To
verify a built installer, set FRANKLIN_TEST_EXECUTABLE to its extracted
application executable and run `node apps/desktop/test/skills.e2e.mjs`.
The unmodified OpenClaw weather fixture is MIT-licensed and includes its source
and license in test/fixtures/openclaw-weather/.
