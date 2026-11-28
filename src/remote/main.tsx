import ReactDOM from "react-dom/client"
import "@fontsource/geist/400.css"
import "@fontsource/geist/500.css"
import "@fontsource/geist/600.css"
import "@fontsource/geist-mono/400.css"
import "@fontsource/geist-mono/500.css"
import "@fontsource/geist-mono/600.css"
import { RemoteApp } from "./remote-app"
import "./remote.css"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<RemoteApp />)
