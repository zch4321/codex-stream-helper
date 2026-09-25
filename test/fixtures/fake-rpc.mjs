import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let initialized = false;
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialized') { initialized = true; return; }
  const result = request.method === 'initialize' ? { userAgent: 'test-runtime' } : { thread: { id: request.params.threadId, turns: [], initialized } };
  const output = JSON.stringify({ id: request.id, result });
  // Split a JSON response across transport chunks to exercise line framing.
  process.stdout.write('unrelated startup line\n');
  process.stdout.write(output.slice(0, 8));
  setTimeout(() => process.stdout.write(output.slice(8) + '\n'), 5);
});
