# pi-image

The lab's qwen-image as a tool the model can call.

```bash
pi install npm:@shushanskii/pi-image
pi remove npm:@shushanskii/pi-image
```

Config: `~/.pi/agent/image.json`, every key optional — the defaults are the working values. Shape: [`image.json.example`](./image.json.example).

The why — design, measurements, failure modes — is the header comment of [`index.ts`](./index.ts); it is kept there so that it travels with the code.
