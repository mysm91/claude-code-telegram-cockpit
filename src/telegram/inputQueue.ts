// Per-thread FIFO for inbound messages.
//
// grammY's built-in poller handles updates strictly sequentially and awaits each handler, so
// message ordering used to come for free — at the price of freezing the whole bot for the
// 20–120 s a voice transcription takes: no typed input, no /stop, no permission approval taps
// for that entire window. Once the message handlers are detached to fix that, the ordering has
// to be re-established explicitly, or a typed message can overtake a voice note sent before it.
//
// The key is a Telegram thread, not a session: the thread is the unit a person perceives as one
// conversation (in forum mode it IS the session), it resolves synchronously from the update, and
// it still works when nothing is bound yet — an answer to a /new directory prompt has no session
// to key on. Commands and callback queries are deliberately left unqueued; staying responsive
// while a transcription runs is the whole point.

export interface InputQueue {
  /** Is something already running or waiting on this thread? */
  busy(key: string): boolean;
  /** Append a job to this thread's chain. Returns the chain tail (tests await it; bot.ts does not). */
  run(key: string, job: () => Promise<void>, onError: (e: unknown) => void | Promise<void>): Promise<void>;
  /** How many threads have work outstanding. */
  size(): number;
}

export function createInputQueue(): InputQueue {
  const chains = new Map<string, Promise<void>>();
  return {
    busy: (key) => chains.has(key),
    size: () => chains.size,
    run(key, job, onError) {
      const prev = chains.get(key) ?? Promise.resolve();
      let next: Promise<void>;
      // .then(job, job) rather than .then(job): one failed job must not strand every later
      // message on the thread behind a rejected promise.
      next = prev.then(job, job).catch(onError).then(() => {
        // Drop the entry only if we are still the tail, so a later job's chain is never lost.
        if (chains.get(key) === next) chains.delete(key);
      });
      chains.set(key, next);
      return next;
    },
  };
}
