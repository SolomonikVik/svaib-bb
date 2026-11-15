import { z } from 'zod/v4';

// Shared UI must run under CSP without eval or runtime code generation.
z.config({ jitless: true });
