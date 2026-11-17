# Morse

A web app for sending and receiving Morse code with a phone.

- **Receive by camera:** point it at a flashing light. Tap the light on screen to lock on, or let it watch the whole frame.
- **Receive by microphone:** listens for a beeping tone. It finds the pitch automatically, or you can set it by hand.
- **Send:** type or paste a message, then send it as beeps, screen flashes, or both. One tap on SOS repeats SOS until you stop it.

Decoding is live and copes with hand-keyed timing: uneven dots and dashes, stretched gaps, Farnsworth spacing and speed changes mid-message. Everything runs in the browser and nothing is uploaded.

## Hosting (GitHub Pages)

Camera and microphone access need HTTPS, which GitHub Pages provides.

1. In the repo, open **Settings > Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch (for example `main`) and the `/ (root)` folder, then save.
3. After a minute the app is at `https://dennisneville.github.io/morse/`.

On the phone, open that address in Chrome, then choose **menu > Add to Home screen**. It then opens full screen like an app and works offline.

## Tips

- **Camera:** works best at 12 WPM or slower, since most phone cameras capture 30 frames a second. Tap the light to lock on when other bright things are in view.
- **Screen sending:** turn screen brightness up first. A browser can't change it for you.
- **Microphone:** if other steady sounds are around, turn off auto tone and set the pitch to match the sender.
- **Testing:** you can test with one phone by receiving on the microphone while sending as sound.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout and styles |
| `app.js` | Camera, microphone, screen and sound handling, settings |
| `morse.js` | Morse table, encoder, signal detector and adaptive decoder (no browser APIs) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |

## Tests

```bash
npm test
```

Unit tests for the encoder and decoder: every character, 5 to 30 WPM, simulated hand keying, Farnsworth spacing, speed changes, and noisy detector input.

```bash
npm run e2e
```

End-to-end check in headless Chromium (needs Playwright). It generates a Morse WAV file and a flashing-light video, feeds them in as a fake microphone and camera, and checks the decoded text. It also decodes the screen sender's own flash timing as a loopback check.
