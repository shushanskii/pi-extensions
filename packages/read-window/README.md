# read-window

Blocks a read of a large file when no window was asked for, and names the commands that would find the lines.

```bash
pi install -l npm:@developer/read-window   # in the project that wants it
pi remove -l npm:@developer/read-window
```

The why — design, measurements, failure modes — is the header comment of [`index.ts`](./index.ts); it is kept there so that it travels with the code.
