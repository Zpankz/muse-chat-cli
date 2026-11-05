# Hatch iOS app (com.facebook.hatch 14.2.0) — extracted programmatic API

Evidence: static analysis of `com.facebook.hatch_v14.2.0_und3fined.ipa`
(88 MB arm64 Mach-O `HatchApp`, build 1106104653, 2026-11-02) with `ipsw`,
`strings`, and ObjC class-dump. Scratch extraction only — nothing here was
run against a device, and no credentials/tokens were extracted.

## Verdict for `mc`

**The iOS app uses the same programmatic API this repo already implements.**
There is no second, simpler REST chat API to adopt: native chat goes over
the same encrypted Noise WebSocket gateway, with the same method names and
event names as `muse-noise.mjs`. What the IPA adds is *corroboration and
newer surface area* (below), not a migration path. The current architecture
— Node shim owning the transports, Rust `mc` as the typed front-end —
stands. Do not build an IPA-derived client: it would need the app's
keychain attestation (`HCHNoiseChipPolicy`, keychain group
`T84QZS65DQ.platformFamily`), which is not extractable statically and not
needed, since the web Noise client already works.

## What matches the existing implementation (AGENTS.md invariants)

| IPA evidence | Repo equivalent |
|---|---|
| `wss://hatch.metaaivm.com/v1/noise` host + `/v1/noise` path | Noise WS bootstrap |
| Methods: `chat.stream`, `chat.subscribe`, `chat.cancel`, `chat.resume`, `chat.search`, `chat.send`, `chat.session`, `chat.message_get`, `chat.stream_events`, `fs.subscribe` | `muse-noise.mjs` RPC methods |
| Events: `delta.text_append`, `delta.message_done`, `delta.presentation`, `delta.thinking_append`, `delta.tool_start`, `delta.agent_*`, `delta.compaction` | subscribe NDJSON events |
| Routes: `/chat/stream`, `/chat/subscribe`, `/chat/cancel`, `/chat/resume`, `/chat/search`, `/fs/subscribe`, `/fs/upload/status`, `/api/session/{archive,delete,pin,rename,unarchive,unpin}` | REST fallbacks / session list |
| `HCHNoiseGateway*`, `HCHNoiseContextHandle`, Swift `HCHGatewayTransport` | Noise_XX gateway transport (server side is transport-agnostic) |
| `HANDSHAKE_TIMEOUT | no chat.subscribe ack in …` | subscribe-ack handling / stream reset discipline |

## Newer / additional surface worth knowing about

- **`chat.stream_events`, `chat.resume`, `chat.send`, `chat.message_get`,
  `fs.subscribe`, `fs/upload/status`** — methods the web client in this repo
  does not currently call. `chat.resume` + `stream_events` are candidates
  if resumable streams are ever needed; today the shim's abort→cancel
  semantics cover the use case.
- **Hosts**: `api.muse.ai` (incl. `/muse/prompts/`, `/ssh-access/tokens`),
  `hatch-api.meta.ai`, `api.meta.ai/hatch/*`, `vm.muse.ai`,
  `genai-hatch-realtime.facebook.com` (voice/realtime — out of scope).
- **GraphQL is account/app plumbing, not chat**: persisted queries ship as
  `mwa-{fb,frl,ig}-ios_client-persist.json` (`client_doc_id` maps:
  account cache, OAuth account linking, GDP consent, latest-build checks)
  against `graph.facebook.com/graphql` / `graph.meta.ai/graphql`. No chat
  operations are persisted in the bundle.
- **No `fetchSubscriptionAction` string** in the binary: the iOS usage
  meter is not the web RSC action. `mc usage` therefore stays on the web
  action (AGENTS.md invariant) — do not chase an iOS usage endpoint.

## Bundle facts

- Bundle id `com.facebook.hatch`, display name “Muse”, app id
  `1408214714122653`, URL schemes `hatch`, `fb1408214714122653`.
- Native stack is mostly Swift (`HCH*` classes; chat payloads appear as
  Swift types such as `HCHChatClientDelta*Payload`, hence few ObjC headers
  for the chat core — class-dump confirms the ObjC-visible gateway layer).
- Entitlement/keychain sharing is under team `T84QZS65DQ` — a signed-in
  iOS session is not portable to this repo, by design.

## Method

```bash
unzip -l com.facebook.hatch_v14.2.0_und3fined.ipa
ipsw macho info Payload/HatchApp.app/HatchApp
ipsw class-dump Payload/HatchApp.app/HatchApp --headers --output headers
strings -a Payload/HatchApp.app/HatchApp | grep -E '^/(api|chat|fs|v1)/'
```
