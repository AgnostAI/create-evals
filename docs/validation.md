# Validation

How we check that create-evals finds real problems: a fresh coding agent (a Claude subagent that had never seen the target) gets only [the skill](../skill/create-evals/SKILL.md) and the instruction "write evals for the agent in this repo". It runs the whole loop on an agent it didn't write. Each run worked on a disposable copy, never modified the agent's source, and had a budget of about 30–40 conversations. When the developer would decide "bug or acceptable", the agent decided as product owner and labeled the call as pending.

## Results

| Agent | Shape | How it ran | Found (frequency) | Tests failing today |
|---|---|---|---|---|
| Booking agent, buggy commit ([examples/booking-agent](../examples/booking-agent) at `2c55bd5`) | Vercel AI SDK, chat, tools | Module swap: Google Calendar → in-memory fake | Tells guests real bookings are fake and books again (8/15). Says it never checked the calendar when it had (10/18). **Offers times on full days, then refuses them** (4/4); this was unknown before the run. | 3/3 |
| Support agent ([fixtures/support-agent](../fixtures/support-agent)) | Vercel AI SDK, chat, tools | Fakes for orders, payments, email | Disowns real refunds and redoes them (8/19; one run paid $300 on a $150 request). Promises escalations it can't make (7/19). Shares account data with unverified callers (5/19). Splits refunds to dodge approval. | 6/7 |
| Nimo, Agnost's support demo (`e2e-demo`) | OpenAI SDK, chat, no tools | Run on Claude through the OpenAI-compatible endpoint; analytics SDK fenced off | Billing requests dead-end at "email support" (10/10; the prompt causes it). Replies cut off by a 300-token cap (empty on Sonnet). Invented menu paths and capabilities. | 5/5 |
| OpenAI Agents JS `examples/customer-service` | OpenAI Agents SDK, multi-agent | The real CLI, driven as a child process | Puts a lap infant in an exit row (2/16). The FAQ tool misses everyday wording (3/16). A second passenger's seat overwrites the first. | 3/3 |
| vercel-labs/gemini-chatbot | Vercel AI SDK, chat, UI cards | Fakes for DB, auth and flights; model swapped to Claude | Quotes UTC times next to a local-time card (7/17). "Seat updated" really creates a second reservation. Starts payment on "ok cool". | 3/3 |
| Triage function ([fixtures/triage-agent](../fixtures/triage-agent)) | One input → structured output | Real function, real model | An auto-sent reply promises an action nobody takes (1/3 auto-closes, plus both test runs). A security report is silently answered by the fallback model (4/4). Every prompt rule held across 28 adversarial inputs, so those became guard tests. | 1/1 |
| Mastra `template-text-to-sql` (official template) | Mastra, chat, SQL tools | Real seeded SQLite, nothing faked; model swapped to Claude | **Forgets the start of long chats** (Memory's default 10-message window), then calls real earlier results "made up" (2/2 long chats). The read-only guard rejects valid SELECTs (4/17). Writes INSERT/UPDATE/DELETE scripts despite "Never generate" (2/2). | 3/3 |
| langchain-ai `langgraph-101-ts` (supervisor with memory) | LangGraph.js, subagents, interrupts, memory store | Real (in-memory public DB, its own store); model swapped to Claude Haiku | **Every request after identity verification crashes** (6/6): a schema passed to `createAgent` drops the messages reducer. Any all-digit ID counts as verified with no lookup, which exposed another customer's invoices. Apostrophes break its SQL ("no Guns N' Roses"). Email case and phone format lock real customers out. Misreports saved memory. Treats an injected preferences message as the customer. | 6/6 |
| Agnost `enterprise-outbound` research agents | **Python** pipeline | Child process; Exa faked from 69 pages; network fenced in Python | **No company can pass verification**: a correctly cited project lead is rejected because the code requires an exact "Name, Title" string (8/8; 0/12 verifications passed). A competitor was saved after operator feedback. A spin-out was credited with its parent's funding. | 7/7 |

On the booking agent's buggy commit, create-evals' own reviewer (without a coding agent) found the lost-history bug in 10 of 13 conversations, from 12 ordinary guest profiles that weren't written to look for it.

## What the runs taught us (and what changed)

- **Lost history is common.** It showed up in four agents. Two returned only text from their chat function, so the model couldn't see its own earlier actions; the booking agent's web page did the same; and Mastra's memory window drops the start of long chats. It then disowned and repeated them. Only multi-turn runs show this, and the `init` template now tells bindings to keep history the way production does. An earlier version said to keep tool calls, which would have hidden the bug.
- **The reviewer is necessary but not sufficient.** Its high-severity notes were accurate. Its low-severity notes were often wrong or trivial, and it missed failures the instructions themselves cause (Nimo's dead end) and cross-run patterns (Nimo's cut-offs, the triage fallback model). The skill makes the coding agent read traces and `create-evals list`, and the reviewer now treats instructions as a possible bug.
- **Rules the model already obeys need guard tests.** The triage agent kept every prompt rule. A loop that only keeps failing tests protects none of them, so the skill now asks for guard tests proved by deleting the rule.
- **Not every agent is a chat, or in TypeScript.** This led to function mode (`input` profiles), `spawnSession()` and the Python helper.
- **Simulated users refuse some personas** (impostors). Fixed with authorized-testing framing and server-side fallback, and such runs are skipped rather than failed.
- **Model choice matters.** Several agents ran on Claude rather than their production model, and some failures depend on the model (Nimo's cut-offs are worse on Sonnet). The report says when that's the case.

## Model comparison

On the same 13 booking conversations, all three reviewer models found the main bug. Sonnet (the default) and Opus did it with little noise. Haiku invented one failure mode in 6 conversations, because that binding didn't record the agent's own tool calls. Bindings should record both the agent's tool calls and the backend's changes.

## Caveats

- The developer decisions were made by the agents, not by the owners of these agents.
- Frequencies come from 15–40 simulated conversations per agent, which shows patterns, not rates you could put in a dashboard.
- Several worlds (fake web pages, seeded calendars) were written by the agent doing the testing. A fake can be wrong, which is why the skill makes the coding agent read traces and drop findings caused by its own fakes.
