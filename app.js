const STORAGE_KEY = "story-teller-settings";
const OPENAI_URL = "https://api.openai.com/v1";

const form = document.querySelector("#story-form");
const apiKeyInput = document.querySelector("#api-key");
const storyPromptInput = document.querySelector("#story-prompt");
const storyModelInput = document.querySelector("#story-model");
const voiceInput = document.querySelector("#voice");
const languageInput = document.querySelector("#language");
const voiceStyleInput = document.querySelector("#voice-style");
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
  activeAudio: null,
  activeAudioUrl: "",
  currentSegment: null,
  currentConfig: null,
  storyHistory: [],
  queue: [],
  queuedPromise: null,
};

initializeApp();

function initializeApp() {
  try {
    loadSettings();
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

function updateSegmentCount() {
  segmentCount.textContent = `${state.storyHistory.length + state.queue.length} parts`;
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
    voiceStyleInput.value = saved.voiceStyle || "Warm, expressive, immersive storyteller.";
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
    voiceStyle: voiceStyleInput.value.trim(),
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
  const voiceStyle = voiceStyleInput.value.trim();

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
    voiceStyle,
  };

  storyLog.innerHTML = "";
  updateSegmentCount();
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
  if (!state.activeAudio || state.isPaused) {
    return;
  }

  state.isPaused = true;
  state.activeAudio.pause();
  updateStatus("Paused", "paused");
  nowPlaying.textContent = "Playback paused.";
  renderButtons();
}

function resumeStory() {
  if (!state.activeAudio || !state.isPaused) {
    return;
  }

  state.activeAudio.play()
    .then(() => {
      state.isPaused = false;
      updateStatus("Playing", "playing");
      nowPlaying.textContent = "Story playback resumed.";
      renderButtons();
    })
    .catch(() => {
      showError("Tap resume again if playback is blocked by this browser.");
    });
}

function stopStory() {
  state.isRunning = false;
  state.isPaused = false;
  state.isPreparing = false;
  state.queue = [];
  state.queuedPromise = null;
  state.currentSegment = null;
  cleanupActiveAudio();

  renderButtons();
}

function renderButtons() {
  const running = state.isRunning;
  pauseButton.disabled = !running || state.isPaused || !state.activeAudio;
  resumeButton.disabled = !running || !state.isPaused || !state.activeAudio;
  stopButton.disabled = !running && !state.activeAudio && state.queue.length === 0;
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
  updateSegmentCount();
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
  updateSegmentCount();

  appendStoryEntry(nextSegment, storyIndex);
  nowPlaying.textContent = `Preparing audio for part ${storyIndex} in ${nextSegment.languageTag}.`;
  updateStatus("Preparing audio...", "loading");
  renderButtons();
  prepareUpcomingSegment().catch(failSession);

  playSegmentAudio(nextSegment, storyIndex).catch(failSession);
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

function cleanupActiveAudio() {
  if (state.activeAudio) {
    state.activeAudio.pause();
    state.activeAudio.src = "";
    state.activeAudio = null;
  }

  if (state.activeAudioUrl) {
    URL.revokeObjectURL(state.activeAudioUrl);
    state.activeAudioUrl = "";
  }
}

function buildVoiceInstructions(languageTag, voiceStyle) {
  const instructionParts = [
    "Read this like a polished storyteller for a mobile storytelling app.",
    `Speak naturally in ${languageTag || "the requested language"}.`,
  ];

  if (voiceStyle) {
    instructionParts.push(`Voice style: ${voiceStyle}.`);
  }

  instructionParts.push("Use expressive pacing, clear pronunciation, and a warm narrative tone.");
  return instructionParts.join(" ");
}

async function requestSpeechAudio({ apiKey, voice, languageTag, voiceStyle, story }) {
  const response = await fetch(`${OPENAI_URL}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      input: story,
      instructions: buildVoiceInstructions(languageTag, voiceStyle),
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    let message = "Could not generate speech audio.";

    try {
      const errorData = await response.json();
      message = errorData.error?.message || message;
    } catch (error) {
      console.warn("Could not parse TTS error response", error);
    }

    throw new Error(message);
  }

  return response.blob();
}

async function playSegmentAudio(segment, storyIndex) {
  const sessionId = state.sessionId;
  const audioBlob = await requestSpeechAudio({
    apiKey: state.currentConfig.apiKey,
    voice: state.currentConfig.voice,
    languageTag: segment.languageTag,
    voiceStyle: state.currentConfig.voiceStyle,
    story: segment.story,
  });

  if (!state.isRunning || sessionId !== state.sessionId) {
    return;
  }

  cleanupActiveAudio();

  const audioUrl = URL.createObjectURL(audioBlob);
  const audio = new Audio(audioUrl);
  audio.preload = "auto";
  audio.playsInline = true;

  state.activeAudio = audio;
  state.activeAudioUrl = audioUrl;
  state.isPaused = false;

  audio.addEventListener("play", () => {
    if (state.activeAudio !== audio) {
      return;
    }

    updateStatus("Playing", "playing");
    nowPlaying.textContent = `Playing part ${storyIndex} in ${segment.languageTag}.`;
    renderButtons();
  });

  audio.addEventListener("ended", () => {
    if (state.activeAudio !== audio) {
      return;
    }

    cleanupActiveAudio();

    if (!state.isRunning) {
      updateStatus("Stopped", "idle");
      nowPlaying.textContent = "Story stopped.";
      renderButtons();
      return;
    }

    nowPlaying.textContent = `Finished part ${storyIndex}. Preparing the next one...`;
    renderButtons();
    playNextSegment();
  });

  audio.addEventListener("error", () => {
    if (state.activeAudio !== audio) {
      return;
    }

    failSession(new Error("Audio playback failed in this browser."));
  });

  renderButtons();

  try {
    await audio.play();
  } catch (error) {
    if (error?.name === "NotAllowedError") {
      state.isPaused = true;
      updateStatus("Tap Resume", "paused");
      nowPlaying.textContent = `Audio for part ${storyIndex} is ready. Tap Resume to start playback.`;
      renderButtons();
      return;
    }

    throw error;
  }
}

function failSession(error) {
  console.error(error);
  stopStory();
  updateStatus("Error", "idle");
  const message = error.message || "Something went wrong.";
  nowPlaying.textContent = message;
  showError(message);
}
