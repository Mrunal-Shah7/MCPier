import { createInterface } from 'node:readline/promises';

/** Questions the import command asks; replaceable in tests. */
export interface Prompter {
  /** Yes/no question; an empty answer means `defaultYes`. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** Free text with a default that an empty answer keeps. */
  ask(question: string, defaultValue: string): Promise<string>;
}

/** Whether both standard input and output are a terminal, so questions can be asked. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function terminalPrompter(): Prompter {
  const ask = async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
  return {
    async confirm(question, defaultYes) {
      const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
      if (!answer) return defaultYes;
      return answer === 'y' || answer === 'yes';
    },
    async ask(question, defaultValue) {
      return (await ask(`${question} [${defaultValue}]: `)) || defaultValue;
    },
  };
}

/**
 * Reads a value without echoing it (raw mode). Ctrl+C aborts; Backspace edits. Used only
 * when standard input is a terminal.
 */
export function readHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Reads all of standard input (piped values). One trailing line break is removed. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}
