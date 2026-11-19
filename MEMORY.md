# Memory stage (Hindsight)

The gateway can recall from and retain to a [Hindsight](https://hindsight.vectorize.io)
memory service on every chat turn, so a client needs no memory integration of its
own: the context is already in the prompt and shared across a combo.

Off by default. `Settings → memory` (or `POST /api/settings`) turns it on:

```jsonc
{
  "memory": {
    "enabled": true,
    "baseUrl": "http://localhost:8888",
    "apiKey": "<bearer token, if the deployment needs one>",
    "bankId": "9router",
    "recall": true,
    "retain": true,
    "includeShared": true,
    "recallBudget": "mid",
    "recallMaxTokens": 1200,
    "timeoutMs": 800
  }
}
```

A combo may retune any of these under `comboStrategies[<name>].memory`. It cannot
*enable* a stage the operator left off.

## One bank, isolated by tag

There is one physical bank. Isolation comes from a tag the **gateway** stamps, not
from bank separation:

| Layer | Tag | Written by |
|---|---|---|
| A caller's own memories | `principal:<sha256(apiKey)[:32]>` | the chat stage, automatically |
| Shared knowledge | *(untagged)* | an admin, or a scheduled `reflect` job |

Recall filters with `tags: [<principal tag>]` and:

- `tags_match: "any"` when `includeShared` is true — this caller's memories **plus**
  untagged shared ones;
- `tags_match: "any_strict"` when false — this caller's memories only, so one bank
  behaves like one bank per caller.

The caller never chooses the tag: a client that could would write into another
principal's scope, which is the channel this design exists to close.

> **Do not rely on Hindsight Memory Defense for this.** In the open-source build the
> `prompt_injection` detector is a silent no-op — `memory_defense_regex.py` screens
> only `sensitive_data`, and any other `on:` name is accepted by the policy parser
> and then ignored. It is also write-side: it never touches what `recall` puts into a
> prompt. The isolation above is the actual boundary.

## Where it runs, and why

Recall and retain both run in `handleChat` (`apps/web/src/sse/handlers/chat.ts`),
once per client request, before `dispatchCombo`. Everything below that layer —
combo expansion, account fallback, retries, fusion panel legs — re-enters
`handleChatCore` per attempt, so a stage placed there would cost one Hindsight call
per attempt and inject one copy of the block per member.

- **Recall** mutates the shared `body` once via `injectSystemPrompt`, which is
  format-aware (OpenAI, Responses, Claude, Gemini, Kiro). The block is delimited and
  labelled reference-not-instruction, so the caller's own system prompt still wins.
- **Retain** sends only the delta — messages after the last retained index — under a
  stable `document_id` with `update_mode: "append"` and `async: true`. The index is a
  bookmark on the `kv` table (`memoryStateRepo`), advanced only on a 2xx, so a failed
  retain is retried by the next request rather than lost. A trailing user message is
  never retained: its answer does not exist yet.

## Cost

- **Retain = one extraction LLM call per turn**, billed by the Hindsight deployment.
  `async: true` keeps it off the response path.
- **Recall = one retrieval call per turn**, bounded by `timeoutMs` (default 800 ms)
  and `recallMaxTokens`.
- `reflect` is **not** per-turn. It is an agentic loop with its own multi-round tool
  calls and its own LLM; it lives on `POST /api/memory` (`action: "reflect"`) only.

## Fail-open

Every call has a deadline and a circuit breaker (3 consecutive failures → open for
30 s). A timeout, a non-2xx, a network error or an open breaker yields "no memory"
and the chat request continues. Nothing in this stage can fail a request.

## Admin

`GET /api/memory` — reachability, effective config (token withheld), breaker state.
`POST /api/memory` with `{action:"purge", apiKey}` — delete one principal's retained
conversations, filtered server-side by that principal's tag.
`POST /api/memory` with `{action:"reflect", query}` — run reflect once.

All three sit behind the dashboard auth gate.

## Local setup

```bash
docker run -it --pull always --name hindsight --restart unless-stopped \
  -p 8888:8888 -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  -v $HOME/.hindsight-docker:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
```

`HINDSIGHT_URL` and `HINDSIGHT_API_KEY` seed the defaults on a fresh install.
