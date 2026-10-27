import { test } from "node:test";
import assert from "node:assert/strict";
import { answerLang, checkItem, guessLang, lessonMetrics, summarize } from "./evalRules.ts";

const EN_TR = { target: "en", native: "tr" } as const;

test("guessLang names each course language and gives up on short or unclear text", () => {
  assert.equal(guessLang("I am fine, thank you."), "en");
  assert.equal(guessLang("Ich bin heute sehr müde."), "de");
  assert.equal(guessLang("Yo estoy muy bien, gracias."), "es");
  assert.equal(guessLang("Je suis très content de te voir."), "fr");
  assert.equal(guessLang("Ben bugün çok yorgunum ama iyiyim."), "tr");
  assert.equal(guessLang("Köszönöm, nagyon jól vagyok."), "hu");
  assert.equal(guessLang("Jó napot kívánok, Kovács úr!"), "hu"); // á, í, ó and ú are Hungarian too, not only Spanish
  assert.equal(guessLang("¿Dónde está la estación?"), "es");
  assert.equal(guessLang("Nie wiem, co to znaczy."), "pl");
  assert.equal(guessLang("Kiedy masz urodziny?"), "pl"); // sz is Hungarian too
  assert.equal(guessLang("Wpisz usłyszane zdanie."), "pl");
  assert.equal(guessLang("Hello there"), null); // under 3 words
  assert.equal(guessLang("Maria Paulo Tokyo"), null); // no stopword: no winner
});

test("a sound choice item passes every rule", () => {
  const g = { prompt: "'Günaydın' İngilizcede nasıl söylenir?", options: ["Good morning", "Good night", "Goodbye", "Thank you"], answer_index: 0 };
  assert.deepEqual(checkItem("multiple_choice", g, EN_TR), []);
});

test("choice items: answer outside the options, equal options, answer named in the prompt", () => {
  assert.deepEqual(checkItem("multiple_choice", { prompt: "Hangisi?", options: ["Hi", "Bye", "Yes"], answer_index: 3 }, EN_TR), ["answer_in_options", "dropped"]);
  assert.deepEqual(checkItem("multiple_choice", { prompt: "Hangisi?", options: ["Good morning", "good morning!", "Bye", "Hi"], answer_index: 0 }, EN_TR), ["distinct_options"]);
  assert.deepEqual(checkItem("word_select", { prompt: "'evening' kelimesi hangisi?", options: ["evening", "morning", "night", "noon"], answer_index: 0 }, EN_TR), ["no_leak", "dropped"]);
});

test("word_bank: a distractor that is an answer word, the answer sentence in the prompt", () => {
  const g = { prompt: "Ben öğretmenim.", answer_words: ["I", "am", "a", "teacher."], distractor_words: ["is", "an"] };
  assert.deepEqual(checkItem("word_bank", g, EN_TR), []);
  assert.deepEqual(checkItem("word_bank", { ...g, distractor_words: ["teacher", "is"] }, EN_TR), ["distinct_options"]);
  assert.deepEqual(checkItem("word_bank", { ...g, prompt: "I am a teacher. (Ben öğretmenim.)" }, EN_TR), ["no_leak"]);
});

test("translate copies the source; listen_type shows the audio text", () => {
  assert.deepEqual(checkItem("translate", { prompt: "Türkçeye çevir.", source_sentence: "Merhaba", answer: "merhaba!", accepted_answers: [] }, EN_TR), ["no_leak"]);
  assert.deepEqual(checkItem("listen_type", { prompt: "Duyduğunu yaz.", audio_text: "I like coffee", accepted_answers: [] }, EN_TR), []);
  assert.deepEqual(checkItem("listen_type", { prompt: "Duyduğunu yaz: I like coffee", audio_text: "I like coffee", accepted_answers: [] }, EN_TR), ["no_leak"]);
});

test("translate works in both directions", () => {
  const tr = "Ben bir öğretmenim ve çok mutluyum.", en = "I am a teacher and I am very happy.";
  assert.deepEqual(checkItem("translate", { prompt: "İngilizceye çevir.", source_sentence: tr, answer: en, accepted_answers: [] }, EN_TR), []);
  assert.deepEqual(checkItem("translate", { prompt: "Türkçeye çevir.", source_sentence: en, answer: tr, accepted_answers: [] }, EN_TR), []);
});

test("fill_blank needs exactly one blank", () => {
  const g = { prompt: "Boşluğu doldur.", sentence_with_blank: "I ___ a teacher.", options: ["am", "is", "are", "be"], answer_index: 0 };
  assert.deepEqual(checkItem("fill_blank", g, EN_TR), []);
  assert.deepEqual(checkItem("fill_blank", { ...g, sentence_with_blank: "I ___ a ____." }, EN_TR), ["one_blank"]);
});

test("match: a repeated target word", () => {
  const pairs = [{ target: "hi", native: "selam" }, { target: "Hi!", native: "merhaba" }, { target: "bye", native: "hoşça kal" }];
  assert.deepEqual(checkItem("match", { pairs }, EN_TR), ["distinct_options"]);
});

test("target text in another language; native text in the target language", () => {
  assert.deepEqual(checkItem("speak", { sentence: "Je suis très content.", translation: "Çok mutluyum." }, EN_TR), ["target_lang"]);
  assert.deepEqual(checkItem("learn", { phrase: "Good morning", translation: "Günaydın", note: "You say this in the morning to greet someone." }, EN_TR), ["native_lang"]);
});

test("native text quoting target-language text is not flagged", () => {
  const mc = { prompt: "'Good morning, how are you?' Türkçede ne demek?", options: ["Günaydın, nasılsın?", "İyi geceler", "Hoşça kal", "Teşekkürler"], answer_index: 0 };
  assert.deepEqual(checkItem("multiple_choice", mc, EN_TR), []);
  const ls = { prompt: "Duyduğun cümle: 'I am at the office'?", audio_text: "I am at the office", options: ["Ofisteyim", "Evdeyim", "Okuldayım", "Parktayım"], answer_index: 0 };
  assert.deepEqual(checkItem("listen_select", ls, EN_TR), []);
});

test("a Turkish suffix apostrophe is not a quote", () => {
  const g = { prompt: "İstanbul'a gitmek istiyorum, bu cümleyi nasıl söylersin?", options: ["I want to go to Istanbul", "I live in Istanbul", "I like Istanbul", "I left Istanbul"], answer_index: 0 };
  assert.ok(!checkItem("multiple_choice", g, EN_TR).includes("native_lang"));
});

test("lessonMetrics counts values, not key names, at word starts", () => {
  const item = { type: "learn", raw: { phrase: "Good morning", translation: "Günaydın", note: "Sabah söylenir." } };
  assert.equal(lessonMetrics(["note", "translation", "answer"], [item], "tr").vocab_coverage, 0);
  const q = { type: "speak", raw: { sentence: "How old are you?", translation: "Kaç yaşındasın?" } };
  assert.equal(lessonMetrics(["", "yaş"], [q], "tr").vocab_coverage, 100);
});

test("lessonMetrics: vocabulary coverage and repeated sentences", () => {
  const items = [
    { type: "speak", raw: { sentence: "Good morning, how are you?", translation: "Günaydın, nasılsın?" } },
    { type: "listen_type", raw: { prompt: "Duyduğunu yaz.", audio_text: "Good morning, how are you?", accepted_answers: [] } },
    { type: "speak", raw: { sentence: "Thank you very much.", translation: "Çok teşekkürler." } },
  ];
  assert.deepEqual(lessonMetrics(["good morning", "goodbye", "thank you"], items, "tr"), { vocab_coverage: 67, repeats: 1 });
});

test("summarize: a row per type, then the total", () => {
  const rows = summarize([
    { type: "match", raw: {}, failed: [] },
    { type: "match", raw: {}, failed: ["distinct_options"] },
    { type: "speak", raw: {}, failed: [], judge: { notes: "", natural: 4, level_fit: 5, clear: 3, one_correct: true } },
  ]);
  assert.deepEqual(rows.map((r) => [r.type, r.items, r.pass, r.fails.distinct_options, r.natural, r.one_correct]),
    [["match", 2, 50, 1, null, null], ["speak", 1, 100, 0, 4, 100], ["total", 3, 67, 1, 4, 100]]);
});

test("dictation listens in the answer's language (#26)", () => {
  const en = "I would like a cup of coffee", tr = "Bir fincan kahve istiyorum lütfen bu sabah";
  assert.equal(answerLang({ answer: tr, context: en }, "en", "tr"), "tr");
  assert.equal(answerLang({ answer: en, context: tr }, "en", "tr"), "en");
  assert.equal(answerLang({ answer: "kahve", context: "the coffee is hot" }, "en", "tr"), "tr"); // short answer: the source decides
  assert.equal(answerLang({ answer: "coffee", context: "" }, "en", "tr"), "en"); // listen_type
});
