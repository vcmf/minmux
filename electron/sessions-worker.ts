// The sessions worker: a utility process that reads and searches past agent sessions (gigabytes
// of transcripts), so none of that work runs in main, which carries every terminal's output.
import { historyAgents } from "./agents/history-index"
import { SessionsOps, type SessionsRequest } from "./sessions-ops"
import { running } from "./session-search"

const ops = new SessionsOps(historyAgents(), (reply) => process.parentPort.postMessage(reply))

process.parentPort.on("message", (e) => ops.handle(e.data as SessionsRequest))

// Stopped (idle, stuck, the app quitting): an rg it started mustn't outlive it.
process.on("SIGTERM", () => {
  for (const child of running) child.kill()
  process.exit(0)
})
