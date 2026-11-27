import ReactDOM from "react-dom/client"
import "@fontsource/geist-mono/400.css"
import "@fontsource/geist-mono/600.css"
import { RemoteApp } from "./remote-app"
import "./remote.css"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<RemoteApp />)
