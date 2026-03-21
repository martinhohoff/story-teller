const STORAGE_KEY = "story-teller-settings";
const OPENAI_URL = "https://api.openai.com/v1";

const form = document.querySelector("#story-form");
const apiKeyInput = document.querySelector("#api-key");
const storyPromptInput = document.querySelector("#story-prompt");
const randomStoryButton = document.querySelector("#random-story-button");
const storyModelInput = document.querySelector("#story-model");
const voiceInput = document.querySelector("#voice");
const languageInput = document.querySelector("#language");
const voiceStyleInput = document.querySelector("#voice-style");
const startButton = document.querySelector("#start-button");
const pauseButton = document.querySelector("#pause-button");
const resumeButton = document.querySelector("#resume-button");
const stopButton = document.querySelector("#stop-button");
const statusPill = document.querySelector("#status-pill");
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
  preloadedAudio: null,
  preloadedAudioPromise: null,
  segmentIdCounter: 0,
  currentPartIndex: null,
  textPreparingPartIndex: null,
  audioPreparingPartIndex: null,
  renderedSegments: new Map(),
  playbackPrimed: false,
};

initializeApp();

function initializeApp() {
  try {
    loadSettings();
    startButton.addEventListener("click", handleStart);
    randomStoryButton.addEventListener("click", handleRandomStoryStart);
    storyPromptInput.addEventListener("input", syncRandomStoryButton);
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
    refreshStatusDetail();
    clearError();
    syncRandomStoryButton();
    renderButtons();
  } catch (error) {
    showError(error.message || "App initialization failed.");
  }
}

function updateSegmentCount() {}

function refreshStatusDetail() {
  const details = [];
  const nextQueuedSegment = state.queue[0];
  const nextQueuedPartIndex = state.currentPartIndex ? state.currentPartIndex + 1 : null;
  const currentPartIndex = state.currentPartIndex;

  if (state.isPaused && currentPartIndex) {
    details.push(`Paused on part ${currentPartIndex}`);
  } else if (state.activeAudio && currentPartIndex) {
    details.push(`Playing part ${currentPartIndex}`);
  } else if (currentPartIndex && state.audioPreparingPartIndex === currentPartIndex) {
    details.push(`Generating audio for part ${currentPartIndex}`);
  } else if (state.textPreparingPartIndex) {
    details.push(`Generating text for part ${state.textPreparingPartIndex}`);
  } else {
    details.push("Nothing is playing yet.");
  }

  if (nextQueuedPartIndex) {
    if (state.textPreparingPartIndex === nextQueuedPartIndex) {
      details.push(`Generating text for part ${nextQueuedPartIndex}`);
    } else if (nextQueuedSegment) {
      details.push(`Text for part ${nextQueuedPartIndex} ready`);
    }

    if (state.audioPreparingPartIndex === nextQueuedPartIndex) {
      details.push(`Generating audio for part ${nextQueuedPartIndex}`);
    } else if (state.preloadedAudio?.segmentId === nextQueuedSegment?.id && nextQueuedSegment) {
      details.push(`Audio for part ${nextQueuedPartIndex} ready`);
    }
  }

  nowPlaying.textContent = details.join(" • ");
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

async function startStory(premiseOverride = "") {
  const apiKey = apiKeyInput.value.trim();
  const premise = (premiseOverride || storyPromptInput.value).trim();
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
  await primeAudioPlayback();

  state.sessionId += 1;
  state.isRunning = true;
  state.isPaused = false;
  state.storyHistory = [];
  state.queue = [];
  state.queuedPromise = null;
  state.preloadedAudio = null;
  state.preloadedAudioPromise = null;
  state.currentPartIndex = null;
  state.textPreparingPartIndex = null;
  state.audioPreparingPartIndex = null;
  state.renderedSegments = new Map();
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
  state.textPreparingPartIndex = 1;
  refreshStatusDetail();
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

async function handleStart(event) {
  if (event) {
    event.preventDefault();
  }

  await startStory();
}

function syncRandomStoryButton() {
  if (!randomStoryButton) {
    return;
  }

  randomStoryButton.hidden = storyPromptInput.value.trim().length > 0;
}

function createRandomStoryPrompt() {
  const protagonists = [
    "uma coelhinha curiosa",
    "um ursinho muito gentil",
    "uma estrelinha que caiu pertinho do quintal",
    "um patinho que adora cantar baixinho",
    "uma nuvem fofinha que gosta de passear",
  ];
  const companions = [
    "uma borboleta brilhante",
    "um gatinho sonolento",
    "uma tartaruga sorridente",
    "um vaga-lume dourado",
    "uma joaninha corajosa",
  ];
  const places = [
    "um jardim cheio de flores macias",
    "uma floresta colorida e tranquila",
    "um caminho de nuvens cor-de-rosa",
    "um lago calminho com patos amigos",
    "uma vila pequena com casinhas redondas",
  ];
  const goals = [
    "procurar uma canção que faz todo mundo dormir feliz",
    "encontrar uma luzinha perdida antes da hora de dormir",
    "levar um abraço mágico para um amigo triste",
    "descobrir de onde vem o cheirinho doce do vento",
    "achar o lugar perfeito para um piquenique de luar",
  ];

  const protagonist = protagonists[Math.floor(Math.random() * protagonists.length)];
  const companion = companions[Math.floor(Math.random() * companions.length)];
  const place = places[Math.floor(Math.random() * places.length)];
  const goal = goals[Math.floor(Math.random() * goals.length)];

  return `Conte uma história calma, carinhosa e encantadora para uma criança de 4 anos sobre ${protagonist} e ${companion} em ${place}, enquanto eles saem para ${goal}. Use linguagem simples, imagens suaves, sensação de segurança e um clima aconchegante de aventura antes de dormir.`;
}

async function primeAudioPlayback() {
  if (state.playbackPrimed) {
    return;
  }

  try {
    const primer = new Audio(
      "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAFAAAGhgCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg=="
    );
    primer.playsInline = true;
    primer.muted = true;

    await primer.play();
    primer.pause();
    primer.currentTime = 0;
    state.playbackPrimed = true;
  } catch (error) {
    console.warn("Could not prime mobile audio playback", error);
  }
}

function handleRandomStoryStart(event) {
  if (event) {
    event.preventDefault();
  }

  const prompt = createRandomStoryPrompt();
  storyPromptInput.value = prompt;
  storyPromptInput.dispatchEvent(new Event("input", { bubbles: true }));
  storyPromptInput.dispatchEvent(new Event("change", { bubbles: true }));
  syncRandomStoryButton();
  storyPromptInput.focus();
  storyPromptInput.setSelectionRange(0, 0);

  window.requestAnimationFrame(() => {
    startStory(prompt).catch(failSession);
  });
}

function pauseStory() {
  if (!state.activeAudio || state.isPaused) {
    return;
  }

  state.isPaused = true;
  state.activeAudio.pause();
  updateStatus("Paused", "paused");
  refreshStatusDetail();
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
      refreshStatusDetail();
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
  state.currentPartIndex = null;
  state.textPreparingPartIndex = null;
  state.audioPreparingPartIndex = null;
  cleanupActiveAudio();
  cleanupPreloadedAudio();
  updateMediaSession();
  refreshStatusDetail();

  renderButtons();
}

function renderButtons() {
  const running = state.isRunning;
  startButton.textContent = running ? "Restart story" : "Start story";
  pauseButton.disabled = !running || state.isPaused || !state.activeAudio;
  resumeButton.disabled = !running || !state.isPaused || !state.activeAudio;
  stopButton.disabled = !running && !state.activeAudio && state.queue.length === 0;
}

function updateStatus(message, tone) {
  statusPill.textContent = message;
  statusPill.className = `status-pill ${tone}`;
}

function updateMediaSession({ title = "Story Teller", playbackState = "none" } = {}) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }

  if (typeof MediaMetadata === "function") {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: "Story Teller",
    });
  }

  navigator.mediaSession.playbackState = playbackState;
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
  preloadUpcomingAudio().catch(failSession);
  refreshStatusDetail();
}

function appendStoryEntry(segment, index) {
  const article = document.createElement("article");
  article.className = "story-entry";
  article.dataset.segmentId = String(segment.id);

  const heading = document.createElement("h2");
  heading.textContent = `Part ${index}`;

  const body = document.createElement("p");
  body.className = "story-body";

  const progressMeta = document.createElement("div");
  progressMeta.className = "story-progress-meta";

  const progressLabel = document.createElement("span");
  progressLabel.textContent = "Estimated narration progress: 0%";

  const progressBar = document.createElement("div");
  progressBar.className = "story-progress-bar";

  const progressFill = document.createElement("span");
  progressFill.className = "story-progress-fill";
  progressBar.append(progressFill);

  progressMeta.append(progressLabel);
  article.append(heading, body, progressMeta, progressBar);
  storyLog.append(article);
  state.renderedSegments.set(segment.id, {
    article,
    body,
    progressLabel,
    progressFill,
    story: segment.story,
  });
  renderSegmentProgress(segment.id, 0, false);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

function renderSegmentProgress(segmentId, ratio, isActive) {
  const rendered = state.renderedSegments.get(segmentId);

  if (!rendered) {
    return;
  }

  const clampedRatio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  rendered.body.textContent = rendered.story;
  rendered.article.classList.toggle("is-active", isActive);
  rendered.progressRatio = clampedRatio;
  rendered.progressFill.style.width = `${clampedRatio * 100}%`;
  rendered.progressLabel.textContent = `Estimated narration progress: ${Math.round(clampedRatio * 100)}%`;
}

function updatePlaybackProgress(segmentId, audio) {
  if (!audio?.duration || !Number.isFinite(audio.duration)) {
    return;
  }

  renderSegmentProgress(segmentId, audio.currentTime / audio.duration, true);
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
  state.currentPartIndex = storyIndex;
  updateSegmentCount();

  appendStoryEntry(nextSegment, storyIndex);
  state.audioPreparingPartIndex = storyIndex;
  refreshStatusDetail();
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
  state.textPreparingPartIndex = state.storyHistory.length + state.queue.length + 1;
  refreshStatusDetail();
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
      state.textPreparingPartIndex = null;

      if (state.isRunning && !state.isPaused) {
        updateStatus("Playing", "playing");
      }

      refreshStatusDetail();
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
    id: ++state.segmentIdCounter,
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

function cleanupActiveAudio(markComplete = false) {
  if (state.currentSegment?.id) {
    const rendered = state.renderedSegments.get(state.currentSegment.id);
    const lastRatio = rendered?.progressRatio || 0;
    renderSegmentProgress(state.currentSegment.id, markComplete ? 1 : lastRatio, false);
  }

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

function cleanupPreloadedAudio() {
  if (state.preloadedAudio?.audioUrl) {
    URL.revokeObjectURL(state.preloadedAudio.audioUrl);
  }

  state.preloadedAudio = null;
  state.preloadedAudioPromise = null;
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

async function createPreloadedAudioAsset(segment, sessionId) {
  const audioBlob = await requestSpeechAudio({
    apiKey: state.currentConfig.apiKey,
    voice: state.currentConfig.voice,
    languageTag: segment.languageTag,
    voiceStyle: state.currentConfig.voiceStyle,
    story: segment.story,
  });

  if (!state.isRunning || sessionId !== state.sessionId) {
    return null;
  }

  return {
    segmentId: segment.id,
    audioUrl: URL.createObjectURL(audioBlob),
  };
}

async function preloadUpcomingAudio() {
  const nextSegment = state.queue[0];

  if (!state.isRunning || !nextSegment) {
    return null;
  }

  if (state.preloadedAudio?.segmentId === nextSegment.id) {
    return state.preloadedAudio;
  }

  if (state.preloadedAudioPromise) {
    return state.preloadedAudioPromise;
  }

  if (state.preloadedAudio) {
    cleanupPreloadedAudio();
  }

  const sessionId = state.sessionId;
  state.audioPreparingPartIndex = state.storyHistory.length + 1;
  refreshStatusDetail();
  state.preloadedAudioPromise = createPreloadedAudioAsset(nextSegment, sessionId)
    .then((asset) => {
      if (!asset) {
        return null;
      }

      const isStillQueued = state.queue.some((segment) => segment.id === asset.segmentId);

      if (!isStillQueued) {
        URL.revokeObjectURL(asset.audioUrl);
        return null;
      }

      state.preloadedAudio = asset;
      return asset;
    })
    .finally(() => {
      state.preloadedAudioPromise = null;
      if (state.preloadedAudio?.segmentId === nextSegment.id || !state.queue.some((segment) => segment.id === nextSegment.id)) {
        state.audioPreparingPartIndex = null;
      }
      refreshStatusDetail();
    });

  return state.preloadedAudioPromise;
}

async function playSegmentAudio(segment, storyIndex) {
  const sessionId = state.sessionId;
  cleanupActiveAudio();
  let audioUrl = "";

  if (state.preloadedAudio?.segmentId === segment.id) {
    audioUrl = state.preloadedAudio.audioUrl;
    state.preloadedAudio = null;
  } else {
    const pendingPreload = state.preloadedAudioPromise;

    if (pendingPreload) {
      const pendingAsset = await pendingPreload;

      if (pendingAsset?.segmentId === segment.id) {
        audioUrl = pendingAsset.audioUrl;
        state.preloadedAudio = null;
      }
    }

    if (!audioUrl) {
      const preloadedAsset = await createPreloadedAudioAsset(segment, sessionId);

      if (!preloadedAsset) {
        return;
      }

      audioUrl = preloadedAsset.audioUrl;
    }
  }

  const audio = new Audio(audioUrl);
  audio.preload = "auto";
  audio.playsInline = true;

  state.activeAudio = audio;
  state.activeAudioUrl = audioUrl;
  state.isPaused = false;
  state.audioPreparingPartIndex = null;
  preloadUpcomingAudio().catch(failSession);
  refreshStatusDetail();

  audio.addEventListener("play", () => {
    if (state.activeAudio !== audio) {
      return;
    }

    updateStatus("Playing", "playing");
    state.currentPartIndex = storyIndex;
    refreshStatusDetail();
    updateMediaSession({
      title: `Part ${storyIndex}`,
      playbackState: "playing",
    });
    renderSegmentProgress(segment.id, 0, true);
    renderButtons();
  });

  audio.addEventListener("timeupdate", () => {
    if (state.activeAudio !== audio) {
      return;
    }

    updatePlaybackProgress(segment.id, audio);
    renderButtons();
  });

  audio.addEventListener("ended", () => {
    if (state.activeAudio !== audio) {
      return;
    }

    cleanupActiveAudio(true);
    updateMediaSession({
      title: `Part ${storyIndex}`,
      playbackState: "paused",
    });

    if (!state.isRunning) {
      updateStatus("Stopped", "idle");
      refreshStatusDetail();
      renderButtons();
      return;
    }

    state.currentPartIndex = null;
    refreshStatusDetail();
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
      refreshStatusDetail();
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
  state.textPreparingPartIndex = null;
  state.audioPreparingPartIndex = null;
  nowPlaying.textContent = message;
  showError(message);
}
