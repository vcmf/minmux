// The remote-client worker (a utilityProcess; docs/design/REMOTE_CONTROL.md, "minmux on another
// machine"): finds the user's other minmux on the tailnet and relays their panes to main.
import { createPeerClient } from "./remote/peer-client"
import type { ToClient } from "./remote/client-messages"
import { cliCandidates, findCli, probePorts, runCli, tailnetReader } from "./remote/tailscale"

const client = createPeerClient({
  post: (m) => process.parentPort.postMessage(m),
  ports: probePorts(process.env.MINMUX_REMOTE_PORTS),
  ownPort: 0, // main says which (and again when Settings change it)
  tailnet: tailnetReader(
    () => findCli(cliCandidates(process.platform, process.env.PATH ?? "", process.env)),
    runCli,
  ),
})
process.parentPort.on("message", (e) => client.handle(e.data as ToClient))
