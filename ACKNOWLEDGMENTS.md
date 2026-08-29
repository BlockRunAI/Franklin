# Acknowledgments

Franklin is built in the open, and a good share of what ships comes from people outside the core team: pull requests, precise bug reports, and design questions that turned into features. This file is the standing thank-you. If you contributed and are missing here, open a PR against this file.

## Code contributors

Merged pull requests from outside the core team.

| Contributor | What shipped |
|-------------|--------------|
| [@KillerQueen-Z](https://github.com/KillerQueen-Z) | Typed Phone & Voice tools (#58), permissions classifier + VoiceStatus polling (#59), inline-paste threshold (#60), voicemail controls (#61), PredictionMarket / Predexon v2 schema realignment + agent-loop retry guard (#62), and a long run of follow-up fixes |
| [@0xCheetah1](https://github.com/0xCheetah1) / [@TheCheetah11](https://github.com/TheCheetah11) | Expanded model picker catalog (#106), hook stdin EPIPE handling (#105), Llama alias + roleplayed-tool-call fix (#101), image paste fallback (#78), instant terminal return on exit (#47), Playwright accessibility type regression (#9) |
| [@Daisuke134](https://github.com/Daisuke134) | `/market` command + `agent_talent` tool, rebased onto current main (#99) |
| [@samsamtrum](https://github.com/samsamtrum) | Reject Jupiter swap amounts below token precision (#89) |
| [@BeneficialVast1048](https://github.com/BeneficialVast1048) | VoiceCall `interruption_threshold` + `model` controls (#66) |
| [@TateLyman](https://github.com/TateLyman) | Test runner fix for file URL paths with spaces (#57) |

## Bug reports and design input

Issues that were correct, specific, and changed the code.

| Reporter | Issue | Outcome |
|----------|-------|---------|
| [@aurumflux20](https://github.com/aurumflux20) | #128 — wallet reservation released on an aborted x402 payment that may already have settled | Fixed in #138: ambiguous settlements now hold the reservation instead of releasing it |
| [@GentechLabs](https://github.com/GentechLabs) | #129 — parallel PR for the same bug; the `paidRequestDispatched` tracking in `postWithPayment` follows their approach | Superseded by #138, which adds the bounded grace window |
| [@KillerQueen-Z](https://github.com/KillerQueen-Z) | #119 — legacy Solana wallet migration must not silently change the active address; plus #5, #10, #12, #51, #52, #65 on gateway tool-call conversion, vision payloads, and image-to-image | #119 tracked as a wallet enhancement; the rest shipped |
| [@Zambala108](https://github.com/Zambala108) | #73 — five `cache_control` breakpoints on multi-turn tool sessions (HTTP 400); #74 — stream-idle timeout shorter than reasoning-model first-token latency | Both fixed |
| [@jackinehu](https://github.com/jackinehu) | #69 — should autonomous x402 payments have a pre-spend risk hook? | Became the `PreSpend` lifecycle hook |
| [@RenatoFloreon](https://github.com/RenatoFloreon) | #17 — conversion audit idea | Informed the audit-batch tooling |

## Upstream

Franklin stands on [x402](https://github.com/coinbase/x402), the BlockRun gateway, and the `@blockrun/llm` SDK. Thanks to everyone maintaining those layers.
