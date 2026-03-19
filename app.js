const STORAGE_KEY = "story-teller-settings";
const OPENAI_URL = "https://api.openai.com/v1";

const form = document.querySelector("#story-form");
const apiKeyInput = document.querySelector("#api-key");
const storyPromptInput = document.querySelector("#story-prompt");
const storyModelInput = document.querySelector("#story-model");
const voiceInput = document.querySelector("#voice");
const languageInput = document.querySelector("#language");
const startButton = document.querySelector("#start-button");
const pauseButton = document.querySelector("#pause-button");
const resumeButton = document.querySelector("#resume-button");
const stopButton = document.querySelector("#stop-button");
const statusPill = document.querySelector("#status-pill");
const segmentCount = document.querySelector("#segment-count");
const nowPlaying = document.querySelector("#now-playing");
const errorBanner = document.querySelector("#error-banner");
const storyLog = document.querySelector("#story-log");

const state = {
  sessionId: 0,
  isRunning: false,
  isPaused: false,
  isPreparing: false,
  activeUtterance: null,
  currentSegment: null,
  availableVoices: [],
  currentConfig: null,
  storyHistory: [],
  queue: [],
  queuedPromise: null,
};

initializeApp();

function initializeApp() {
  try {
    loadSettings();
    loadVoices();
    startButton.addEventListener("click", handleStart);
    pauseButton.addEventListener("click", pauseStory);
    resumeButton.addEventListener("click", resumeStory);
    stopButton.addEventListener("click", stopStory);

    window.addEventListener("error", (event) => {
      showError(event.error?.message || event.message || "Unexpected browser error.");
    });

    window.addEventListener("unhandledrejection", (event) => {
      showError(event.reason?.message || "Unexpected async browser error.");
    });

    updateStatus("Idle", "idle");
    nowPlaying.textContent = "Nothing is playing yet.";
    clearError();
    renderButtons();
  } catch (error) {
    showError(error.message || "App initialization failed.");
  }
}

function loadSettings() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const saved = JSON.parse(raw);
    apiKeyInput.value = saved.apiKey || "";
    storyModelInput.value = saved.storyModel || "gpt-5-mini";
    voiceInput.value = saved.voice || "marin";
    languageInput.value = saved.language || "";
  } catch (error) {
    console.warn("Could not restore settings", error);
  }
}

function saveSettings() {
  const saved = {
    apiKey: apiKeyInput.value.trim(),
    storyModel: storyModelInput.value,
    voice: voiceInput.value,
    language: languageInput.value.trim(),
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

async function handleStart(event) {
  if (event) {
    event.preventDefault();
  }

  const apiKey = apiKeyInput.value.trim();
  const premise = storyPromptInput.value.trim();
  const storyModel = storyModelInput.value;
  const voice = voiceInput.value;
  const languageTag = (languageInput.value.trim() || guessLanguageTag(premise)).trim();

  if (!apiKey || !premise) {
    updateStatus("Please add both the API key and a story idea.", "idle");
    showError("Add both the API key and a story idea, then start again.");
    return;
  }

  stopStory();
  saveSettings();
  clearError();

  state.sessionId += 1;
  state.isRunning = true;
  state.isPaused = false;
  state.storyHistory = [];
  state.queue = [];
  state.queuedPromise = null;
  state.currentConfig = {
    apiKey,
    premise,
    storyModel,
    voice,
    languageTag,
  };

  storyLog.innerHTML = "";
  segmentCount.textContent = "0 parts";
  nowPlaying.textContent = "Preparing the first part of the story...";
  updateStatus("Creating the first story part...", "loading");
  renderButtons();

  try {
    const firstSegment = await createSegment({
      config: state.currentConfig,
      storyHistory: [],
      isFirstSegment: true,
      sessionId: state.sessionId,
    });

    if (!firstSegment) {
      return;
    }

    enqueueSegment(firstSegment);
    playNextSegment();
  } catch (error) {
    failSession(error);
  }
}

function pauseStory() {
  if (!state.activeUtterance || state.isPaused) {
    return;
  }

  state.isPaused = true;
  window.speechSynthesis.pause();
  updateStatus("Paused", "paused");
  nowPlaying.textContent = "Playback paused.";
  renderButtons();
}

function resumeStory() {
  if (!state.activeUtterance || !state.isPaused) {
    return;
  }

  state.isPaused = false;
  window.speechSynthesis.resume();
  updateStatus("Playing", "playing");
  nowPlaying.textContent = "Story playback resumed.";
  renderButtons();
}

function stopStory() {
  state.isRunning = false;
  state.isPaused = false;
  state.isPreparing = false;
  state.queue = [];
  state.queuedPromise = null;
  state.currentSegment = null;

  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }

  state.activeUtterance = null;

  renderButtons();
}

function renderButtons() {
  const running = state.isRunning;
  pauseButton.disabled = !running || state.isPaused || !state.activeUtterance;
  resumeButton.disabled = !running || !state.isPaused || !state.activeUtterance;
  stopButton.disabled = !running && !state.activeUtterance && state.queue.length === 0;
}

function updateStatus(message, tone) {
  statusPill.textContent = message;
  statusPill.className = `status-pill ${tone}`;
}

function showError(message) {
  if (!errorBanner) {
    return;
  }

  errorBanner.hidden = false;
  errorBanner.textContent = message;
}

function clearError() {
  if (!errorBanner) {
    return;
  }

  errorBanner.hidden = true;
  errorBanner.textContent = "";
}

function enqueueSegment(segment) {
  state.queue.push(segment);
  segmentCount.textContent = `${state.storyHistory.length + state.queue.length} parts`;
}

function appendStoryEntry(segment, index) {
  const article = document.createElement("article");
  article.className = "story-entry";

  const heading = document.createElement("h2");
  heading.textContent = `Part ${index}`;

  const body = document.createElement("p");
  body.textContent = segment.story;

  article.append(heading, body);
  storyLog.append(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

async function playNextSegment() {
  if (!state.isRunning || state.isPaused) {
    return;
  }

  const nextSegment = state.queue.shift();
  segmentCount.textContent = `${state.storyHistory.length + state.queue.length} parts`;

  if (!nextSegment) {
    updateStatus("Preparing the next part...", "loading");
    state.queuedPromise = state.queuedPromise || prepareUpcomingSegment();

    try {
      await state.queuedPromise;
    } catch (error) {
      failSession(error);
      return;
    }

    if (!state.isRunning || state.isPaused) {
      return;
    }

    return playNextSegment();
  }

  const storyIndex = state.storyHistory.length + 1;
  state.storyHistory.push({
    story: nextSegment.story,
    languageTag: nextSegment.languageTag,
  });
  state.currentSegment = nextSegment;

  appendStoryEntry(nextSegment, storyIndex);
  nowPlaying.textContent = `Playing part ${storyIndex} in ${nextSegment.languageTag}.`;
  updateStatus("Playing", "playing");
  renderButtons();

  speakSegment(nextSegment, storyIndex);
}

async function prepareUpcomingSegment() {
  if (!state.isRunning || state.queue.length > 0 || state.queuedPromise || state.isPreparing) {
    return state.queuedPromise;
  }

  const sessionId = state.sessionId;
  state.isPreparing = true;
  updateStatus("Preparing the next part...", "loading");

  const pending = createSegment({
    config: state.currentConfig,
    storyHistory: state.storyHistory,
    isFirstSegment: false,
    sessionId,
  })
    .then((segment) => {
      if (!segment || sessionId !== state.sessionId || !state.isRunning) {
        return;
      }

      enqueueSegment(segment);
    })
    .finally(() => {
      state.queuedPromise = null;
      state.isPreparing = false;

      if (state.isRunning && !state.isPaused) {
        updateStatus("Playing", "playing");
      }
    });

  state.queuedPromise = pending;
  return pending;
}

async function createSegment({ config, storyHistory, isFirstSegment, sessionId }) {
  const storyPayload = await requestStoryPart({
    apiKey: config.apiKey,
    premise: config.premise,
    storyModel: config.storyModel,
    languageTag: config.languageTag,
    storyHistory,
    isFirstSegment,
    sessionId,
  });

  if (!state.isRunning || sessionId !== state.sessionId) {
    return null;
  }

  return {
    story: storyPayload.story,
    languageTag: storyPayload.languageTag || config.languageTag,
  };
}

async function requestStoryPart({
  apiKey,
  premise,
  storyModel,
  languageTag,
  storyHistory,
  isFirstSegment,
}) {
  const continuationContext = storyHistory
    .slice(-4)
    .map((item, index) => `Part ${storyHistory.length - (storyHistory.slice(-4).length - 1) + index}: ${item.story}`)
    .join("\n\n");

  const prompt = `
You are writing an endless spoken story for a smartphone storytelling app.

Return only valid JSON with this shape:
{"languageTag":"pt-BR","story":"..."}

Rules:
- Write in the language used by the user's premise.
- If the premise is in Portuguese, use Brazilian Portuguese and return "pt-BR".
- Keep the languageTag as a BCP-47 style tag when possible.
- The segment must feel complete enough to read aloud, but it must clearly invite continuation.
- Do not end the full story. Do not summarize. Do not say "the end".
- End with open momentum, curiosity, tension, discovery, or a new question.
- Keep the segment between 120 and 190 words.
- Use vivid, listener-friendly prose.

User premise:
${premise}

Preferred language tag:
${languageTag}

${isFirstSegment ? "Write the first segment." : `Continue naturally from these recent parts:\n\n${continuationContext}\n\nWrite the next segment only.`}
  `.trim();

  const response = await fetch(`${OPENAI_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: storyModel,
      input: prompt,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Could not generate the next story segment.");
  }

  const text = extractResponseText(data);
  const parsed = extractJson(text);

  if (!parsed?.story) {
    throw new Error("The story response could not be parsed.");
  }

  return {
    languageTag: sanitizeLanguageTag(parsed.languageTag) || languageTag,
    story: parsed.story.trim(),
  };
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const parts = [];

  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    console.warn("Could not parse JSON", error);
    return null;
  }
}

function sanitizeLanguageTag(languageTag) {
  if (!languageTag || typeof languageTag !== "string") {
    return "";
  }

  return languageTag.replace(/[^a-zA-Z-]/g, "").trim();
}

function guessLanguageTag(text) {
  const sample = text.toLowerCase();

  if (/[ãõáéíóúâêôç]/.test(sample) || /\b(uma|que|era|com|não|para|numa|história)\b/.test(sample)) {
    return "pt-BR";
  }

  if (/\b(el|ella|había|bosque|misterio|cuento)\b/.test(sample)) {
    return "es-ES";
  }

  if (/\b(le|la|une|forêt|histoire|mystère)\b/.test(sample)) {
    return "fr-FR";
  }

  if (/\b(der|die|und|geschichte|wald|geheimnis)\b/.test(sample)) {
    return "de-DE";
  }

  return "en-US";
}

function loadVoices() {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    return;
  }

  const syncVoices = () => {
    state.availableVoices = window.speechSynthesis.getVoices();
  };

  syncVoices();

  if (typeof window.speechSynthesis.addEventListener === "function") {
    window.speechSynthesis.addEventListener("voiceschanged", syncVoices);
    return;
  }

  if ("onvoiceschanged" in window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = syncVoices;
  }
}

function speakSegment(segment, storyIndex) {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    failSession(new Error("This browser does not support speech synthesis."));
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(segment.story);
  utterance.lang = sanitizeLanguageTag(segment.languageTag) || "pt-BR";
  utterance.rate = 0.95;
  utterance.pitch = 1;

  const preferredVoice = pickVoice(
    utterance.lang,
    state.currentConfig?.voice || "",
    state.availableVoices
  );

  if (preferredVoice) {
    utterance.voice = preferredVoice;
  }

  utterance.onstart = () => {
    state.activeUtterance = utterance;
    updateStatus("Playing", "playing");
    renderButtons();
    prepareUpcomingSegment().catch(failSession);
  };

  utterance.onend = () => {
    if (state.activeUtterance === utterance) {
      state.activeUtterance = null;
    }

    if (!state.isRunning) {
      updateStatus("Stopped", "idle");
      nowPlaying.textContent = "Story stopped.";
      renderButtons();
      return;
    }

    nowPlaying.textContent = `Finished part ${storyIndex}. Preparing the next one...`;
    renderButtons();
    playNextSegment();
  };

  utterance.onerror = (event) => {
    if (event.error === "interrupted" && !state.isRunning) {
      return;
    }

    failSession(new Error("Speech playback failed in this browser."));
  };

  state.activeUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

function pickVoice(languageTag, selectedVoice, voices) {
  if (!voices.length) {
    return null;
  }

  const normalizedTag = languageTag.toLowerCase();
  const exactMatch = voices.find((voice) => voice.lang.toLowerCase() === normalizedTag);
  const baseLanguage = normalizedTag.split("-")[0];
  const sameLanguage = voices.find((voice) => voice.lang.toLowerCase().startsWith(`${baseLanguage}-`));
  const brazilianVoice = voices.find((voice) => voice.lang.toLowerCase() === "pt-br");
  const nameMatch = voices.find((voice) => voice.name.toLowerCase().includes(selectedVoice.toLowerCase()));

  return exactMatch || sameLanguage || brazilianVoice || nameMatch || voices[0];
}

function failSession(error) {
  console.error(error);
  stopStory();
  updateStatus("Error", "idle");
  const message = error.message || "Something went wrong.";
  nowPlaying.textContent = message;
  showError(message);
}
