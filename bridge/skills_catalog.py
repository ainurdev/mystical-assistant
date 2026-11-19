"""Built-in skill catalog. Data only; bridge/skills.py owns the filesystem.

Two kinds of entry:
  · `steps`  — a starter skill written here, rendered to SKILL.md locally.
  · `url`    — a real community skill; install downloads that SKILL.md verbatim
               from GitHub, so the user gets the maintained original, not a
               paraphrase. A skill whose SKILL.md points at sibling scripts/ or
               references/ lists them in `files` (paths beside its SKILL.md);
               without that list it would install broken.
"""

import json

CATEGORIES = ("development", "design", "writing", "testing", "workflow", "other")

CATALOG = [
    # -------------------------------------------------------------- development
    {
        "id": "api-design",
        "category": "development",
        "name": "API design review",
        "description": "Use when designing or reviewing an HTTP/RPC API — resource shapes, status codes, versioning, pagination, error bodies.",
        "steps": [
            "Name resources as nouns; put verbs in the method, not the path.",
            "Pick status codes from the actual outcome: 400 client, 404 missing, 409 conflict, 422 semantic, 5xx ours.",
            "Give every error one shape: a stable machine code, a human message, and the offending field.",
            "Paginate any list that can grow — cursor over offset once rows can shift.",
            "Version only when a change breaks a client; additive fields never need a new version.",
            "Write one example request/response per endpoint before the implementation.",
        ],
    },
    {
        "id": "sql-tuning",
        "category": "development",
        "name": "SQL query tuning",
        "description": "Use when a query or report is slow — read the plan, fix the index, verify the win with numbers.",
        "steps": [
            "Get EXPLAIN ANALYZE first; never guess at the plan.",
            "Find the row-count blowup: where estimated and actual rows diverge is the bug.",
            "Prefer one composite index in filter-then-sort order over several single-column ones.",
            "Kill SELECT * on wide tables; fetching fewer columns can flip a plan to index-only.",
            "Watch for functions on indexed columns — they disable the index unless it is expression-based.",
            "Record before/after timings in the PR; a tuning change without a measurement is a guess.",
        ],
    },
    {
        "id": "refactor-safely",
        "category": "development",
        "name": "Safe refactoring",
        "description": "Use when restructuring code that must keep behaving identically — characterization tests first, small steps after.",
        "steps": [
            "Pin current behaviour with tests before touching anything.",
            "Separate refactor commits from behaviour commits; never mix them in one diff.",
            "Move in steps small enough that the suite stays green between each.",
            "Keep the old entry point delegating to the new one until every caller has moved.",
            "Grep for every caller before changing a signature — sibling callers break silently.",
            "Delete the dead path in its own commit so it is trivial to revert.",
        ],
    },
    {
        "id": "perf-profiling",
        "category": "development",
        "name": "Performance profiling",
        "description": "Use when optimising something that is slow but did not regress — measure before optimising, and confirm the fix moved the number you started with.",
        "steps": [
            "Write down the metric and the target before profiling anything.",
            "Profile a realistic workload; a synthetic loop optimises the wrong thing.",
            "Fix the top item in the profile, then re-profile — the second item usually moves.",
            "Look for accidental O(n²) and per-item I/O before micro-optimising anything.",
            "Cache last: correctness of invalidation costs more than the cycles saved.",
            "Keep the benchmark in the repo so the regression is caught, not rediscovered.",
        ],
    },
    {
        "id": "dependency-hygiene",
        "category": "development",
        "name": "Dependency hygiene",
        "description": "Use when adding, upgrading, or pruning dependencies — keep the tree small and the lockfile honest.",
        "steps": [
            "Before adding: check whether the stdlib or an installed dep already does it.",
            "Confirm a new package exists under that exact name and is the one you meant; models invent plausible package names.",
            "Weigh transitive weight and maintenance, not just the API you like.",
            "Pin via the lockfile and commit it; a floating range is a future outage.",
            "Upgrade one major at a time, reading its changelog, not the diff of your lockfile.",
            "Remove deps orphaned by your own change in the same PR.",
            "Run the audit tool and triage findings; suppressions need a written reason.",
        ],
    },
    {
        "id": "ci-pipeline",
        "category": "development",
        "name": "CI pipeline work",
        "description": "Use when authoring or repairing CI workflows — fast, reproducible, and honest about what it verifies.",
        "steps": [
            "Reproduce the failure locally with the same command CI runs before editing YAML.",
            "Cache dependencies by lockfile hash; cache nothing that a build produces.",
            "Fail fast: lint and typecheck before the slow test job.",
            "Keep secrets in the CI secret store; never echo them into logs.",
            "Make the pipeline deterministic — pin tool versions and the runner image.",
            "A flaky job is a bug: quarantine it with an issue, do not add a blind retry.",
        ],
    },
    {
        "id": "error-handling",
        "category": "development",
        "name": "Error handling design",
        "description": "Use when deciding how a module reports failure — one taxonomy, useful context, no silent swallow.",
        "steps": [
            "Distinguish expected failures (return them) from bugs (raise/throw them).",
            "Catch narrowly; a bare catch-all hides the crash you needed to see.",
            "Attach context at the throw site — ids and inputs, never secrets.",
            "Do not log and rethrow at every level; log once where it is handled.",
            "Make the failure path preserve data: no partial write without a rollback or a retry.",
            "Give the caller something actionable: what failed, and what they can do.",
        ],
    },
    {
        "id": "logging-observability",
        "category": "development",
        "name": "Logging & observability",
        "description": "Use when adding logs, metrics, or traces — enough signal to debug production without drowning in noise.",
        "steps": [
            "Log structured key/values, not sentences you will later regex.",
            "One request id threaded end to end beats a hundred scattered prints.",
            "Levels mean something: ERROR pages someone, WARN is degraded, INFO is a state change.",
            "Never log secrets, tokens, or full request bodies.",
            "Meter what users feel — latency, error rate, saturation — before internal counters.",
            "Add the log line you wished you had during the last incident.",
        ],
    },
    # ------------------------------------------------------------------- design
    {
        "id": "accessibility-audit",
        "category": "design",
        "name": "Accessibility audit",
        "description": "Use when checking a UI against WCAG basics — keyboard, contrast, semantics, and announced state.",
        "steps": [
            "Tab through the whole flow: everything reachable, focus always visible, order sane.",
            "Check contrast — 4.5:1 for body text, 3:1 for large text and UI boundaries.",
            "Never carry meaning by colour alone; about 8% of men of European descent have red-green colour blindness.",
            "Use the native element first; a div with a click handler is not a button.",
            "Label every input and icon-only control; placeholder text is not a label.",
            "Announce dynamic changes with a live region, and keep motion respectful of reduced-motion.",
            "Confirm the page works at 200% zoom and at 320px wide.",
        ],
    },
    {
        "id": "empty-states",
        "category": "design",
        "name": "Empty, loading & error states",
        "description": "Use when a view can be empty, slow, or broken — design the other three states, not just the happy one.",
        "steps": [
            "Empty: say what goes here and give the one action that fills it.",
            "First-run empty differs from filtered-empty; do not reuse one copy for both.",
            "Loading: hold the layout with a skeleton so nothing jumps when data lands.",
            "On a long wait, show the time elapsed rather than a guess at the time remaining.",
            "Error: say what failed, whether it was them or us, and offer a retry.",
            "Keep already-loaded content on screen when a refresh fails.",
        ],
    },
    # ------------------------------------------------------------------ writing
    {
        "id": "changelog",
        "category": "writing",
        "name": "Changelog & release notes",
        "description": "Use when writing release notes — grouped by what users can now do, not by commit.",
        "steps": [
            "Group into Added / Changed / Fixed / Removed; drop empty groups.",
            "Lead each entry with the user-visible outcome, not the internal module.",
            "Call out breaking changes first, with the migration in the same bullet.",
            "Skip refactors and chores unless a user can observe them.",
            "Link the issue or PR for anyone who needs the detail.",
            "Write in past tense, one line per entry.",
        ],
    },
    {
        "id": "api-docs",
        "category": "writing",
        "name": "API documentation",
        "description": "Use when documenting endpoints or a public interface — task-oriented, with real examples.",
        "steps": [
            "Document the task first, the endpoint second.",
            "Give a complete runnable request and its real response for each operation.",
            "Specify every parameter: type, required, default, and constraints.",
            "List the errors a caller must handle, with the exact codes.",
            "Cover auth, rate limits, and pagination once, up front.",
            "Generate from the source where you can so the docs cannot drift.",
        ],
    },
    # -------------------------------------------------------------------- other
    {
        "id": "estimate-work",
        "category": "other",
        "name": "Breaking down & estimating",
        "description": "Use when scoping a task — split it until each piece is verifiable, then estimate the pieces.",
        "steps": [
            "Split until each piece has a checkable done condition.",
            "Start from how long similar past work actually took.",
            "Estimate top-down and bottom-up independently, then compare the two.",
            "Name the unknowns and time-box a spike instead of padding the estimate.",
            "Include review, testing, and deployment in the number.",
            "Give a range, and say what would push it to the high end.",
            "Re-estimate once the first piece lands and the real shape is visible.",
        ],
    },
    {
        "id": "onboarding-guide",
        "category": "other",
        "name": "Onboarding guide",
        "description": "Use when writing onboarding docs — get a newcomer to a working change on day one.",
        "steps": [
            "Start with the shortest path to a running app and a passing test suite.",
            "Explain the mental model before the directory tree.",
            "List the accounts, keys, and access needed, and who grants them.",
            "Name the three things that trip up every new person.",
            "End with a small starter task that touches the real codebase.",
            "Have the next newcomer fix the guide as their first PR.",
        ],
    },
    {
        "id": "incident-postmortem",
        "category": "other",
        "name": "Blameless postmortem",
        "description": "Use after an incident — timeline, contributing factors, and actions that make it structurally harder to repeat.",
        "steps": [
            "Write the timeline from logs and timestamps, not memory.",
            "Describe impact in user terms: who, how many, how long.",
            "Look for contributing factors, not a single root cause or a person.",
            "Ask why detection took as long as it did, separately from why it broke.",
            "Turn each action into an owned, dated change — not a resolve-to-be-careful.",
            "Publish it; a postmortem nobody reads prevents nothing.",
        ],
    },

    # ======================================================================
    # Community skills — installed by downloading the upstream SKILL.md.
    # Every entry below was checked to be self-contained (none cites a file the install leaves out).
    # ======================================================================
    # ---------------------------------------------------------------- design
    {
        "id": "web-design-guidelines",
        "category": "design",
        "name": "Web interface guidelines",
        "description": "Vercel's review pass over UI code against 100+ interface rules covering accessibility, performance and UX.",
        "repo": "vercel-labs/agent-skills",
        "url": "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/web-design-guidelines/SKILL.md",
    },
    {
        "id": "apple-design",
        "category": "design",
        "name": "Apple-style motion & interface",
        "description": "Apple's fluid, physical motion and interface language, translated into web technique.",
        "repo": "boraoztunc/skills",
        "url": "https://raw.githubusercontent.com/boraoztunc/skills/main/apple-design/SKILL.md",
    },
    {
        "id": "landing-page",
        "category": "design",
        "name": "Landing page architecture",
        "description": "Single-intent landing page IA — layout archetypes, headline formulas, and what not to index.",
        "repo": "boraoztunc/skills",
        "url": "https://raw.githubusercontent.com/boraoztunc/skills/main/landing-page/SKILL.md",
    },
    {
        "id": "pricing-page",
        "category": "design",
        "name": "Pricing page architecture",
        "description": "Value-metric-first pricing IA — plan ceilings, feature grouping, and the mobile rules.",
        "repo": "boraoztunc/skills",
        "url": "https://raw.githubusercontent.com/boraoztunc/skills/main/pricing-page/SKILL.md",
    },
    # --------------------------------------------------------------- writing
    {
        "id": "stop-slop",
        "category": "writing",
        "name": "Stop AI slop",
        "description": "Strip the tells out of AI-written prose — the patterns that make text read as generated.",
        "repo": "boraoztunc/skills",
        "url": "https://raw.githubusercontent.com/boraoztunc/skills/main/stop-slop/SKILL.md",
    },
    {
        "id": "asd-ste100",
        "category": "writing",
        "name": "Simplified Technical English",
        "description": "Rewrite agent-facing English (tool descriptions, errors, prompts) to ASD-STE100 rules so nothing can misread it — with a stdlib linter for the structural rules.",
        "repo": "danyuchn/asd-ste100-skill",
        "url": "https://raw.githubusercontent.com/danyuchn/asd-ste100-skill/master/SKILL.md",
        "files": ["references/writing-rules.md", "examples/before-after.md",
                  "examples/linter-edge-cases.md", "scripts/ste-lint.py"],
    },
    {
        "id": "unslop",
        "category": "writing",
        "name": "Unslop",
        "description": "Cut AI tells from any text against a numbered rule list — stock vocabulary, em dashes, filler, jargon nouns. Runs only when you type /unslop.",
        "repo": "cursor/plugins",
        "url": "https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/unslop/SKILL.md",
    },
    {
        "id": "doc-coauthoring",
        "category": "writing",
        "name": "Document co-authoring",
        "description": "Draft long documents with a human in the loop — structure first, then prose, with real revision passes.",
        "repo": "anthropics/skills",
        "url": "https://raw.githubusercontent.com/anthropics/skills/main/skills/doc-coauthoring/SKILL.md",
    },
    # --------------------------------------------------------------- testing
    {
        "id": "verification-before-completion",
        "category": "testing",
        "name": "Verification before completion",
        "description": "Never claim done without running the check — evidence before assertions.",
        "repo": "obra/superpowers",
        "url": "https://raw.githubusercontent.com/obra/superpowers/main/skills/verification-before-completion/SKILL.md",
    },
    # -------------------------------------------------------------- workflow
    {
        "id": "receiving-code-review",
        "category": "workflow",
        "name": "Receiving code review",
        "description": "Verify feedback technically instead of agreeing performatively — and push back when it is wrong.",
        "repo": "obra/superpowers",
        "url": "https://raw.githubusercontent.com/obra/superpowers/main/skills/receiving-code-review/SKILL.md",
    },
]


def skill_md(entry: dict) -> str:
    """Render a catalog entry as a SKILL.md (front matter + checklist)."""
    steps = "\n".join(f"- {s}" for s in entry["steps"])
    return (
        "---\n"
        f"name: {entry['id']}\n"
        # json.dumps gives a valid YAML double-quoted scalar for any description.
        # ensure_ascii=False keeps em-dashes literal: the escaped \uXXXX form is
        # valid YAML but our own minimal front-matter reader shows it verbatim.
        f"description: {json.dumps(entry['description'], ensure_ascii=False)}\n"
        "---\n\n"
        f"# {entry['name']}\n\n"
        f"{entry['description']}\n\n"
        "## Checklist\n\n"
        f"{steps}\n"
    )
