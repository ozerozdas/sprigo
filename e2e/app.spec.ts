import { expect, test, type Page } from "@playwright/test";
import { ANSWER, BANK, FORM, PAIRS, mockOllama } from "./mockAi";

test.beforeEach(async ({ page }) => { await mockOllama(page); });

/** First run: create a profile learning Spanish, then save the (mocked) local Ollama model. */
async function onboard(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create your profile" })).toBeVisible();
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("First course").selectOption("es");
  await page.getByRole("button", { name: "Create profile" }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Ollama found on this Mac")).toBeVisible();
  await sheet.getByRole("radio", { name: /Ollama/ }).click();
  await expect(sheet.getByLabel(/Model/)).toHaveValue("mock:latest");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet.getByRole("radio", { name: /Ollama/ })).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("button", { name: "Cancel" }).click();
}

test("onboarding creates a profile and sets up local AI", async ({ page }) => {
  await onboard(page);
  await expect(page.getByText("Ollama · mock:latest")).toBeVisible();
  await page.reload(); // signed in again, AI still set up
  await page.getByRole("button", { name: "Learn" }).click();
  await expect(page.getByText("Greetings & Introductions")).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("help answers setup questions in the app, also from a setting's ?", async ({ page }) => {
  await onboard(page);
  await page.locator(".card", { hasText: "Help & FAQ" }).getByRole("button", { name: "Open" }).click();
  const help = page.getByRole("dialog");
  await help.getByText("Where is my data?").click();
  await expect(help.getByText(/Application Support\/com\.ozerozdas\.sprigo/)).toBeVisible();
  await expect(help.getByRole("link", { name: "More on the wiki" }).first()).toHaveAttribute("href", /\/wiki\/FAQ$/);
  await help.getByRole("button", { name: "Close" }).click();

  await page.getByRole("tab", { name: "AI & voice" }).click();
  await page.locator(".card", { hasText: "AI provider" }).getByRole("button", { name: "Change" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Help: How do I set up the AI?" }).click();
  await expect(page.locator("details[open] summary")).toHaveText("How do I set up the AI?");
});

/** Answers whatever exercise is on screen with the mock's right answer; false once the lesson is over. */
async function answer(lesson: ReturnType<Page["getByRole"]>) {
  const button = (name: string) => lesson.getByRole("button", { name, exact: true });
  const opt = (text: string) => lesson.locator(".opt", { hasText: new RegExp(`^\\d?${text}$`) });
  if (await lesson.locator(".result-wrap").isVisible()) return false;
  for (const name of ["Continue", "Finish", "Can't speak now"]) if (await button(name).isVisible()) return button(name).click().then(() => true);
  if (await lesson.getByRole("heading", { name: "Match the pairs" }).isVisible()) {
    for (const [a, b] of PAIRS) { await opt(a).click(); await opt(b).click(); }
  } else if (await lesson.getByLabel("Your answer").isVisible()) {
    await lesson.getByLabel("Your answer").fill(ANSWER);
    await button("Check").click();
  } else if (await lesson.locator(".bank").isVisible()) {
    for (const w of BANK) await lesson.locator(".bank .tok", { hasText: w }).click();
    await button("Check").click();
  } else {
    await opt(ANSWER).click();
    await button("Check").click();
  }
  await expect(lesson.getByText("Correct!")).toBeVisible();
  return true;
}

async function runLesson(page: Page, step: RegExp) {
  await page.getByRole("button", { name: step }).click();
  const lesson = page.getByRole("dialog", { name: "Lesson" });
  await expect(lesson.getByRole("heading", { name: "New phrase" })).toBeVisible();
  for (let i = 0; await answer(lesson); i++) expect(i).toBeLessThan(30);
  await expect(lesson.getByText("100%")).toBeVisible(); // accuracy: every answer was right
  await lesson.getByRole("button", { name: "Done" }).click();
  await expect(lesson).toBeHidden();
}

// The first two steps cover all five renderers: learn, choice, match, speak (skipped), then input and word bank.
test("first lessons run every exercise type", async ({ page }) => {
  await onboard(page);
  await page.getByRole("button", { name: "Learn" }).click();
  await runLesson(page, /Basic Greetings/);
  await runLesson(page, /Introduce Yourself/);
});

test("a story opens from Stories, marks known words and can be finished", async ({ page }) => {
  await onboard(page);
  await page.getByRole("button", { name: "Learn" }).click();
  await runLesson(page, /Basic Greetings/); // puts "hola" in the word list
  await page.getByRole("button", { name: "Stories", exact: true }).click();
  await page.getByRole("button", { name: /^Greetings & Introductions/ }).click();
  const story = page.getByRole("dialog", { name: "ok" }); // the mock's story title
  await expect(story.locator(".tap-word.known", { hasText: "Hola" }).first()).toBeVisible();
  for (let i = 0; !(await story.getByText("Story complete!").isVisible()); i++) {
    expect(i).toBeLessThan(40);
    const opt = story.locator(".opt", { hasText: /^\d?hola$/ });
    if (await opt.isVisible() && await opt.isEnabled()) { await opt.click(); await story.getByRole("button", { name: "Check" }).click(); }
    else await story.getByRole("button", { name: /^(Continue|Finish)$/ }).click();
  }
  await story.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: /Greetings & Introductions.*Read again/ })).toBeVisible(); // remembered
});

test("Stories lists earlier levels once the learner moves up", async ({ page }) => {
  await onboard(page);
  await page.getByRole("button", { name: "Learn" }).click();
  await page.getByRole("button", { name: "Skip A1 — take the level test" }).click();
  const exam = page.getByRole("dialog", { name: "Lesson" });
  for (let i = 0; await answer(exam); i++) expect(i).toBeLessThan(60);
  await expect(exam.getByText("A1 complete!")).toBeVisible();
  await exam.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Stories", exact: true }).click();
  const level = page.getByLabel("Levels");
  await expect(level).toHaveValue("A2");
  await level.selectOption("A1");
  const units = page.locator("main .card.row-item");
  await expect(units.getByText("Read")).toHaveCount(await units.count()); // every A1 story is open
  await units.first().click();
  await expect(page.getByRole("dialog", { name: "ok" }).getByText("Hola").first()).toBeVisible();
});

test("writing practice corrects the text inline and queues the mistake", async ({ page }) => {
  await onboard(page);
  await page.getByRole("button", { name: "Practice" }).click();
  await page.getByRole("button", { name: /^Writing/ }).click();
  await page.locator(".sheet").getByRole("button", { name: /Greetings & Introductions/ }).click();
  const w = page.getByRole("dialog", { name: "Greetings & Introductions" });
  await expect(w.getByRole("heading", { name: "Write two sentences about yourself." })).toBeVisible();
  await w.getByLabel("Your answer").fill("Yo es Ana. Me gusta leer.");
  await w.getByRole("button", { name: "Check" }).click();
  await expect(w.locator(".fix del")).toHaveText("Yo es");
  await expect(w.locator(".fix ins")).toHaveText("Yo soy");
  await expect(w.getByText("With yo, ser is soy.")).toBeVisible();
  await w.getByRole("button", { name: "Finish" }).click();
  await expect(w.getByText("Writing done!")).toBeVisible();
  await w.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: /Fix your mistakes.*1 question waiting/ })).toBeVisible();
});

test("the profile charts XP and words after a lesson", async ({ page }) => {
  await onboard(page);
  await page.getByRole("button", { name: "Learn" }).click();
  await runLesson(page, /Basic Greetings/);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Progress" })).toBeVisible();
  const xp = page.getByRole("img", { name: /^XP per day\. [1-9]\d* XP in the last 14 days/ });
  await expect(xp.locator("path")).toHaveCount(1); // one bar: today
  await expect(page.getByRole("img", { name: /^Words learned\. [1-9]\d* words, [1-9]\d* new/ })).toBeVisible();
  const acc = page.locator(".acc-rows li");
  await expect(acc.filter({ hasText: "Choice" })).toContainText("100%"); // every answer was right
  await expect(acc.filter({ hasText: "Pairs" })).toContainText("100%");
  await expect(page.getByRole("img", { name: "Speaking pace. Nothing yet" })).toBeVisible(); // no voice session in this run
});

test("a conjugation drill asks the cross-checked forms and queues a miss", async ({ page }) => {
  await onboard(page);
  await page.getByRole("button", { name: "Practice" }).click();
  await page.getByRole("button", { name: /^Verb forms.*presente/ }).click();
  const drill = page.getByRole("dialog", { name: "Lesson" });
  for (let i = 0; !(await drill.locator(".result-wrap").isVisible()); i++) {
    expect(i).toBeLessThan(20);
    const next = drill.getByRole("button", { name: /^(Continue|Finish)$/ });
    if (await next.isVisible()) { await next.click(); continue; }
    await expect(drill.locator(".ctx-cells span")).toHaveCount(3); // verb | person | tense
    await expect(drill.locator(".ctx-cells span").last()).toHaveText("presentetense"); // the form, then its caption
    await drill.getByLabel("Your answer").fill(i ? FORM : "hablo"); // the first one wrong
    await drill.getByRole("button", { name: "Check", exact: true }).click();
    await expect(drill.getByText(i ? "Correct!" : FORM).first()).toBeVisible();
  }
  await drill.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: /Fix your mistakes.*1 question waiting/ })).toBeVisible();
});

test("the grammar reference searches every pattern and drills one", async ({ page }) => {
  await onboard(page);
  await page.getByRole("button", { name: "Grammar" }).click();
  await expect(page.getByRole("heading", { name: /^A1 · / })).toBeVisible();
  await page.getByLabel("Search grammar").fill("LLAMAS");
  await expect(page.getByRole("button", { name: "¿Cómo te llamas?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "¡Buenos días!" })).toBeHidden();
  await page.getByRole("button", { name: "¿Cómo te llamas?" }).click();
  const sheet = page.getByRole("dialog", { name: "¿Cómo te llamas?" });
  await sheet.getByRole("button", { name: "Explain this" }).click();
  await expect(sheet.getByRole("alert")).toContainText("left this pattern out"); // the mock's guide has no grammar entries
  await sheet.getByRole("button", { name: "Practise this" }).click();
  const lesson = page.getByRole("dialog", { name: "Lesson" });
  await expect(lesson.getByRole("heading", { name: "Which word means “hello”?" })).toBeVisible(); // a drill has no teaching cards
  for (let i = 0; await answer(lesson); i++) expect(i).toBeLessThan(20);
  await expect(lesson.getByText("100%")).toBeVisible();
  await lesson.getByRole("button", { name: "Done" }).click();
  await expect(lesson).toBeHidden();
});

test("readable font and text size apply at once and stay after a reload", async ({ page }) => {
  await onboard(page);
  await page.getByRole("tab", { name: "Preferences" }).click();
  await page.locator(".card", { hasText: "Readable font" }).getByRole("button", { name: "Off" }).click();
  await page.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "130%" }).click();
  const look = () => page.evaluate(() => ({ font: getComputedStyle(document.body).fontFamily, zoom: document.documentElement.style.zoom }));
  expect(await look()).toEqual({ font: expect.stringContaining("Atkinson Hyperlegible Next"), zoom: "1.3" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Learn" })).toBeVisible();
  expect(await look()).toEqual({ font: expect.stringContaining("Atkinson Hyperlegible Next"), zoom: "1.3" });
});
