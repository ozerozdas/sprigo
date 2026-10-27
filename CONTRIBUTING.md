# Contributing

Thanks for helping. You don't need to write code to contribute: courses are plain YAML, and bug reports, translations and answers in [Discussions](https://github.com/ozerozdas/sprigo/discussions) all count.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Your first contribution

- Pick an issue labeled [`good first issue`](https://github.com/ozerozdas/sprigo/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22), or [`no-code`](https://github.com/ozerozdas/sprigo/issues?q=is%3Aissue+is%3Aopen+label%3Ano-code) if you'd rather not touch code.
- Leave a comment that you're taking it, so nobody duplicates the work.
- Unsure about something? Ask in the issue or in [Q&A](https://github.com/ozerozdas/sprigo/discussions/categories/q-a-help). Questions are welcome.

## Courses (no code needed)

Each course is one YAML file in [`courses/`](courses/). It lists levels (CEFR) > units > steps, with each step's vocabulary, grammar patterns and activity types. The AI writes the actual exercises from that, so a course is mostly a well-ordered syllabus. The [Writing a Course](https://github.com/ozerozdas/sprigo/wiki/Writing-a-Course) wiki page walks through the format with an example.

- Copy the shape of an existing file. [`courses/es.yml`](courses/es.yml) is a compact A1 example, [`courses/en.yml`](courses/en.yml) goes up to C2.
- Titles and descriptions are in English; vocabulary and example patterns are in the target language.
- The schema and activity types are in [`src/course.ts`](src/course.ts). `pnpm test` validates every bundled course.
- To try a course without building, drop the file into the app's data folder (`courses/`) and restart Sprigo.

Good first contributions: A2 for Spanish, French, German or Turkish, or A1 for a new language.

## Code

### Setup

Requires Node.js with pnpm, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/). For the AI, install [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) and pull a model (see [AI Model Setup](https://github.com/ozerozdas/sprigo/wiki/AI-Model-Setup) in the wiki).

```bash
pnpm install
pnpm fetch-model   # downloads the whisper speech model into src-tauri/resources
pnpm tauri dev     # desktop app
pnpm dev           # browser preview (no speech, dev storage in localStorage)
pnpm bench         # tutor reply latency per Ollama model (pnpm bench <model…> for some)
pnpm eval          # lesson quality per Ollama model, report in eval/ (JUDGE=<model> adds a judge)
```

How the app fits together is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); design decisions and their reasons are in [docs/DECISIONS.md](docs/DECISIONS.md).

### Workflow

1. Branch from `master` (`feature/…`, `fix/…`, `chore/…`).
2. Keep changes small and focused. One pull request per topic.
3. Run the same checks as CI before pushing:
   ```bash
   pnpm build   # typecheck + bundle
   pnpm test
   pnpm test:e2e   # UI flows in Chromium; first time: pnpm exec playwright install chromium
   ```
   The e2e tests ([`e2e/`](e2e)) drive the dev build with a fake Ollama ([`e2e/mockAi.ts`](e2e/mockAi.ts)), so they need no model.
4. Open the pull request against **`test`**, not `master`. `test` is tried before it goes live; `master` is what users get through in-app updates.

### Evaluating lessons

`pnpm eval [model…]` generates a fixed set of lessons (`CASES` in [`scripts/eval.ts`](scripts/eval.ts): several courses, levels and every exercise type) with the app's real prompts and checks each exercise: the answer is among the options, options are distinct, nothing gives the answer away, text is in the right language, there is exactly one blank. `JUDGE=<model>` also has a strong model (for example an Ollama `:cloud` model) score naturalness, level fit, clarity and whether exactly one answer is correct.

Run it when you change a lesson prompt (`src/activities.ts`), add a course level, or want to recommend a model. Each run writes `eval/<time>-<model>.md` (and `.json` with every exercise). To compare two prompt versions, run it on each branch with the same model and compare the tables; the report header shows the commit. Generation is not deterministic, so run each side twice and treat differences of a few points as noise. The rule checks themselves are tested in `src/evalRules.test.ts`.

### Conventions

- Commit messages start with the area, then a short sentence: `Drills: avoidance pass for goal drills`.
- New UI text goes into all six locales in [`src/locales/`](src/locales/) (en, tr, de, es, fr, hu). A test fails if a key is missing. If you can't translate, copy the English text and say so in the pull request.
- Add a test next to the module (`src/foo.test.ts`) for new logic.
- Screenshots help reviews of UI changes.
