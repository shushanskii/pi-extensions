# pi-image

The lab's qwen-image as a tool the model can call: draw from a prompt, edit a picture by
reference (`image`), or repaint inside a mask (`initImage`, `mask`, `strength`).

```bash
pi install npm:@shushanskii/pi-image
pi remove npm:@shushanskii/pi-image
```

Config: `~/.pi/agent/image.json`, every key optional — the defaults are the working values. Shape: [`image.json.example`](./image.json.example).

The why — design, measurements, failure modes — is the header comment of [`index.ts`](./index.ts); it is kept there so that it travels with the code.

## Not settled: how large a request may be

The box answers until it does not, and nobody has measured where that line is. Every row
below is one call on the halogen container, with the engine holding 62 GiB beside it:

| output    | references | result                                         |
| --------- | ---------- | ---------------------------------------------- |
| 512x672   | 1          | 56 s                                           |
| 736x416   | 1          | 44 s                                           |
| 1024x1024 | 1          | 200 s                                          |
| 1024x576  | 2          | 131 s                                          |
| 1920x1088 | 2          | 502 — llama-swap OOM-killed at a 12.7 GiB peak |

A reference is resized to the output area, so what a call costs is that area times the
pictures in it. The guidance the tool gives — one reference at or below 1024x1024, two
near 1024x576 — is **the largest configuration measured to survive, not a ceiling**. The
boundary between it and the row that killed the gateway is unmeasured, so a request in
between may either finish or take the server down with it; when that happens the call in
flight answers 502 with an empty body and the retry seconds later answers 503.

How many references is a separate question and also open. The model is documented for up
to 10, `sd-server` imposes no limit of its own — it accepts whatever list arrives — and
nothing past two has been tried on this box, so whether 10 fits in memory here is unknown.

Every row above was measured on `qwen-image`. The default model is now `qwen-image-turbo`,
whose weights are a larger quantization over the same encoder, so its own budget is
unmeasured too — the turbo may survive more than the table shows, or less.
