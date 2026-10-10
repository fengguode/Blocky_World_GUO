# Blocky World project instructions

This workspace contains the existing browser game described in `README.md`. Read this file and the relevant code before changing behavior. Treat current behavior as the baseline; do not infer user requirements or acceptance from implementation details.

## Product and technical boundaries

- The game is a browser-based WebGL project with no build step or external runtime assets. Preserve offline play and the existing desktop, touch, and gamepad paths unless an approved change says otherwise.
- Keep game logic, rendering, input, UI, and persistence responsibilities aligned with the existing modules under `js/`.
- Do not introduce network calls, analytics, external assets, account systems, or collection of player data without an explicit product decision.
- Preserve local-world save compatibility where practical. Identify any save migration or destructive reset behavior before changing it.
- Avoid copying Minecraft, film, or comic characters and assets; follow the project's original-character direction.

## Delivery workflow

- The GitHub Project at https://github.com/users/fengguode/projects/4 is the shared task-status record. Use one backlog; link bounded work to repository issues and pull requests. Follow the board README's title and evidence conventions.
- Primary Coordinator — Yi Tang owns task framing, assignments, integration, and status. Delegate only independent work with explicit acceptance criteria and exclusive file ownership. Check tracked and untracked paths before integrating.
- Use isolated branches and reviewable pull requests once this workspace is connected to the repository. Do not commit, push, merge, publish, or deploy without explicit authorization.
- Require independent review for behavior changes and record actual verification evidence. Do not claim tests or browser acceptance unless they were run and observed. Test execution is opt-in when requested by the user.
- Keep work complete, verified, founder-accepted, and released as separate states. The founder owns product decisions and final acceptance.
- If a user request leaves the implementation target materially unclear, inspect the project and prepare the concrete choices, then ask before implementing an invented feature.

## Agent team

The nine role definitions are in `.codex/agents/`. Read the team workflow in `docs/team/workflow.md` and the role file for each assignment. The primary agent coordinates; role files are reusable instructions, not evidence that a separate role session is running.
