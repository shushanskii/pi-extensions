# pi-speak

One spoken sentence at the end of a turn, in Russian.

```bash
pi install npm:@shushanskii/pi-speak
pi remove npm:@shushanskii/pi-speak
```

Config: `~/.pi/agent/tts.json`, every key optional — the defaults are the working values. Shape: [`tts.json.example`](./tts.json.example).

The why — design, measurements, failure modes — is the header comment of [`index.ts`](./index.ts); it is kept there so that it travels with the code.
