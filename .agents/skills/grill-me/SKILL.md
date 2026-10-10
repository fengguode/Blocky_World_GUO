---
name: grill-me
description: Sharpen a feature request or requirement before implementation by surfacing decisions, assumptions, dependencies, risks, and acceptance criteria. Use when the user asks to be grilled, to sharpen requirements, or before building a materially underspecified feature.
---

# Grill Me

Interview the user about the proposed change until its important decisions are explicit and we share the same understanding. Do not implement while the interview is active.

## Interview loop

1. Read the relevant project instructions and inspect source, documentation, and existing behavior for facts that can be established from the workspace. Ask the user only for choices, intent, priorities, or context that cannot be determined from those sources.
2. Map the request as a decision tree. Resolve foundational choices before dependent questions; each answer may change which questions remain.
3. Ask exactly one concise question at a time. Give a short reason it matters, 2–4 plausible choices when useful, and a clearly marked recommendation with its trade-off. Do not bundle independent questions into one prompt.
4. Wait for the user's answer before asking the next question. Treat the user's answer as authoritative; do not silently convert a recommendation into a decision.
5. Track settled choices, constraints, assumptions, unresolved decisions, and acceptance criteria in the conversation. Revisit a decision when a later answer changes its prerequisites.
6. When all material branches are resolved, summarize the agreed scope, behavior, exclusions, constraints, and acceptance criteria. Ask whether this shared understanding is correct.
7. Start planning or implementation only after the user confirms the summary. If they correct it, continue the interview on the changed branches.

## Interview quality

- Be direct and constructive. Probe the highest-impact ambiguity first: user outcome, affected mode or control path, expected behavior, failure cases, compatibility, persistence, and success evidence as relevant.
- Prefer concrete examples and observable outcomes over vague terms such as "better", "smooth", or "user-friendly".
- Avoid asking about details that are already established by source or project policy. State what the code shows and ask only about the remaining decision.
- Do not invent user research, constraints, implementation preferences, or acceptance.
- Keep the interview proportional: stop when remaining choices are low-risk implementation details that the project instructions delegate to the agent.
- Do not create or edit files, issues, branches, or other artifacts during the interview unless the user separately asks for that artifact.
