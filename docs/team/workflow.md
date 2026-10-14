# Blocky World team workflow

## Sources of truth

- The current game source and `README.md` describe implemented behavior.
- GitHub issues hold bounded task scope, acceptance criteria, decisions, and validation evidence.
- GitHub Project #4 is the shared status view for ownership, priority, dependencies, and linked pull requests.
- `.codex/agents/` contains reusable role guidance. It does not prove an agent was activated or that work was performed.

Do not create a second backlog. Use `[Type][area] concise title`, such as `[Bug][touch] Preserve movement input after resume`. Put urgency in the Project Priority field, and assign the Project Agent field to the accountable role/name. State affected modules, dependencies, acceptance criteria, and evidence in each issue.

## Coordination and handoffs

Primary Coordinator — Yi Tang frames each task, records the responsible role, issue and acceptance criteria, assigns bounded independent work, and integrates the result. A handoff records actual changed paths, decisions, commands and results, limitations, and unresolved questions. Specialists communicate findings through the primary and linked GitHub issues or pull requests so other role sessions can retrieve them.

Avoid concurrent edits to the same files. Review all changed and untracked paths before integration. Keep unrelated local changes intact. No session should assume that another role is running or that a GitHub status update happened automatically.

## Development, review, and release

Prefer isolated task branches and pull requests after the workspace is connected to its GitHub repository. Ask for independent review of behavior and scope. Report the checks actually run and their environment; distinguish automated checks from rendered browser behavior and final user acceptance. Do not run the test suite unless requested.

Do not commit, push, merge, publish, or deploy without explicit authorization. Do not change live services or data. Keep Done (implementation complete), Verified (acceptance evidence recorded), Accepted (founder acceptance), and Released (authorized distribution) separate. Tie release notes and evidence to the exact reviewed candidate.

### Daily production release readiness

Keep `main` production-ready for a daily release cadence. On each active workday, aim to release a small, usable improvement once its release gates pass. If new work is not ready, keep the last known-good playable release available and record the blocker and next action; never ship a broken or unverified build just to meet the date.

For every release candidate:

- Run and record the relevant automated checks and an independent review against the exact candidate.
- Smoke-test the exact browser build and its changed user paths. Check offline behavior and touch controls when the change can affect them.
- Do not ask end users to perform QA.
- Publish only with explicit authorization, then verify the deployed URL and the core Play & Build path.
- Record the exact commit, release notes, verification evidence, and a rollback path to the last known-good version.

## Product context

Blocky World is an offline-capable browser voxel game with build, fight, and observe modes, touch and desktop controls, and local browser persistence. Product behavior, children’s feedback, priorities, and acceptance criteria must come from the user or recorded evidence; do not invent them from code or README prose.
