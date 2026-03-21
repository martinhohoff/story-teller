# Story Teller

Mobile-friendly web app that generates and reads an endless story aloud.

## Run

```bash
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

## How it works

- You enter your OpenAI API key and a story premise.
- The app generates the first segment of the story.
- It converts that segment to speech with OpenAI TTS.
- While the current segment is playing, it prepares the next one so the story can continue.

## Language behavior

- Portuguese prompts default to Brazilian Portuguese (`pt-BR`).
- You can force another language tag manually, such as `en-US`, `es-ES`, or `fr-FR`.
- If the language field is empty, the app tries to infer the language from the prompt.

## Important note

This version is browser-only and sends requests directly from the page to the OpenAI API. That is convenient for personal use and quick testing, but it is not the safest setup for a public app. If you want to publish it, the next step should be moving the OpenAI requests behind your own backend.
