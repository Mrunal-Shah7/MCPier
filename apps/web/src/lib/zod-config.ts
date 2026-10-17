import { z } from 'zod';

// The dashboard validates with the shared zod schemas. zod's fast path compiles validators
// with `new Function`, and even its "is eval allowed?" probe is reported by the browser as
// a Content Security Policy violation (script-src has no 'unsafe-eval', on purpose).
// `jitless` keeps zod on its interpreter, so the policy stays strict and the console clean.
z.config({ jitless: true });
