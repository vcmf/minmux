// The remote-host worker (a utilityProcess; docs/design/REMOTE_CONTROL.md): runs the server in
// remote/host-server.ts and relays main's messages to it.
import { createHostServer } from "./remote/host-server"
import type { ToHost } from "./remote/host-messages"

const server = createHostServer({ post: (m) => process.parentPort.postMessage(m) })
process.parentPort.on("message", (e) => server.handle(e.data as ToHost))
