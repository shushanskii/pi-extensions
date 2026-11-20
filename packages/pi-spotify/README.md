# pi-spotify

Spotify as a tool the model can call: find and play a track, artist, album or playlist; pause, resume,
skip; set the volume; say what is playing and where. It remote-controls an official Spotify client — the
desktop app, the phone, a Connect speaker — through the Web API, so a Premium account is needed.

```bash
pi install npm:@shushanskii/pi-spotify
pi remove npm:@shushanskii/pi-spotify
```

Once: create an app at <https://developer.spotify.com/dashboard> with the redirect URI
`http://127.0.0.1:8898/callback` and the Web API ticked, put its Client ID into `~/.pi/agent/spotify.json`
(shape: [`spotify.json.example`](./spotify.json.example)), then run `/spotify login` in pi. `/spotify`
shows the config, the devices and what is playing.

The why — design, measurements, failure modes — is the header comment of [`index.ts`](./index.ts); it is
kept there so that it travels with the code.
